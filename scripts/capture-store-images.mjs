// Store-image capture driver: one command that recaptures the raw store-image inputs
// (store-images-raw/, gitignored: page captures contain third-party content) from the real
// extension running against real Bilibili pages, plus a report.json with provenance.
//
//   npm run build && npm run capture:store-images        (Windows, system Chrome)
//   BILIBILI_E2E_CHROME=<chrome.exe> node scripts/capture-store-images.mjs
//
// Inputs: the built extension in dist/extension/. Outputs in store-images-raw/:
//   video-popup-light.png / video-popup-dark.png / video-page.png
//   live-popup-light.png  / live-popup-dark.png  / live-page.png
//   report.json (commit, buildId, Chrome version, video id, room id, live format FLV/HLS,
//                the light and dark popup readouts, console errors, event counts)
//
// Process rules (skill smooth-bilibili-plugin, they are not negotiable):
//   - Chrome is spawned by this script with its own temp --user-data-dir and ended by PID:
//     browser.close() + child.kill(), then a backstop sweep that force-kills only chrome.exe
//     processes whose command line names this run's own temp profile. Never by image name.
//   - Hard ceilings on opened tabs and popup opens; the run fails loudly when one is exceeded.
//   - The player is never touched through its skin: playback is started on the media element
//     itself (video.play()), quality menus are never opened, and no whole-run auto-retry exists.
//   - A required readout that never appears fails the run; the popup is never captured empty.
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { findAvailablePort, parseHeadedFlag } from './browser-runtime.mjs';
import { readStoredEvents } from './extension-log-pull.mjs';
import { installUnpackedExtension } from './install-unpacked-extension.mjs';
import { assertInkPainted, decodePngFile } from './png-pixels.mjs';
import { readProvenance } from './provenance.mjs';

const execFileAsync = promisify(execFile);

const root = process.cwd();
const extensionDirectory = path.join(root, 'dist', 'extension');
const outDir = path.join(root, 'store-images-raw');
await fs.mkdir(outDir, { recursive: true });

// cmd.exe's `set VAR=value && next` keeps the space before && in the value; trim it.
const headed = parseHeadedFlag();
const chromeExecutablePath = process.env.BILIBILI_E2E_CHROME?.trim();
if (chromeExecutablePath === undefined || chromeExecutablePath.length === 0) {
  throw new Error('set BILIBILI_E2E_CHROME to the Chrome executable; no silent fallback');
}

const VIDEO_URL = process.env.BILIBILI_STORE_VIDEO_URL ?? 'https://www.bilibili.com/video/BV1esa36qEbN/';
const LIVE_URL = process.env.BILIBILI_STORE_LIVE_URL ?? 'https://live.bilibili.com/6';
const BUFFER_TARGET_SECONDS = 120;

// Tabs opened through context.newPage() across the whole run: video page, live page, and the
// per-scenario log pulls. The run fails when the ceiling is exceeded.
const MAX_TAB_OPENS = 8;
// Popup opens per scenario: the poll loop opens the popup about once per 15 s of waiting.
const MAX_POPUP_OPENS_PER_SCENARIO = 30;

const RACING_STATUS_TEXT = '正在按两条线路竞速下载';

const muteGuardInit = `(() => {
  const silence = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    try { element.muted = true; element.volume = 0; } catch (error) { console.error('[BilibiliBuffer] mute guard failed', error); }
  };
  const scan = (rootNode) => {
    silence(rootNode);
    if (typeof rootNode.querySelectorAll !== 'function') return;
    for (const element of rootNode.querySelectorAll('video,audio')) silence(element);
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) scan(node);
  }).observe(document, { childList: true, subtree: true });
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) { silence(this); return originalPlay.apply(this, args); };
  scan(document);
})()`;

