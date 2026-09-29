import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findAvailablePort, parseHeadedFlag, resolveChromeExecutablePath } from './browser-runtime.mjs';
import { startConsoleCapture, triggerExtensionPositiveControl } from './console-capture.mjs';
import { readMaxEventId, readStoredEvents } from './extension-log-pull.mjs';
import { installUnpackedExtension } from './install-unpacked-extension.mjs';
import { readProvenance } from './provenance.mjs';

// Real Chrome playback verification: npm run verify:browser -- --bv BV... --profile <signed-in-profile>

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const MEDIA_HOST = /(?:\.bilivideo\.com|\.akamaized\.net)$/;

function parseArgs(argv) {
  const options = {
    bv: 'BV1syga6fEL7',
    seconds: 150,
    startSeconds: 0,
    profile: undefined,
    outputDirectory: undefined,
    headed: parseHeadedFlag(argv),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--bv') options.bv = argv[++index];
    else if (key === '--seconds') options.seconds = Number(argv[++index]);
    else if (key === '--start-seconds') options.startSeconds = Number(argv[++index]);
    else if (key === '--profile') options.profile = argv[++index];
    else if (key === '--output-dir') options.outputDirectory = argv[++index];
    else throw new Error(`unknown argument ${key}`);
  }
  if (typeof options.bv !== 'string' || options.bv.length === 0) throw new Error('--bv must be non-empty');
  if (!Number.isFinite(options.seconds) || options.seconds <= 0) throw new Error('--seconds must be positive');
  if (!Number.isFinite(options.startSeconds) || options.startSeconds < 0) {
    throw new Error('--start-seconds must be non-negative');
  }
  if (options.profile !== undefined && (typeof options.profile !== 'string' || options.profile.length === 0)) {
    throw new Error('--profile must be a non-empty directory');
  }
  if (options.outputDirectory !== undefined
    && (typeof options.outputDirectory !== 'string' || options.outputDirectory.length === 0)) {
    throw new Error('--output-dir must be a non-empty directory');
  }
  return options;
}

function reportError(error) {
  const message = String(error?.message || error);
  return message.replace(/https?:\/\/[^\s'"`\])}]+/g, (value) => {
    if (!URL.canParse(value)) return 'invalid-url';
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  });
}

function overlapReport(requests) {
  const byPath = new Map();
  for (const record of requests) {
    if (record.rangeStart === undefined) continue;
    if (!byPath.has(record.pathname)) byPath.set(record.pathname, []);
    byPath.get(record.pathname).push([record.rangeStart, record.rangeEnd]);
  }
  const report = [];
  for (const [pathname, intervals] of byPath) {
    intervals.sort((left, right) => left[0] - right[0]);
    let requestedBytes = 0;
    let unionBytes = 0;
    let unionStart = intervals[0][0];
    let unionEnd = intervals[0][1];
    for (const [start, end] of intervals) {
      requestedBytes += end - start + 1;
      if (start > unionEnd + 1) {
        unionBytes += unionEnd - unionStart + 1;
        unionStart = start;
        unionEnd = end;
      } else if (end > unionEnd) {
        unionEnd = end;
      }
    }
    unionBytes += unionEnd - unionStart + 1;
    report.push({
      pathname,
      requestCount: intervals.length,
      requestedBytes,
      unionBytes,
      duplicateBytes: requestedBytes - unionBytes,
    });
  }
  return report.sort((left, right) => right.requestedBytes - left.requestedBytes);
}

// popup 验证：popup.html 以后台标签打开（chrome.tabs.create active:false），等它读到
// 当前视频页的状态（body[data-ready]），断言两个开关与缓冲、线路读数都来自当前构建。
// 不点击播放器皮肤：播放从 media 元素启动，画质菜单不再被驱动。
async function openBackgroundExtensionPage(context, extensionId, pagePath) {
  const launcher = await context.newPage();
  await launcher.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
  const [popupPage] = await Promise.all([
    context.waitForEvent('page'),
    launcher.evaluate((url) => new Promise((resolve, reject) => {
      chrome.tabs.create({ url, active: false }, (tab) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(tab.id);
      });
    }), `chrome-extension://${extensionId}/${pagePath}`),
  ]);
  await popupPage.waitForLoadState('domcontentloaded');
  await launcher.close();
  return popupPage;
}

