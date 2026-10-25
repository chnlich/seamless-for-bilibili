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
// The real popup is opened, read and photographed by real-popup.mjs, which live-backup-run.mjs
// uses as well. This script adds the store-image checks over it: the popup geometry, the PNG size
// and the ink on the footer link, the readouts a store shot rejects, and the ceilings.
//
// Process rules (skill smooth-bilibili-plugin, they are not negotiable):
//   - Chrome is spawned by this script with its own temp --user-data-dir and ended by PID:
//     browser.close() + child.kill(), then a backstop sweep that force-kills only chrome.exe
//     processes whose command line names this run's own temp profile. Never by image name.
//   - Hard ceilings on opened tabs and popup opens; the run fails loudly when one is exceeded.
//   - The player is never touched through its skin: playback is started on the media element
//     itself (video.play()), quality menus are never opened, and no whole-run auto-retry exists.
//   - A required readout that never appears fails the run; the popup is never captured
//     empty or in a degraded moment (failure tone, player waiting, no recent data).
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
import { connectRealPopup } from './real-popup.mjs';
import { DOWNLOAD_CARD_TEXT } from '../src/extension/popup-view.js';

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

// fMP4 rooms append the FLV backup state to the takeover line
// (「正在按两条线路竞速下载，FLV 后备已接上」, popup-view.js liveTakeoverText);
// the assertions compare the racing prefix.
const RACING_STATUS_TEXT = '正在按两条线路竞速下载';

// The video waiting headline is built in videoHeadline (src/extension/popup-view.js) as
// `正在等 <m:ss> 处的数据`; the prefix rejects every one of its forms.
const WAITING_HEADLINE_PREFIX = '正在等';

// The decoder-underflow headline comes from the same function as
// `播放器解码没跟上，缓冲里还有 <N> 秒数据`; a store shot must not show the player
// stalled either, so the prefix rejects it too.
const DECODER_STALL_HEADLINE_PREFIX = '播放器解码没跟上';

// The live card names what a stalled stream waits for (liveWaitOf in src/extension/popup-view.js):
// `在等一个分片，已 <N> 秒没收到数据`, `分片下载中，已 <N> 秒，收到 <bytes>` (a segment request
// waiting 2 s or longer), `播放列表 <N> 秒没有新分片` and `播放器 <N> 秒没有请求数据` (a playlist or
// a player gone quiet). A store shot must not show any of them.
const LIVE_WAIT_HEADLINE_PATTERN = /^(在等一个分片|分片下载中|播放列表 \d+ 秒没有新分片|播放器 \d+ 秒没有请求数据)/;

// Headless Chrome's virtual screen defaults to 800x600 device px, which
// --force-device-scale-factor=2 turns into 400x300 CSS px: measured on Chrome 154, the popup
// anchored at y 76 was clamped to a 220 CSS px viewport. --screen-info raises the virtual
// screen to 1920x1200 CSS px, and the same popup then grows to Chrome's own 600 CSS px popup
// ceiling, above the 435 CSS px video popup document.
const HEADLESS_SCREEN = { width: 3840, height: 2400 };

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

function log(...parts) { console.log(new Date().toISOString(), ...parts); }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

// ---- popup: the store-image checks over the shared driver (real-popup.mjs) -------------

