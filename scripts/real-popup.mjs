// The real toolbar popup of the loaded extension, opened, read and photographed in a Chrome that
// a script launched with a remote debugging port.
//
// chrome.action.openPopup() needs a user gesture, which Playwright's evaluate cannot give, and
// Playwright cannot reach an extension popup target; so the popup goes through the raw CDP
// transport of console-capture.mjs. The popup reports the active tab of its window: the page
// under test has to be the active tab when capture() runs.
import fs from 'node:fs/promises';
import { connectToChrome } from './console-capture.mjs';

const POPUP_TARGET_WAIT_MS = 10000;
const WORKER_WAKE_WAIT_MS = 6000;
const POLL_MS = 500;
// The popup's first summary read lands within this long after its body is ready.
const FIRST_READ_SETTLE_MS = 900;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs inside the popup target. The selectors are the popup's own (popup.html, popup-view.js).
function popupReadout() {
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
  return {
    ready: document.body?.dataset?.ready ?? null,
    takeover: text('[data-live-takeover]'),
    headline: text('.cdn-headline'),
    subline: text('.cdn-subline'),
    lines: [...document.querySelectorAll('.cdn-line')].map((line) => ({
      name: line.querySelector('.cdn-name')?.textContent?.trim() ?? null,
      status: line.querySelector('.cdn-status')?.textContent?.trim() ?? null,
      tone: line.dataset.tone ?? null,
    })),
    error: text('[data-status-field="error"]'),
  };
}

function popupGeometry() {
  return {
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    devicePixelRatio: window.devicePixelRatio,
  };
}

async function findTarget(transport, predicate) {
  const { targetInfos } = await transport.send('Target.getTargets');
  return targetInfos.find(predicate);
}

async function evaluateOnSession(transport, sessionId, expression, { userGesture = false } = {}) {
  const result = await transport.send('Runtime.evaluate', {
    expression,
    userGesture,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  if (result.exceptionDetails !== undefined) {
    throw new Error(`evaluate threw: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
  }
  return result.result.value;
}

async function evaluateOnTarget(transport, targetId, expression, options) {
  const { sessionId } = await transport.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    return await evaluateOnSession(transport, sessionId, expression, options);
  } finally {
    await transport.send('Target.detachFromTarget', { sessionId });
  }
}

async function closeTarget(transport, targetId) {
  try {
    await transport.send('Target.closeTarget', { targetId });
  } catch (error) {
    if (!String(error.message).includes('No target with given id found')) throw error;
  }
}

export async function connectRealPopup({ cdpPort, extensionId }) {
  const transport = await connectToChrome(cdpPort);
  const extensionPrefix = `chrome-extension://${extensionId}/`;
  const findWorker = () => findTarget(transport, (candidate) => candidate.type === 'service_worker'
    && candidate.url.startsWith(extensionPrefix));
  const findPopup = () => findTarget(transport, (candidate) => candidate.url.startsWith(`${extensionPrefix}popup.html`));
  // The MV3 service worker idles away within seconds; a runtime message from an extension page
  // wakes it. The waker page sits in a background tab, so it never takes the active tab.
  const { targetId: wakerTargetId } = await transport.send('Target.createTarget', {
    url: `${extensionPrefix}logs.html`,
    background: true,
  });

  async function awakeWorker() {
    const awake = await findWorker();
    if (awake !== undefined) return awake;
    await evaluateOnTarget(transport, wakerTargetId, 'chrome.runtime.sendMessage({ version: 1, type: "logs:max-event-id" }).then(() => true)');
    const wakeDeadline = Date.now() + WORKER_WAKE_WAIT_MS;
    while (Date.now() < wakeDeadline) {
      await sleep(250);
      const woken = await findWorker();
      if (woken !== undefined) return woken;
    }
    throw new Error('extension service worker did not wake');
  }

  async function openPopup() {
    const stale = await findPopup();
    if (stale !== undefined) await closeTarget(transport, stale.targetId);
    const worker = await awakeWorker();
    await evaluateOnTarget(transport, worker.targetId, 'chrome.action.openPopup()', { userGesture: true });
    const popupDeadline = Date.now() + POPUP_TARGET_WAIT_MS;
    while (Date.now() < popupDeadline) {
      const popup = await findPopup();
      if (popup !== undefined) return popup;
      await sleep(250);
    }
    throw new Error('popup target not found after chrome.action.openPopup()');
  }

  // Opens the popup and reads it every POLL_MS until until(readout) holds or timeoutMs has passed,
  // then photographs the whole popup document to screenshotPath and closes the popup. Returns
  // { matched, readout, geometry, takenAt }; matched false means the timeout ended the wait.
  async function capture({ until, timeoutMs, screenshotPath }) {
    const popup = await openPopup();
    const { sessionId } = await transport.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
    try {
      await transport.send('Runtime.enable', {}, sessionId);
      const read = () => evaluateOnSession(transport, sessionId, `(${popupReadout.toString()})()`);
      const readyDeadline = Date.now() + POPUP_TARGET_WAIT_MS;
      while ((await read()).ready !== 'true') {
        if (Date.now() >= readyDeadline) throw new Error('popup body never became ready');
        await sleep(POLL_MS);
      }
      await sleep(FIRST_READ_SETTLE_MS);
      const deadline = Date.now() + timeoutMs;
      let readout = await read();
      let matched = until(readout);
      while (!matched && Date.now() < deadline) {
        await sleep(POLL_MS);
        readout = await read();
        matched = until(readout);
      }
      const takenAt = new Date().toISOString();
      const geometry = await evaluateOnSession(transport, sessionId, `(${popupGeometry.toString()})()`);
      const shot = await transport.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: geometry.scrollWidth, height: geometry.scrollHeight, scale: 1 },
      }, sessionId);
      await fs.writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
      return { matched, readout, geometry, takenAt };
    } finally {
      await transport.send('Target.detachFromTarget', { sessionId });
      await closeTarget(transport, popup.targetId);
    }
  }

  async function close() {
    await closeTarget(transport, wakerTargetId);
    await transport.close();
  }

  return { capture, close };
}