async function verifyPopupReadouts(context, extensionId, videoPage) {
  const popupPage = await openBackgroundExtensionPage(context, extensionId, 'popup.html');
  // 无窗口模式下新标签开完即抢走活动标签：popup 开成后台标签后把视频页带回前台，
  // popup 的轮询才能读到它的状态（headless 实测）。
  await videoPage.bringToFront();
  try {
    await popupPage.waitForFunction(
      () => document.body?.dataset?.ready === 'true',
      undefined,
      { timeout: 20000 },
    );
    // 下载线路卡片由 logs:cdn-summary 异步填充（popup 每 500ms 轮询、查询限速 1 秒）。
    await popupPage.waitForFunction(
      () => document.querySelectorAll('.cdn-line').length >= 1,
      undefined,
      { timeout: 10000 },
    );
    const readout = await popupPage.evaluate(() => {
      const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? null;
      const switches = [...document.querySelectorAll('input[data-preference]')].map((input) => ({
        preference: input.dataset.preference,
        visible: input.offsetParent !== null,
        checked: input.checked,
      }));
      const lines = [...document.querySelectorAll('.cdn-line')].map((line) => ({
        name: line.querySelector('.cdn-name')?.textContent?.trim() ?? null,
        health: line.querySelector('.cdn-health')?.textContent?.trim() ?? null,
      }));
      const stateLine = document.querySelector('[data-status-field="state"]');
      return {
        ready: document.body?.dataset?.ready ?? null,
        notice: text('[data-notice]'),
        switches,
        bufferSeconds: text('[data-buffer-seconds]'),
        bufferGoal: text('[data-buffer-goal]'),
        targetLabel: text('[data-buffer-target-label]'),
        targetValue: text('[data-target-value]'),
        stateLineHidden: stateLine?.hidden ?? null,
        livePanelHidden: document.querySelector('[data-live-panel]')?.hidden ?? null,
        cdnLineCount: lines.length,
        lines,
      };
    });
    const failures = [];
    if (readout.switches.map((entry) => entry.preference).sort().join(',') !== 'liveEnabled,vodEnabled') {
      failures.push(`switches rendered as ${JSON.stringify(readout.switches)}`);
    }
    for (const entry of readout.switches) {
      if (entry.visible !== true || entry.checked !== true) {
        failures.push(`switch ${entry.preference} visible=${entry.visible} checked=${entry.checked}`);
      }
    }
    if (!/^\d+ 秒$/.test(readout.bufferSeconds ?? '')) failures.push(`bufferSeconds=${readout.bufferSeconds}`);
    if (!(readout.bufferGoal ?? '').includes('120')) failures.push(`bufferGoal=${readout.bufferGoal}`);
    if (readout.stateLineHidden !== false || (readout.targetValue ?? '') === '') {
      failures.push(`target state line hidden=${readout.stateLineHidden} value=${readout.targetValue}`);
    }
    if (readout.cdnLineCount < 1) failures.push(`cdn lines=${readout.cdnLineCount}`);
    if (failures.length > 0) {
      throw Object.assign(new Error(`popup readout failed: ${failures.join('; ')}`), {
        code: 'POPUP_READOUT_FAILED',
      });
    }
    return readout;
  } finally {
    await popupPage.close();
  }
}

const silenceInit = () => {
  const silence = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    element.muted = true;
    element.volume = 0;
  };
  const scan = (node) => {
    if (node instanceof HTMLMediaElement) silence(node);
    if (typeof node.querySelectorAll === 'function') {
      for (const element of node.querySelectorAll('video,audio')) silence(element);
    }
  };
  new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) scan(node);
  }).observe(document, { childList: true, subtree: true });
  scan(document);
};

