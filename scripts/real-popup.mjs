// The real toolbar popup of the loaded extension, opened, read and photographed in a Chrome that
// a script launched with a remote debugging port. capture-store-images.mjs and
// live-backup-run.mjs both drive the popup through this module; each checks what it returns in
// its own layer.
//
// chrome.action.openPopup() needs a user gesture, which Playwright's evaluate cannot give, and
// Playwright cannot reach an extension popup target; so the popup goes through the raw CDP
// transport of console-capture.mjs. The popup reports the active tab of its window: the page
// under test has to be the active tab while the popup is open.
//
// connectRealPopup() returns { wakerUrl, withPopup, capture, close }:
//   wakerUrl   the URL of the waker page, the page that wakes the extension's service worker.
//   withPopup  withPopup(run) opens the popup, waits for its body and its first read, calls
//              run(view) and closes the popup. view reads the popup (readout, geometry),
//              photographs it (screenshot) and sets its colour scheme (emulateColorScheme).
//   capture    a withPopup that reads until a condition holds and then photographs.
// The readout field names are an interface: the report of capture-store-images carries them,
// and store/images/src/compose.mjs reads readout.liveTakeover from it.
import fs from 'node:fs/promises';
import { connectToChrome } from './console-capture.mjs';

const WAKER_TARGET_WAIT_MS = 5000;
const WORKER_WAKE_WAIT_MS = 6000;
const POPUP_TARGET_WAIT_MS = 10000;
const TARGET_POLL_MS = 250;
const POLL_MS = 500;
// The popup's first summary read lands within this long after its body is ready.
const FIRST_READ_SETTLE_MS = 900;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs inside the popup target. The selectors are the popup's own data attributes and classes
// (popup.html, popup-view.js), never Bilibili's. A text field is null when its element is missing.
// Exported for test/popup-unit.test.mjs, which runs it on the popup's own rendered document.
export function popupReadout() {
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
  const switches = [...document.querySelectorAll('.switches .switch-row')].map((row) => ({
    label: row.querySelector('span')?.textContent?.trim() ?? null,
    preference: row.querySelector('input')?.dataset.preference ?? null,
    checked: row.querySelector('input')?.checked ?? null,
  }));
  const lines = [...document.querySelectorAll('.cdn-line')].map((line) => ({
    name: line.querySelector('.cdn-name')?.textContent?.trim() ?? null,
    status: line.querySelector('.cdn-status')?.textContent?.trim() ?? null,
    tone: line.dataset.tone ?? null,
    statusColor: getComputedStyle(line.querySelector('.cdn-status')).color,
  }));
  return {
    title: text('h1'),
    switches,
    bufferSeconds: text('[data-buffer-seconds]'),
    bufferGoal: text('[data-buffer-goal]'),
    bufferFillWidth: document.querySelector('[data-buffer-fill]')?.style?.width ?? null,
    bufferNote: text('[data-buffer-note]'),
    targetLabel: text('[data-buffer-target-label]'),
    targetValue: text('[data-target-value]'),
    stateLineHidden: document.querySelector('[data-status-field="state"]')?.hidden ?? null,
    livePanelHidden: document.querySelector('[data-live-panel]')?.hidden ?? null,
    liveTakeover: text('[data-live-takeover]'),
    errorLine: text('[data-status-field="error"]'),
    notice: text('[data-notice]'),
    bodyReady: document.body?.dataset?.ready ?? null,
    downloadHeadline: text('.cdn-headline'),
    downloadSubline: text('.cdn-subline'),
    lines,
  };
}

// Runs inside the popup target. The document's size, the popup viewport's size and the box of the
// footer log link (linkRect, null when the link is missing): a popup window clamped by the screen
// edge paints less than its document, and the footer is the part that goes missing first.
function popupGeometry() {
  const link = document.querySelector('[data-open-logs]');
  return {
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    linkRect: link?.getBoundingClientRect()?.toJSON() ?? null,
  };
}