// Read the popup DOM. Runs inside the popup target; selectors are the popup's own
// data attributes and classes (popup.html / popup-view.js), never Bilibili's.
function popupReadout() {
  const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
  const switches = [...document.querySelectorAll('.switches .switch-row')].map((row) => ({
    label: row.querySelector('span')?.textContent?.trim() ?? null,
    preference: row.querySelector('input')?.dataset.preference ?? null,
    checked: row.querySelector('input')?.checked ?? null,
  }));
  const lines = [...document.querySelectorAll('.cdn-line')].map((line) => ({
    name: line.querySelector('.cdn-name')?.textContent?.trim() ?? null,
    health: line.querySelector('.cdn-health')?.textContent?.trim() ?? null,
    tone: line.dataset.tone ?? null,
    connection: line.querySelector('.cdn-conn')?.textContent?.trim() ?? null,
    healthColor: getComputedStyle(line.querySelector('.cdn-health')).color,
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
    lines,
  };
}

// Layout facts for the capture self-check, read in the popup target. The footer link is
// the element the 63950b9 captures silently dropped, so its rect is recorded in
// report.json and verified against the written PNG's pixels.
function popupGeometry() {
  const link = document.querySelector('[data-open-logs]');
  const rect = link?.getBoundingClientRect()?.toJSON() ?? null;
  return {
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientWidth: document.documentElement.clientWidth,
    clientHeight: document.documentElement.clientHeight,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    linkRect: rect,
  };
}

function log(...parts) { console.log(new Date().toISOString(), ...parts); }

async function writeCapture(name, buffer) {
  const target = path.join(outDir, name);
  await fs.writeFile(target, buffer);
  log('wrote', target);
  return target;
}

// PNG header read: the popup close-up must be the popup document at 2x device pixels,
// never a stray empty image.
async function pngSize(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!header.subarray(0, 8).equals(signature)) throw new Error(`${file} is not a PNG`);
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

// ---- minimal raw CDP client over the browser endpoint ----------------------
// Playwright cannot route messages to service workers or screenshot an extension popup
// target (newCDPSession accepts only Page/Frame), so worker evaluation, popup reads and
// popup screenshots go through raw CDP.

class RawCdp {
  constructor(port) {
    this.port = port;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    const version = await (await fetch(`http://127.0.0.1:${this.port}/json/version`)).json();
    this.socket = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('raw cdp connect failed')), { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error !== undefined) entry.reject(new Error(`${message.error.message} (${message.error.code})`));
        else entry.resolve(message.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  async attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async detach(sessionId) {
    try { await this.send('Target.detachFromTarget', { sessionId }); } catch (error) { /* already gone */ }
  }

  close() { try { this.socket.close(); } catch (error) { /* socket already gone */ } }
}

async function findTarget(raw, predicate) {
  const { targetInfos } = await raw.send('Target.getTargets');
  return targetInfos.find(predicate) ?? null;
}

async function evaluateOnTarget(raw, target, expression, { userGesture = false, awaitPromise = true } = {}) {
  const sessionId = await raw.attach(target.targetId);
  try {
    const result = await raw.send('Runtime.evaluate', { expression, userGesture, awaitPromise, returnByValue: true }, sessionId);
    if (result?.exceptionDetails !== undefined) {
      throw new Error(`evaluate threw on ${target.type}: ${JSON.stringify(result.exceptionDetails).slice(0, 400)}`);
    }
    return result.result?.value;
  } finally {
    await raw.detach(sessionId);
  }
}

// ---- popup handling --------------------------------------------------------

function extensionWorkerTarget(raw, extensionId) {
  const prefix = `chrome-extension://${extensionId}/`;
  return findTarget(raw, (candidate) => candidate.type === 'service_worker' && candidate.url.startsWith(prefix));
}

function popupTarget(raw, extensionId) {
  return findTarget(raw, (candidate) => candidate.url.startsWith(`chrome-extension://${extensionId}/popup.html`));
}

async function closePopupTarget(raw, extensionId) {
  const target = await popupTarget(raw, extensionId);
  if (target === null) return;
  try {
    await raw.send('Target.closeTarget', { targetId: target.targetId });
  } catch (error) {
    if (!String(error).includes('No target with given id found')) throw error;
  }
}

// The MV3 service worker idles away within seconds; any runtime message from an extension
// page wakes it. The waker page (logs.html in a background tab, opened once per run) exists
// for the whole run.
async function wakeExtensionWorker(raw, extensionId, wakerTarget) {
  const worker = await extensionWorkerTarget(raw, extensionId);
  if (worker !== null) return worker;
  await evaluateOnTarget(raw, wakerTarget, 'chrome.runtime.sendMessage({version:1,type:"logs:max-event-id"}, () => {})', { awaitPromise: false });
  for (let attempt = 0; attempt < 24; attempt += 1) {
    await sleep(250);
    const woken = await extensionWorkerTarget(raw, extensionId);
    if (woken !== null) return woken;
  }
  throw new Error('extension service worker did not wake');
}

// Opens the real popup (chrome.action.openPopup() on the service worker) and runs `run`
// with an attached raw CDP session, then closes it. Counts every open against the ceiling.
async function withPopup(raw, extensionId, wakerTarget, scenarioBudget, run) {
  scenarioBudget.popupOpens += 1;
  if (scenarioBudget.popupOpens > MAX_POPUP_OPENS_PER_SCENARIO) {
    throw new Error(`popup open ceiling exceeded (${MAX_POPUP_OPENS_PER_SCENARIO} opens in one scenario)`);
  }
  await closePopupTarget(raw, extensionId);
  const worker = await wakeExtensionWorker(raw, extensionId, wakerTarget);
  await evaluateOnTarget(raw, worker, 'chrome.action.openPopup()', { userGesture: true });
  let target = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    target = await popupTarget(raw, extensionId);
    if (target !== null) break;
    await sleep(250);
  }
  if (target === null) throw new Error('popup target not found after chrome.action.openPopup()');
  const sessionId = await raw.attach(target.targetId);
  try {
    await raw.send('Runtime.enable', {}, sessionId);
    await raw.send('Runtime.evaluate', {
      expression: 'new Promise((resolve) => { const check = () => document.body?.dataset?.ready === "true" ? resolve() : setTimeout(check, 200); check(); })',
      awaitPromise: true,
    }, sessionId);
    await sleep(900);
    return await run({ raw, sessionId });
  } finally {
    await raw.detach(sessionId);
    await closePopupTarget(raw, extensionId);
  }
}

// Captures the whole popup document, then proves on the written PNG that the footer log
// link actually carries ink. The clip alone proves nothing: the capture clips the
// document's scrollWidth x scrollHeight, and when the popup window's viewport is smaller
// than its document, the strip below the viewport is never painted - Page.captureScreenshot
// returns it as flat background (the 63950b9 video popup shipped exactly that, with the
// link region blank). Chrome renders nothing beyond a popup's surface: measured on Chrome
// 154, captureBeyondViewport is ignored on the popup target, Emulation.setDeviceMetricsOverride
// is rejected ("Target does not support metrics override") and the popup has no
// Browser window handle to resize. The painted area IS the popup viewport, so the run
// only continues when the whole document, footer link included, lies inside the viewport;
// the ink check on the written image is the final evidence.
async function popupScreenshot({ raw, sessionId }, target) {
  const geometry = await popupEvaluate({ raw, sessionId }, popupGeometry);
  const { w, h } = { w: geometry.scrollWidth, h: geometry.scrollHeight };
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 300 || h < 300) {
    throw new Error(`popup document has no real size (${w}x${h}); refusing to capture an empty popup`);
  }
  if (geometry.linkRect === null || geometry.linkRect.width <= 0 || geometry.linkRect.height <= 0) {
    throw new Error(`popup footer log link has no box: ${JSON.stringify(geometry.linkRect)}; the footer is missing from the document`);
  }
  if (geometry.linkRect.bottom > h + 0.5 || geometry.linkRect.top < -0.5) {
    throw new Error(`popup footer log link lies outside the document: link ${JSON.stringify(geometry.linkRect)}, document height ${h}`);
  }
  if (geometry.clientWidth < w || geometry.clientHeight < h) {
    throw new Error(
      `the popup viewport (${geometry.clientWidth}x${geometry.clientHeight}) is smaller than`
      + ` the document (${w}x${h}); the strip below the viewport would be captured unpainted`
      + ` (inner ${geometry.innerWidth}x${geometry.innerHeight}, devicePixelRatio ${geometry.devicePixelRatio}).`
      + ' The popup window is clamped by the screen edge: move the browser window up or free screen space,'
      + ' never ship the clipped capture',
    );
  }
  if (geometry.linkRect.bottom > geometry.clientHeight + 0.5) {
    throw new Error(`the footer log link (${JSON.stringify(geometry.linkRect)}) sits below the popup viewport (${geometry.clientHeight}); it would be captured unpainted`);
  }
  const capture = await raw.send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
  }, sessionId);
  const buffer = Buffer.from(capture.data, 'base64');
  const written = await writeCapture(target, buffer);
  const size = await pngSize(written);
  // --force-device-scale-factor=2 makes the close-up 2x the popup document size.
  if (size.width !== w * 2 || size.height !== h * 2) {
    throw new Error(`popup capture ${written} is ${size.width}x${size.height}, expected 2x device pixels of the ${w}x${h} document`);
  }
  const scale = size.width / w;
  const ink = assertInkPainted({ png: await decodePngFile(written), rect: geometry.linkRect, scale });
  log('ink check', path.basename(target), JSON.stringify({ linkRect: geometry.linkRect, ...ink }));
  return { path: written, ...size, geometry, ink };
}