// Opens the real popup through the shared driver. Counts every open against the ceiling.
async function withCountedPopup(popup, scenarioBudget, run) {
  scenarioBudget.popupOpens += 1;
  if (scenarioBudget.popupOpens > MAX_POPUP_OPENS_PER_SCENARIO) {
    throw new Error(`popup open ceiling exceeded (${MAX_POPUP_OPENS_PER_SCENARIO} opens in one scenario)`);
  }
  return popup.withPopup(run);
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
// the ink check on the written image is the final evidence. The footer link's rect is
// recorded in report.json and verified against the written PNG's pixels.
async function checkedPopupShot(view, target) {
  const geometry = await view.geometry();
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
  const written = path.join(outDir, target);
  await view.screenshot(written, geometry);
  log('wrote', written);
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

// ---- scenarios ------------------------------------------------------------

// A store shot must show the card in a healthy moment: beyond the basic "real data"
// checks (ready body, two line rows with text, a headline, live takeover racing, video
// buffer at target), reject a readout with a warn/bad line tone, a player waiting for
// data, no download records yet, no bytes in the last 5 seconds, or (video) an empty
// second line. Each rejected state is a true readout of a degraded moment, so the poll
// loop keeps waiting for a healthy one instead of capturing it.
function assertRealReadout(label, readout, { racing }) {
  if (readout.bodyReady !== 'true') throw new Error(`${label}: popup body never became ready`);
  if (readout.errorLine !== null && readout.errorLine !== '') {
    throw new Error(`${label}: popup shows an error line: ${readout.errorLine}`);
  }
  const statuses = readout.lines.map((line) => line.status ?? '');
  if (readout.lines.length < 2 || statuses.some((status) => status === '')) {
    throw new Error(`${label}: line cards do not show two line statuses: ${JSON.stringify(readout.lines)}`);
  }
  if (readout.lines.some((line) => line.tone === 'warn' || line.tone === 'bad')) {
    throw new Error(`${label}: a line row shows a failure tone: ${JSON.stringify(readout.lines)}`);
  }
  const headline = readout.downloadHeadline ?? '';
  if (headline === '') {
    throw new Error(`${label}: the download card shows no headline`);
  }
  if (headline.startsWith(WAITING_HEADLINE_PREFIX)) {
    throw new Error(`${label}: the player is waiting for data: ${JSON.stringify(headline)}`);
  }
  if (headline.startsWith(DECODER_STALL_HEADLINE_PREFIX)) {
    throw new Error(`${label}: the player's decoder is not keeping up: ${JSON.stringify(headline)}`);
  }
  if (LIVE_WAIT_HEADLINE_PATTERN.test(headline)) {
    throw new Error(`${label}: the live stream is stalled: ${JSON.stringify(headline)}`);
  }
  if (headline === DOWNLOAD_CARD_TEXT.noRecords) {
    throw new Error(`${label}: the download card has no records yet: ${JSON.stringify(headline)}`);
  }
  // quietVideo carries quietLive as its suffix, so one endsWith covers both pages.
  if (headline.endsWith(DOWNLOAD_CARD_TEXT.quietLive)) {
    throw new Error(`${label}: no bytes received in the last 5 seconds: ${JSON.stringify(headline)}`);
  }
  const seconds = Number.parseInt(readout.bufferSeconds ?? '', 10);
  if (racing) {
    if (!(readout.liveTakeover ?? '').startsWith(RACING_STATUS_TEXT)) {
      throw new Error(`${label}: live takeover status is ${JSON.stringify(readout.liveTakeover)}, expected it to start with ${RACING_STATUS_TEXT}`);
    }
    return;
  }
  if (!Number.isFinite(seconds) || seconds < BUFFER_TARGET_SECONDS) {
    throw new Error(`${label}: buffer readout is ${JSON.stringify(readout.bufferSeconds)}, expected at least ${BUFFER_TARGET_SECONDS} seconds`);
  }
  if (readout.downloadSubline === null || readout.downloadSubline === '') {
    throw new Error(`${label}: the video download card shows no second line`);
  }
}

async function captureScenario({
  popup,
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
      lastReadout = await withCountedPopup(popup, budget, (view) => view.readout());
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

  const capture = await withCountedPopup(popup, budget, async (view) => {
    const readout = await view.readout();
    assertRealReadout(label, readout, { racing });
    const light = await checkedPopupShot(view, `${label}-popup-light.png`);
    await view.emulateColorScheme('dark');
    await sleep(400);
    const darkReadout = await view.readout();
    const dark = await checkedPopupShot(view, `${label}-popup-dark.png`);
    await view.emulateColorScheme('light');
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
  ...(headed ? [] : ['--headless', `--screen-info={0,0 ${HEADLESS_SCREEN.width}x${HEADLESS_SCREEN.height}}`]),
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

let popup;
const budget = { popupOpens: 0 };
try {
  // Preflight: a Chrome that ignores --screen-info clamps the headless popup again.
  const screenAvailable = await context.pages()[0].evaluate(() => ({ width: screen.availWidth, height: screen.availHeight }));
  report.provenance.screenAvailable = screenAvailable;
  log('screen available (CSS px)', JSON.stringify(screenAvailable));
  if (!headed && (screenAvailable.width !== HEADLESS_SCREEN.width / 2 || screenAvailable.height !== HEADLESS_SCREEN.height / 2)) {
    throw new Error(
      `the headless screen reads ${screenAvailable.width}x${screenAvailable.height} CSS px, expected`
      + ` ${HEADLESS_SCREEN.width / 2}x${HEADLESS_SCREEN.height / 2}: --screen-info was not applied and the popup would be clamped`,
    );
  }
  await context.addInitScript({ content: muteGuardInit });
  const extensionId = await installUnpackedExtension(browser, extensionDirectory);
  report.provenance.extensionId = extensionId;
  report.provenance.browserVersion = browser.version();
  log('extension loaded', extensionId, 'chrome', report.provenance.browserVersion);
  context.on('page', collectConsole);

  // The waker page (logs.html in a background tab) is opened once per run and exists for all of it.
  popup = await connectRealPopup({ cdpPort, extensionId });
  report.provenance.wakerTargetUrl = popup.wakerUrl;

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
    popup,
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
    popup,
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
  // The browser must end by PID whatever happens to the popup driver, so a failed close is logged.
  await popup?.close().catch((error) => log('popup driver close failed', String(error)));
  await browser.close().catch((error) => log('browser close failed', String(error)));
  try { chromeProcess.kill(); } catch (error) { /* exited already */ }
  log('browser closed');
  await sleep(1500);
  // Backstop: end only chrome.exe processes whose command line names THIS run's temp
  // profile. Never by image name: the user's daily Chrome shares the image name.
  if (process.platform === 'win32') {
    // A PowerShell single-quoted string takes backslashes literally; doubling them made the
    // -like pattern match no command line at all.
    const killScript = `
      $dir = '${profileDirectory.replace(/'/g, "''")}'
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