async function findTarget(transport, predicate) {
  const { targetInfos } = await transport.send('Target.getTargets');
  return targetInfos.find(predicate);
}

async function waitForTarget(find, waitMs, missingMessage) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const target = await find();
    if (target !== undefined) return target;
    await sleep(TARGET_POLL_MS);
  }
  throw new Error(missingMessage);
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
  const waker = await waitForTarget(
    () => findTarget(transport, (candidate) => candidate.targetId === wakerTargetId),
    WAKER_TARGET_WAIT_MS,
    'waker page target not found',
  );

  async function awakeWorker() {
    const awake = await findWorker();
    if (awake !== undefined) return awake;
    await evaluateOnTarget(transport, wakerTargetId, 'chrome.runtime.sendMessage({ version: 1, type: "logs:max-event-id" }).then(() => true)');
    return waitForTarget(findWorker, WORKER_WAKE_WAIT_MS, 'extension service worker did not wake');
  }

  async function openPopup() {
    const stale = await findPopup();
    if (stale !== undefined) await closeTarget(transport, stale.targetId);
    const worker = await awakeWorker();
    await evaluateOnTarget(transport, worker.targetId, 'chrome.action.openPopup()', { userGesture: true });
    return waitForTarget(findPopup, POPUP_TARGET_WAIT_MS, 'popup target not found after chrome.action.openPopup()');
  }

  // Opens the popup, waits until its body is ready and its first summary read has landed, calls
  // run(view) and closes the popup, also when run throws. Returns what run returns.
  // view.screenshot(path, geometry) writes the document area that geometry measures: the caller
  // reads view.geometry() first and checks it, since the screenshot does not.
  async function withPopup(run) {
    const popup = await openPopup();
    const { sessionId } = await transport.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
    try {
      await transport.send('Runtime.enable', {}, sessionId);
      const evaluate = (fn) => evaluateOnSession(transport, sessionId, `(${fn.toString()})()`);
      const view = {
        readout: () => evaluate(popupReadout),
        geometry: () => evaluate(popupGeometry),
        screenshot: async (screenshotPath, geometry) => {
          const shot = await transport.send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: 0, y: 0, width: geometry.scrollWidth, height: geometry.scrollHeight, scale: 1 },
          }, sessionId);
          await fs.writeFile(screenshotPath, Buffer.from(shot.data, 'base64'));
        },
        emulateColorScheme: (scheme) => transport.send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: scheme }],
        }, sessionId),
      };
      const readyDeadline = Date.now() + POPUP_TARGET_WAIT_MS;
      while ((await view.readout()).bodyReady !== 'true') {
        if (Date.now() >= readyDeadline) throw new Error('popup body never became ready');
        await sleep(POLL_MS);
      }
      await sleep(FIRST_READ_SETTLE_MS);
      return await run(view);
    } finally {
      await transport.send('Target.detachFromTarget', { sessionId });
      await closeTarget(transport, popup.targetId);
    }
  }

  // Opens the popup and reads it every POLL_MS until until(readout) holds or timeoutMs has passed,
  // then photographs the whole popup document to screenshotPath and closes the popup. Returns
  // { matched, readout, geometry, takenAt }; matched false means the timeout ended the wait.
  function capture({ until, timeoutMs, screenshotPath }) {
    return withPopup(async (view) => {
      const deadline = Date.now() + timeoutMs;
      let readout = await view.readout();
      let matched = until(readout);
      while (!matched && Date.now() < deadline) {
        await sleep(POLL_MS);
        readout = await view.readout();
        matched = until(readout);
      }
      const takenAt = new Date().toISOString();
      const geometry = await view.geometry();
      await view.screenshot(screenshotPath, geometry);
      return { matched, readout, geometry, takenAt };
    });
  }

  async function close() {
    await closeTarget(transport, wakerTargetId);
    await transport.close();
  }

  return { wakerUrl: waker.url, withPopup, capture, close };
}