async function popupEvaluate({ raw, sessionId }, fn) {
  const { result, exceptionDetails } = await raw.send('Runtime.evaluate', {
    expression: `(${fn.toString()})()`,
    returnByValue: true,
    awaitPromise: true,
  }, sessionId);
  if (exceptionDetails !== undefined) throw new Error(`raw evaluate failed: ${JSON.stringify(exceptionDetails).slice(0, 300)}`);
  return result.value;
}

async function popupEmulateColorScheme({ raw, sessionId }, scheme) {
  await raw.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: scheme }],
  }, sessionId);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- scenarios ------------------------------------------------------------

function assertRealReadout(label, readout, { racing }) {
  if (readout.bodyReady !== 'true') throw new Error(`${label}: popup body never became ready`);
  if (readout.errorLine !== null && readout.errorLine !== '') {
    throw new Error(`${label}: popup shows an error line: ${readout.errorLine}`);
  }
  const connections = readout.lines.map((line) => line.connection ?? '');
  if (readout.lines.length < 2 || connections.some((connection) => connection === '' || connection === '还没有连接记录')) {
    throw new Error(`${label}: line cards do not show two connections: ${JSON.stringify(readout.lines)}`);
  }
  const seconds = Number.parseInt(readout.bufferSeconds ?? '', 10);
  if (racing) {
    if (readout.liveTakeover !== RACING_STATUS_TEXT) {
      throw new Error(`${label}: live takeover status is ${JSON.stringify(readout.liveTakeover)}, expected ${RACING_STATUS_TEXT}`);
    }
    return;
  }
  if (!Number.isFinite(seconds) || seconds < BUFFER_TARGET_SECONDS) {
    throw new Error(`${label}: buffer readout is ${JSON.stringify(readout.bufferSeconds)}, expected at least ${BUFFER_TARGET_SECONDS} seconds`);
  }
}