async function readMedia(page) {
  return page.evaluate(() => {
    const video = [...document.querySelectorAll('video')]
      .sort((left, right) => (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight))[0];
    if (video === undefined) throw new Error('video element is unavailable');
    const quality = typeof video.getVideoPlaybackQuality === 'function'
      ? video.getVideoPlaybackQuality()
      : undefined;
    const buffered = [];
    for (let index = 0; index < video.buffered.length; index += 1) {
      buffered.push([video.buffered.start(index), video.buffered.end(index)]);
    }
    return {
      currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
      paused: video.paused,
      readyState: video.readyState,
      networkState: video.networkState,
      duration: Number.isFinite(video.duration) ? video.duration : null,
      buffered,
      resolution: [video.videoWidth, video.videoHeight],
      videoQuality: quality === undefined ? null : {
        total: Number.isFinite(quality.totalVideoFrames) ? quality.totalVideoFrames : null,
        dropped: Number.isFinite(quality.droppedVideoFrames) ? quality.droppedVideoFrames : null,
        corrupted: Number.isFinite(quality.corruptedVideoFrames) ? quality.corruptedVideoFrames : null,
      },
      muted: video.muted,
      volume: video.volume,
    };
  });
}

async function switchQuality(context, extensionId, page, startAfterEventId, pathname) {
  const beforeResult = await waitForMediaSample(
    context,
    extensionId,
    startAfterEventId,
    pathname,
    (event) => resolutionKey(event) !== undefined,
  );
  const before = beforeResult.sample;
  const qualityButton = page.locator('.bpx-player-ctrl-quality').first();
  try {
    await qualityButton.waitFor({ state: 'visible', timeout: 15000 });
  } catch (error) {
    throw Object.assign(new Error('quality control .bpx-player-ctrl-quality was not found or visible'), {
      code: 'QUALITY_CONTROL_NOT_FOUND',
      cause: error,
    });
  }
  await qualityButton.click();
  const menu = page.locator('.bpx-player-ctrl-quality-menu').first();
  try {
    await menu.waitFor({ state: 'visible', timeout: 5000 });
  } catch (error) {
    throw Object.assign(new Error('quality menu .bpx-player-ctrl-quality-menu did not open'), {
      code: 'QUALITY_MENU_NOT_FOUND',
      cause: error,
    });
  }
  const items = menu.locator('.bpx-player-ctrl-quality-menu-item');
  const metadata = await items.evaluateAll((elements) => elements.map((element) => ({
    text: element.textContent?.trim() || '',
    active: element.classList.contains('bpx-player-ctrl-quality-menu-item-active')
      || element.getAttribute('aria-selected') === 'true'
      || element.dataset.selected === 'true',
  })));
  if (metadata.length < 2) {
    throw Object.assign(new Error('quality menu has fewer than two selectable levels'), {
      code: 'QUALITY_LEVEL_NOT_FOUND',
    });
  }
  const activeIndex = metadata.findIndex((item) => item.active);
  const targetIndex = metadata.findIndex((item, index) => index !== activeIndex);
  if (targetIndex < 0) {
    throw Object.assign(new Error('quality menu has no level different from the current level'), {
      code: 'QUALITY_LEVEL_NOT_FOUND',
    });
  }
  await items.nth(targetIndex).click();
  const afterResult = await waitForMediaSample(
    context,
    extensionId,
    startAfterEventId,
    pathname,
    (event) => resolutionKey(event) !== undefined && resolutionKey(event) !== resolutionKey(before),
    30000,
  );
  return {
    beforeResolution: before.data.resolution,
    afterResolution: afterResult.sample.data.resolution,
    beforeVideoQuality: before.data.videoQuality,
    afterVideoQuality: afterResult.sample.data.videoQuality,
    selectedLevel: metadata[targetIndex].text,
  };
}

function assertPlayback(samples) {
  const times = samples.map((sample) => sample.currentTime).filter((time) => Number.isFinite(time));
  if (times.length < 2 || times.at(-1) <= times[0]) {
    throw Object.assign(new Error('video playback did not advance during the verification window'), {
      code: 'PLAYBACK_DID_NOT_ADVANCE',
    });
  }
  return { sampleCount: samples.length, firstCurrentTime: times[0], lastCurrentTime: times.at(-1) };
}

const options = parseArgs(process.argv.slice(2));
const chromeExecutablePath = await resolveChromeExecutablePath();
const cdpPort = await findAvailablePort();
const provenance = await readProvenance({ rootDirectory: root, extensionDirectory });
const outputDirectory = options.outputDirectory === undefined
  ? path.join(root, 'reports', `verify-${Date.now()}`)
  : path.resolve(options.outputDirectory);
await fs.mkdir(outputDirectory, { recursive: true });