async function captureScenario({
  raw,
  extensionId,
  wakerTarget,
  label,
  page,
  budget,
  racing,
  maxWaitMs,
}) {
  const startedAt = Date.now();
  let lastReadout = null;
  let reached = false;
  while (Date.now() - startedAt < maxWaitMs) {
    const elapsed = Math.round((Date.now() - startedAt) / 1000);
    try {
      lastReadout = await withPopup(raw, extensionId, wakerTarget, budget, (popup) => popupEvaluate(popup, popupReadout));
      log(`[${label}] +${elapsed}s popup`, JSON.stringify(lastReadout));
      assertRealReadout(label, lastReadout, { racing });
      reached = true;
      break;
    } catch (error) {
      log(`[${label}] +${elapsed}s readout not ready:`, String(error).slice(0, 300));
    }
    await sleep(15000);
  }
  if (!reached) {
    throw new Error(`${label}: required readout never appeared within ${Math.round(maxWaitMs / 1000)}s; last readout: ${JSON.stringify(lastReadout)}`);
  }

  const capture = await withPopup(raw, extensionId, wakerTarget, budget, async (popup) => {
    const readout = await popupEvaluate(popup, popupReadout);
    assertRealReadout(label, readout, { racing });
    const light = await popupScreenshot(popup, `${label}-popup-light.png`);
    await popupEmulateColorScheme(popup, 'dark');
    await sleep(400);
    const darkReadout = await popupEvaluate(popup, popupReadout);
    const dark = await popupScreenshot(popup, `${label}-popup-dark.png`);
    await popupEmulateColorScheme(popup, 'light');
    return { readout, darkReadout, light, dark };
  });
  const pagePath = await writeCapture(`${label}-page.png`, await page.screenshot({ type: 'png' }));
  const pageSize = await pngSize(pagePath);
  if (pageSize.width !== 1280 || pageSize.height !== 800) {
    throw new Error(`${label}-page.png is ${pageSize.width}x${pageSize.height}, expected 1280x800`);
  }
  return { ...capture, pagePath, pageSize };
}

// Live format from the run's own events: serve hit reasons name the live takeover path.
function liveFormat(events) {
  const reasons = new Set(events
    .filter((event) => event.code === 'bank.serve' && event.data?.result === 'hit')
    .map((event) => String(event.data?.reason ?? '')));
  const hls = [...reasons].some((reason) => reason.startsWith('live_hls'));
  const flv = reasons.has('live_stream') || reasons.has('live_stream_unpaired');
  if (hls && !flv) return 'HLS';
  if (flv && !hls) return 'FLV';
  if (hls && flv) return 'HLS+FLV';
  return 'unknown';
}

// ---- main -----------------------------------------------------------------

const cdpPort = await findAvailablePort();
const provenance = await readProvenance({
  rootDirectory: root,
  extensionDirectory,
  executeGit: async () => { throw new Error('no git in scratch copy'); },
});
const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-store-shots-profile-'));
const report = {
  provenance: {
    commitSha: process.env.BILIBILI_E2E_COMMIT_SHA?.trim() ?? provenance.commitSha,
    commitShaReason: provenance.commitShaReason,
    buildId: provenance.buildId,
    profileDirectory,
    chromeExecutablePath,
    launchMode: headed ? 'spawn+connectOverCDP headed' : 'spawn+connectOverCDP headless',
  },
  videoUrl: VIDEO_URL,
  videoId: VIDEO_URL.match(/(BV[0-9A-Za-z]+)/)?.[1] ?? null,
  liveUrl: LIVE_URL,
  roomId: LIVE_URL.match(/live\.bilibili\.com\/(\d+)/)?.[1] ?? null,
  consoleErrors: [],
  scenarios: {},
};
log('provenance', JSON.stringify(report.provenance));
log(`profile ${profileDirectory}, cdp port ${cdpPort}`);