const ownsProfile = options.profile === undefined;
const profileDirectory = ownsProfile
  ? await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-verify-profile-'))
  : path.resolve(options.profile);
let context;
let page;
let consoleCapture;
let extensionId;
let events = [];
let mediaRequests = [];
const networkParseFailures = [];
const summary = {
  status: 'INCONCLUSIVE',
  failures: [],
  blocked: undefined,
  commitSha: provenance.commitSha,
  commitShaReason: provenance.commitShaReason,
  buildId: provenance.buildId,
  options: {
    bv: options.bv,
    seconds: options.seconds,
    startSeconds: options.startSeconds,
    persistentProfile: options.profile !== undefined,
  },
  browser: {
    headless: !options.headed,
    muteAudio: true,
    browserStarted: false,
  },
};

try {
  context = await chromium.launchPersistentContext(profileDirectory, {
    executablePath: chromeExecutablePath,
    cdpPort,
    headless: !options.headed,
    args: [
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--enable-unsafe-extension-debugging',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
    timeout: 120000,
  });
  summary.browser.browserStarted = true;
  extensionId = await installUnpackedExtension(context.browser(), extensionDirectory);
  consoleCapture = await startConsoleCapture(cdpPort, extensionId);
  await triggerExtensionPositiveControl(context, extensionId, consoleCapture);
  summary.positiveControl = { captured: true };
  await context.addInitScript({ content: `(${silenceInit.toString()})()` });

  const startAfterEventId = await readMaxEventId(context, extensionId);
  page = await context.newPage();
  const networkClient = await context.newCDPSession(page);
  await networkClient.send('Network.enable');
  await networkClient.send('Network.clearBrowserCache');
  const requestsById = new Map();
  mediaRequests = [];
  networkClient.on('Network.requestWillBeSent', (event) => {
    let parsed;
    try {
      parsed = new URL(event.request.url);
    } catch (error) {
      networkParseFailures.push({ message: reportError(error) });
      return;
    }
    if (!MEDIA_HOST.test(parsed.hostname)) return;
    const headers = event.request.headers || {};
    const rangeHeader = headers.Range ?? headers.range;
    const match = typeof rangeHeader === 'string' ? /^bytes=(\d+)-(\d+)$/.exec(rangeHeader) : null;
    const record = {
      requestId: event.requestId,
      hostname: parsed.hostname,
      pathname: parsed.pathname,
      rangeHeader: rangeHeader ?? null,
      rangeStart: match ? Number(match[1]) : undefined,
      rangeEnd: match ? Number(match[2]) : undefined,
      status: undefined,
      encodedDataLength: 0,
      totalSize: undefined,
    };
    requestsById.set(event.requestId, record);
    mediaRequests.push(record);
  });
  networkClient.on('Network.responseReceived', (event) => {
    const record = requestsById.get(event.requestId);
    if (record === undefined) return;
    record.status = event.response.status;
    const headers = event.response.headers || {};
    const contentRange = headers['content-range'] ?? headers['Content-Range'];
    const match = typeof contentRange === 'string' ? /\/(\d+)$/.exec(contentRange) : null;
    if (match !== null) record.totalSize = Number(match[1]);
  });
  networkClient.on('Network.loadingFinished', (event) => {
    const record = requestsById.get(event.requestId);
    if (record !== undefined) record.encodedDataLength = event.encodedDataLength;
  });
  networkClient.on('Network.loadingFailed', (event) => {
    const record = requestsById.get(event.requestId);
    if (record !== undefined) record.failed = event.errorText;
  });

  const startFragment = options.startSeconds > 0 ? `?t=${options.startSeconds}` : '';
  const url = `https://www.bilibili.com/video/${options.bv}${startFragment}`;
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  } catch (error) {
    throw Object.assign(new Error('page navigation did not complete'), {
      code: 'BLOCKED_PAGE_UNREACHABLE',
      cause: error,
    });
  }
  if (response === null || response.status() >= 400) {
    throw Object.assign(new Error(`page was unreachable: status ${response?.status() ?? 'missing'}`), {
      code: 'BLOCKED_PAGE_UNREACHABLE',
    });
  }
  try {
    await page.waitForFunction(
      () => [...document.querySelectorAll('video')].some((video) => Number.isFinite(video.duration) && video.duration > 0),
      undefined,
      { timeout: 60000 },
    );
  } catch (error) {
    throw Object.assign(new Error('page did not expose a playable video'), {
      code: 'BLOCKED_VIDEO_UNAVAILABLE',
      cause: error,
    });
  }
  await page.evaluate(() => {
    const video = [...document.querySelectorAll('video')]
      .sort((left, right) => (right.clientWidth * right.clientHeight) - (left.clientWidth * left.clientHeight))[0];
    if (video === undefined) throw new Error('video element disappeared before playback');
    video.muted = true;
    video.volume = 0;
    if (video.paused) void video.play();
  });

  const pathname = new URL(page.url()).pathname;
  summary.popup = await verifyPopupReadouts(context, extensionId, page);
  const sampled = [];
  const sampleCount = Math.max(2, Math.round(options.seconds / 5));
  for (let index = 0; index < sampleCount; index += 1) {
    await page.waitForTimeout(5000);
    sampled.push(await readMedia(page));
  }
  summary.playback = assertPlayback(sampled);
  summary.samples = sampled;

  const stored = await readStoredEvents(context, extensionId, startAfterEventId);
  events = stored.events;
  summary.eventTotal = events.length;
  summary.mediaErrors = events.filter((event) => event.code === 'media.error' || event.code === 'media.stalled').length;
  summary.extensionErrors = events.filter((event) => event.code === 'extension.observer_error'
    || event.code === 'extension.boot_error').length;
  summary.mediaRequests = mediaRequests.length;
  summary.mediaBytes = mediaRequests.reduce((total, record) => total + (record.encodedDataLength || 0), 0);
  summary.failedRequests = mediaRequests.filter((record) => record.failed !== undefined).length;
  summary.nonPartialResponses = mediaRequests.filter((record) => record.status !== undefined
    && record.status !== 206 && record.status !== 200).length;
  summary.overlap = overlapReport(mediaRequests);
  summary.networkParseFailures = networkParseFailures;
  summary.console = consoleCapture.verdict();
  if (summary.console.status !== 'pass') {
    throw Object.assign(new Error(summary.console.failures.join('; ')), { code: 'CONSOLE_VERDICT_FAILED' });
  }
  summary.status = 'pass';
} catch (error) {
  const failure = { code: error?.code || 'VERIFY_FAILED', message: reportError(error) };
  const blocked = failure.code.startsWith('BLOCKED_');
  summary.status = blocked || ['CONSOLE_POSITIVE_CONTROL_MISSED', 'CONSOLE_CAPTURE_FAILED'].includes(failure.code)
    ? 'INCONCLUSIVE'
    : 'fail';
  summary.failures.push(failure);
  if (blocked) summary.blocked = { status: 'BLOCKED', ...failure };
  if (consoleCapture !== undefined) {
    summary.console = consoleCapture.verdict();
    if (summary.console.status === 'fail' && failure.code !== 'CONSOLE_VERDICT_FAILED') {
      summary.status = 'fail';
      summary.failures.push({
        code: 'CONSOLE_VERDICT_FAILED',
        message: summary.console.failures.join('; '),
      });
    }
  }
  summary.networkParseFailures = networkParseFailures;
} finally {
  await page?.close();
  await consoleCapture?.close();
  await context?.close();
  if (ownsProfile) await fs.rm(profileDirectory, { recursive: true, force: true });
  await fs.writeFile(path.join(outputDirectory, 'events.json'), `${JSON.stringify(events, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    path.join(outputDirectory, 'console.json'),
    `${JSON.stringify(consoleCapture?.events || [], null, 2)}\n`,
    'utf8',
  );
  await fs.writeFile(path.join(outputDirectory, 'network.json'), `${JSON.stringify(mediaRequests, null, 2)}\n`, 'utf8');
  await fs.writeFile(path.join(outputDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
  outputDirectory,
  status: summary.status,
  commitSha: summary.commitSha,
  buildId: summary.buildId,
  failures: summary.failures,
  blocked: summary.blocked,
  console: summary.console,
  popup: summary.popup,
  playback: summary.playback,
  eventTotal: summary.eventTotal,
  mediaRequests: summary.mediaRequests,
}, null, 2));
if (summary.status !== 'pass') process.exitCode = 1;