// Chrome is spawned by this run and ended by PID; the temp profile names every process.
const chromeArguments = [
  '--mute-audio',
  // 无窗口默认（完整 Chrome 的 --headless）；--headed 显式要一个可见窗口。
  ...(headed ? [] : ['--headless']),
  '--enable-unsafe-extension-debugging',
  '--lang=zh-CN',
  '--force-device-scale-factor=2',
  '--window-size=1320,880',
  // The popup must fit below the toolbar without being clamped by the screen edge:
  // --force-device-scale-factor=2 halves Chrome's perceived screen (1920x1080 reads as
  // 960x540 with 516 available), and at window y=40 the popup anchor sits at ~116, so
  // Chrome clamped the popup window to 396 CSS px while the document is 435 and the
  // footer link (y 400.5-423) fell below the painted surface - the 63950b9 defect.
  // y=0 lifts the anchor to ~76 and leaves 440 CSS px of room.
  '--window-position=0,0',
  '--no-first-run',
  '--no-default-browser-check',
  `--user-data-dir=${profileDirectory}`,
  `--remote-debugging-port=${cdpPort}`,
  'about:blank',
];
const chromeProcess = spawn(chromeExecutablePath, chromeArguments, { stdio: 'ignore' });
log('spawned chrome pid', chromeProcess.pid);

let endpointUp = false;
for (let attempt = 0; attempt < 120 && !endpointUp; attempt += 1) {
  try {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    endpointUp = response.ok;
  } catch (error) { /* not up yet */ }
  if (!endpointUp) await sleep(500);
}
if (!endpointUp) throw new Error(`Chrome DevTools endpoint never came up on port ${cdpPort}`);

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
const context = browser.contexts()[0] ?? await browser.newContext();
let tabOpens = 0;
const originalNewPage = context.newPage.bind(context);
context.newPage = async (...args) => {
  tabOpens += 1;
  if (tabOpens > MAX_TAB_OPENS) {
    throw new Error(`tab open ceiling exceeded (${MAX_TAB_OPENS} context.newPage() calls)`);
  }
  return originalNewPage(...args);
};

const collectConsole = (page) => {
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    report.consoleErrors.push({ url: page.url(), location: message.location()?.url, text: message.text().slice(0, 400) });
  });
  page.on('pageerror', (error) => {
    report.consoleErrors.push({ url: page.url(), location: 'pageerror', text: String(error).slice(0, 400) });
  });
};

const raw = new RawCdp(cdpPort);
let wakerTargetId;
const budget = { popupOpens: 0 };
try {
  await raw.connect();
  await context.addInitScript({ content: muteGuardInit });
  const extensionId = await installUnpackedExtension(browser, extensionDirectory);
  report.provenance.extensionId = extensionId;
  report.provenance.browserVersion = browser.version();
  log('extension loaded', extensionId, 'chrome', report.provenance.browserVersion);
  context.on('page', collectConsole);

  const waker = await raw.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/logs.html`,
    background: true,
  });
  wakerTargetId = waker.targetId;
  const wakerTarget = await (async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const info = await findTarget(raw, (candidate) => candidate.targetId === wakerTargetId);
      if (info !== null) return info;
      await sleep(250);
    }
    throw new Error('waker page target not found');
  })();
  report.provenance.wakerTargetUrl = wakerTarget.url;

  // Video scenario: one cold video, playback started on the media element (never the skin).
  const videoPage = await context.newPage();
  collectConsole(videoPage);
  await videoPage.setViewportSize({ width: 1280, height: 800 });
  await videoPage.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await videoPage.waitForFunction(() => {
    const video = document.querySelector('video');
    return video !== null && video.readyState >= 3;
  }, undefined, { timeout: 120000 });
  const videoState = await videoPage.evaluate(() => {
    const video = document.querySelector('video');
    if (video.paused) void video.play().catch(() => {});
    return { paused: video.paused, duration: video.duration, readyState: video.readyState };
  });
  log('video element ready', JSON.stringify(videoState));

  const video = await captureScenario({
    raw,
    extensionId,
    wakerTarget,
    label: 'video',
    page: videoPage,
    budget,
    racing: false,
    maxWaitMs: 8 * 60 * 1000,
  });
  const videoEvents = (await readStoredEvents(context, extensionId)).events;
  const videoSessionId = videoEvents.find((event) => event.code === 'route.session_started')?.sessionId;
  report.scenarios.video = {
    readout: video.readout,
    darkReadout: video.darkReadout,
    lightPath: video.light.path,
    lightGeometry: video.light.geometry,
    darkPath: video.dark.path,
    darkGeometry: video.dark.geometry,
    pagePath: video.pagePath,
    sessionId: videoSessionId,
    takeoverActive: videoEvents.some((event) => event.code === 'bank.serve' && event.data?.result === 'hit'),
    racingActive: videoEvents.some((event) => event.code === 'bank.fetch.chunk' && event.data?.slot !== undefined),
    eventCount: videoEvents.length,
  };
  await videoPage.close();

  // Live scenario: one room, playback started on the media element (never the skin).
  const livePage = await context.newPage();
  collectConsole(livePage);
  await livePage.setViewportSize({ width: 1280, height: 800 });
  await livePage.goto(LIVE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await livePage.waitForFunction(() => document.querySelectorAll('video').length > 0, undefined, { timeout: 60000 });
  const liveState = await livePage.evaluate(() => {
    const video = [...document.querySelectorAll('video')]
      .sort((left, right) => (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight))[0];
    video.muted = true;
    video.volume = 0;
    if (video.paused) void video.play().catch(() => {});
    return { paused: video.paused, readyState: video.readyState, resolution: [video.videoWidth, video.videoHeight] };
  });
  log('live element ready', JSON.stringify(liveState));

  const live = await captureScenario({
    raw,
    extensionId,
    wakerTarget,
    label: 'live',
    page: livePage,
    budget,
    racing: true,
    maxWaitMs: 5 * 60 * 1000,
  });
  const liveEvents = (await readStoredEvents(context, extensionId)).events;
  const liveSessionId = liveEvents.filter((event) => event.code === 'route.session_started')
    .map((event) => event.sessionId).at(-1);
  const liveOwn = liveEvents.filter((event) => event.sessionId === liveSessionId);
  report.scenarios.live = {
    readout: live.readout,
    darkReadout: live.darkReadout,
    lightPath: live.light.path,
    lightGeometry: live.light.geometry,
    darkPath: live.dark.path,
    darkGeometry: live.dark.geometry,
    pagePath: live.pagePath,
    sessionId: liveSessionId,
    takeoverActive: liveOwn.some((event) => event.code === 'bank.serve' && event.data?.result === 'hit'),
    racingActive: liveOwn.some((event) => event.code === 'bank.fetch.chunk' && event.data?.slot !== undefined),
    eventCount: liveOwn.length,
  };
  report.liveFormat = liveFormat(liveOwn);
  await livePage.close();

  await fs.writeFile(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  log('report written');
  log(`tab opens used: ${tabOpens}/${MAX_TAB_OPENS}; popup opens: ${budget.popupOpens} (ceiling ${MAX_POPUP_OPENS_PER_SCENARIO} per scenario)`);
} finally {
  try { if (wakerTargetId !== undefined) await raw.send('Target.closeTarget', { targetId: wakerTargetId }); } catch (error) { /* already gone */ }
  raw.close();
  await browser.close().catch((error) => log('browser close failed', String(error)));
  try { chromeProcess.kill(); } catch (error) { /* exited already */ }
  log('browser closed');
  await sleep(1500);
  // Backstop: end only chrome.exe processes whose command line names THIS run's temp
  // profile. Never by image name: the user's daily Chrome shares the image name.
  if (process.platform === 'win32') {
    const killScript = `
      $dir = '${profileDirectory.replace(/\\/g, '\\\\')}'
      $procs = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$dir*" }
      foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
      @($procs).Count
    `;
    try {
      const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', killScript], { encoding: 'utf8' });
      log('backstop PID sweep matched processes:', stdout.trim());
    } catch (error) {
      log('backstop PID sweep failed:', String(error).slice(0, 300));
    }
  }
  await sleep(1000);
  await fs.rm(profileDirectory, { recursive: true, force: true }).catch((error) => log('profile cleanup failed', String(error)));
  log('temp profile removed');
}
