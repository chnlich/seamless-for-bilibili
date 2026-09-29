import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findAvailablePort, parseHeadedFlag, resolveChromeExecutablePath } from './browser-runtime.mjs';
import { startConsoleCapture, triggerExtensionPositiveControl } from './console-capture.mjs';
import { readStoredEvents } from './extension-log-pull.mjs';
import { installUnpackedExtension } from './install-unpacked-extension.mjs';
import { readProvenance } from './provenance.mjs';
import { READOUTS_VERSION } from '../src/extension/readouts.js';
import { STATUS_MESSAGE_VERSION } from '../src/ui/panel.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');

const silentAndAuditInit = () => {
  const media = new Set();
  const ownership = [];
  const fixtureCalls = [];
  let fixtureDepth = 0;
  let quietDepth = 0;
  const silence = (element) => {
    if (!(element instanceof HTMLMediaElement)) return;
    media.add(element);
    quietDepth += 1;
    try {
      element.muted = true;
      element.volume = 0;
    } finally {
      quietDepth -= 1;
    }
  };
  const scan = (rootNode) => {
    if (rootNode instanceof HTMLMediaElement) silence(rootNode);
    if (typeof rootNode.querySelectorAll !== 'function') return;
    for (const element of rootNode.querySelectorAll('video,audio')) silence(element);
  };
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) for (const node of mutation.addedNodes) scan(node);
  });
  observer.observe(document, { childList: true, subtree: true });
  const originalPlay = HTMLMediaElement.prototype.play;
  const originalPause = HTMLMediaElement.prototype.pause;
  const record = (name) => {
    if (quietDepth === 0) ownership.push(`${fixtureDepth > 0 ? 'fixture' : 'extension'}:${name}`);
  };
  for (const [name, original] of [['play', originalPlay], ['pause', originalPause]]) {
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      configurable: true,
      writable: true,
      value(...args) {
        record(name);
        silence(this);
        return original.apply(this, args);
      },
    });
  }
  for (const name of ['currentTime', 'playbackRate', 'muted', 'volume', 'src']) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, name);
    if (descriptor?.set === undefined) continue;
    Object.defineProperty(HTMLMediaElement.prototype, name, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: descriptor.get,
      set(value) {
        record(`set:${name}`);
        return descriptor.set.call(this, value);
      },
    });
  }
  scan(document);
  window.__e2eAudit = {
    async fixtureCall(name, callback) {
      fixtureCalls.push(name);
      fixtureDepth += 1;
      try {
        return await callback();
      } finally {
        fixtureDepth -= 1;
      }
    },
    reset() { ownership.length = 0; },
    ownership() { return [...ownership]; },
    extensionOwnership() { return ownership.filter((entry) => entry.startsWith('extension:')); },
    fixtureOwnership() { return ownership.filter((entry) => entry.startsWith('fixture:')); },
    fixtureCalls() { return [...fixtureCalls]; },
    silence() {
      scan(document);
      return [...media].map((element) => ({ muted: element.muted, volume: element.volume }));
    },
  };
};

const autoOpenPopupLogs = () => {
  if (location.protocol !== 'chrome-extension:' || location.pathname !== '/popup.html' ||
    location.search !== '?e2e-open-logs') return;
  const clickWhenPopupHasPageData = () => {
    const button = document.querySelector('[data-open-logs]');
    if (document.body.dataset.ready === 'true' && button instanceof HTMLButtonElement) {
      window.__e2ePopupLogsClicked = true;
      button.click();
      return;
    }
    window.setTimeout(clickWhenPopupHasPageData, 20);
  };
  document.addEventListener('DOMContentLoaded', clickWhenPopupHasPageData, { once: true });
};

const INVENTORY_VIDEO_URL = 'https://e2e-video.bilivideo.com/e2e/video-active.m4s?signature=video';
const INVENTORY_ADDRESS_BOOK_ONLY_URL = 'https://e2e-video.bilivideo.com/e2e/video-address-book-only.m4s?signature=unused';
const INVENTORY_AUDIO_URL = 'https://e2e-audio.bilivideo.com/e2e/audio-active.m4s?signature=audio';
const INVENTORY_TOTAL_SIZE = 1024 ** 2;
const INVENTORY_VIDEO_PATH = new URL(INVENTORY_VIDEO_URL).pathname;
const INVENTORY_ADDRESS_BOOK_ONLY_PATH = new URL(INVENTORY_ADDRESS_BOOK_ONLY_URL).pathname;
const INVENTORY_AUDIO_PATH = new URL(INVENTORY_AUDIO_URL).pathname;
const INVENTORY_PLAYURL_BODY = {
  code: 0,
  data: {
    dash: {
      video: [
        {
          id: 64,
          baseUrl: INVENTORY_VIDEO_URL,
          backupUrl: [],
          mimeType: 'video/mp4',
          codecs: 'avc1.640028',
          height: 720,
          bandwidth: 1000000,
        },
        {
          id: 32,
          baseUrl: INVENTORY_ADDRESS_BOOK_ONLY_URL,
          backupUrl: [],
          mimeType: 'video/mp4',
          codecs: 'avc1.4d401f',
          height: 480,
          bandwidth: 500000,
        },
      ],
      audio: [{
        id: 30280,
        baseUrl: INVENTORY_AUDIO_URL,
        backupUrl: [],
        mimeType: 'audio/mp4',
        codecs: 'mp4a.40.2',
        bandwidth: 128000,
      }],
    },
  },
};
const INVENTORY_ADVERTISED_REPRESENTATION_COUNT = 3;

const LIVE_SEGMENT_URL = 'https://e2e-live.bilivideo.com/e2e/live-segment-1.m4s?signature=live';
const LIVE_SEGMENT_PATH = new URL(LIVE_SEGMENT_URL).pathname;
const LIVE_SEGMENT_TOTAL_SIZE = 1024 * 1024;

const liveFixture = `<!doctype html><html><body><script>
  window.__liveFixture = { responses: [], errors: [] };
  async function pullSegment() {
    try {
      const response = await fetch(${JSON.stringify(LIVE_SEGMENT_URL)}, {
        headers: { Range: 'bytes=0-${LIVE_SEGMENT_TOTAL_SIZE - 1}' },
      });
      const buffer = await response.arrayBuffer();
      window.__liveFixture.responses.push({ status: response.status, bytes: buffer.byteLength });
    } catch (error) {
      window.__liveFixture.errors.push(String(error));
    }
  }
  void pullSegment();
  setInterval(() => {
    if (window.__liveFixture.responses.length + window.__liveFixture.errors.length < 4) void pullSegment();
  }, 400);
</script></body></html>`;

// 直播分片路由应答：页面请求带闭合 Range（播放器视角），接管腿不带 Range（整段取回）。
async function liveRequestHandler(route) {
  const request = route.request();
  const requestUrl = new URL(request.url());
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: inventoryCorsHeaders, body: '' });
    return;
  }
  if (requestUrl.hostname === 'e2e-live.bilivideo.com' && requestUrl.pathname === LIVE_SEGMENT_PATH) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers().range || '');
    const start = match === null ? 0 : Number(match[1]);
    const requestedEnd = match === null ? LIVE_SEGMENT_TOTAL_SIZE - 1 : Number(match[2]);
    const end = Math.min(requestedEnd, LIVE_SEGMENT_TOTAL_SIZE - 1);
    const body = Buffer.alloc(end - start + 1, 0x2b);
    await route.fulfill({
      status: match === null ? 200 : 206,
      headers: {
        ...inventoryCorsHeaders,
        'Content-Length': String(body.byteLength),
        'Content-Range': `bytes ${start}-${end}/${LIVE_SEGMENT_TOTAL_SIZE}`,
        'Content-Type': 'video/mp4',
      },
      body,
    });
    return;
  }
  await route.fulfill({ status: 204, body: '' });
}

const videoFixture = `<!doctype html><html><body><div id="stage"></div><script>
  const stage = document.querySelector('#stage');
  const video = document.createElement('video');
  video.id = 'media';
  video.width = 320;
  video.height = 180;
  video.playsInline = true;
  video.muted = true;
  video.volume = 0;
  stage.append(video);
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext('2d');
  context.fillStyle = '#18b66a';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const stream = canvas.captureStream(30);
  let sourceKey = 'video-source-1';
  video.src = sourceKey;
  setInterval(() => {
    context.fillStyle = '#18b66a';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, 50);
  video.srcObject = stream;
  const readoutMediaSource = new MediaSource();
  const readoutMediaSourceUrl = URL.createObjectURL(readoutMediaSource);
  const readoutVideo = document.createElement('video');
  readoutVideo.id = 'readout-media';
  readoutVideo.width = 1;
  readoutVideo.height = 1;
  readoutVideo.muted = true;
  readoutVideo.volume = 0;
  stage.append(readoutVideo);
  let readoutSourceBuffer;
  readoutMediaSource.addEventListener('sourceopen', () => {
    const mimeType = 'audio/mp4; codecs="mp4a.40.2"';
    if (MediaSource.isTypeSupported(mimeType)) readoutSourceBuffer = readoutMediaSource.addSourceBuffer(mimeType);
  });
  readoutVideo.src = readoutMediaSourceUrl;
  let decodedFrames = 0;
  let decodedNonBlack = false;
  const probe = document.createElement('canvas');
  probe.width = 320;
  probe.height = 180;
  const probeContext = probe.getContext('2d');
  function onFrame() {
    decodedFrames += 1;
    probeContext.drawImage(video, 0, 0, probe.width, probe.height);
    const pixels = probeContext.getImageData(0, 0, 1, 1).data;
    decodedNonBlack = pixels[0] + pixels[1] + pixels[2] > 12 && pixels[3] > 0;
    video.requestVideoFrameCallback(onFrame);
  }
  video.requestVideoFrameCallback(onFrame);
  const calls = [];
  let core = { setStableBufferTime(seconds) { calls.push(seconds); } };
  window.player = { __core() { return core; } };
  window.__fixture = {
    calls,
    async start() { await window.__e2eAudit.fixtureCall('play', () => video.play()); },
    decodedFrames() { return decodedFrames; },
    decodedNonBlack() { return decodedNonBlack; },
    replace() {
      sourceKey = 'video-source-2';
      video.src = sourceKey;
      core = { setStableBufferTime(seconds) { calls.push(seconds); } };
      window.__e2eAudit.reset();
    },
    activateReadoutVideo() {
      readoutVideo.width = 321;
      readoutVideo.height = 181;
      readoutSourceBuffer.dispatchEvent(new Event('updateend'));
    },
    triggerUniqueMediaEvent() {
      const selected = readoutVideo.width * readoutVideo.height > video.width * video.height
        ? readoutVideo
        : video;
      selected.dispatchEvent(new Event('ended'));
    },
    async populateBankInventory() {
      const playurlResponse = await fetch('https://api.bilibili.com/x/player/playurl?e2e=inventory');
      if (!playurlResponse.ok) throw new Error('inventory playurl fixture request failed');
      const playurl = await playurlResponse.json();
      const advertised = [
        ...playurl.data.dash.video,
        ...playurl.data.dash.audio,
      ].map((representation) => new URL(representation.baseUrl).pathname);
      for (const url of [
        playurl.data.dash.video[0].baseUrl,
        playurl.data.dash.audio[0].baseUrl,
      ]) {
        const response = await fetch(url, { headers: { Range: 'bytes=0-15' } });
        if (!response.ok) throw new Error('inventory segment fixture request failed');
        const bytes = await response.arrayBuffer();
        if (bytes.byteLength !== 16) throw new Error('inventory segment fixture length mismatch');
      }
      return {
        advertised,
        requested: [
          new URL(playurl.data.dash.video[0].baseUrl).pathname,
          new URL(playurl.data.dash.audio[0].baseUrl).pathname,
        ],
      };
    },
  };
  window.__e2eAudit.reset();
</script></body></html>`;

async function waitFor(page, predicate, timeout = 15000) {
  await page.waitForFunction(predicate, undefined, { timeout });
}

function assertNoForbiddenExtensionMediaWrites(entries) {
  assert.deepEqual(
    entries.filter((entry) => [
      'extension:play',
      'extension:pause',
      'extension:set:playbackRate',
      'extension:set:muted',
      'extension:set:volume',
      'extension:set:src',
      'extension:set:currentSrc',
    ].includes(entry)),
    [],
  );
}

async function openFixture(context, url, html, requestHandler) {
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    if (route.request().isNavigationRequest()) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: html });
      return;
    }
    if (requestHandler !== undefined) {
      await requestHandler(route);
      return;
    }
    await route.fulfill({ status: 204, body: '' });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

const inventoryCorsHeaders = {
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length',
};

async function inventoryRequestHandler(route) {
  const request = route.request();
  const requestUrl = new URL(request.url());
  if (request.method() === 'OPTIONS') {
    await route.fulfill({ status: 204, headers: inventoryCorsHeaders, body: '' });
    return;
  }
  if (requestUrl.hostname === 'api.bilibili.com' && requestUrl.pathname.endsWith('/playurl')) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: inventoryCorsHeaders,
      body: JSON.stringify(INVENTORY_PLAYURL_BODY),
    });
    return;
  }
  if (requestUrl.hostname.endsWith('.bilivideo.com')
    && [INVENTORY_VIDEO_PATH, INVENTORY_ADDRESS_BOOK_ONLY_PATH, INVENTORY_AUDIO_PATH]
      .includes(requestUrl.pathname)) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers().range || '');
    assert.ok(match, `inventory segment request has no closed range: ${request.url()}`);
    const start = Number(match[1]);
    const requestedEnd = Number(match[2]);
    if (start >= INVENTORY_TOTAL_SIZE) {
      await route.fulfill({ status: 416, headers: inventoryCorsHeaders, body: '' });
      return;
    }
    const end = Math.min(requestedEnd, INVENTORY_TOTAL_SIZE - 1);
    const body = Buffer.alloc(end - start + 1, 0x2a);
    await route.fulfill({
      status: 206,
      headers: {
        ...inventoryCorsHeaders,
        'Content-Length': String(body.byteLength),
        'Content-Range': `bytes ${start}-${end}/${INVENTORY_TOTAL_SIZE}`,
        'Content-Type': 'video/mp4',
      },
      body,
    });
    return;
  }
  await route.fulfill({ status: 204, body: '' });
}

async function extensionSend(page, message) {
  return page.evaluate((request) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(request, (response) => {
      if (chrome.runtime.lastError !== undefined) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  }), message);
}

async function extensionTabSend(page, message) {
  return page.evaluate((request) => new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      if (chrome.runtime.lastError !== undefined) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) {
        reject(new Error('active video tab is unavailable'));
        return;
      }
      chrome.tabs.sendMessage(tabs[0].id, request, (response) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    });
  }), message);
}

// 开发日志读取复用一个长驻 logs.html 页面：绝不为每次轮询新开标签页。
const logsReaders = new Map();
async function logsReaderFor(context, extensionId) {
  const existing = logsReaders.get(context);
  if (existing !== undefined) return existing;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
  let afterEventId = 0;
  const allEvents = [];
  const reader = {
    page,
    events: () => allEvents,
    async readNewEvents() {
      const result = await page.evaluate(async (cursor) => {
        const send = (message) => new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError !== undefined) {
              reject(new Error(chrome.runtime.lastError.message));
              return;
            }
            resolve(response);
          });
        });
        const snapshot = await send({ version: 1, type: 'logs:max-event-id' });
        if (snapshot?.ok !== true || !Number.isInteger(snapshot.maxEventId) || snapshot.maxEventId < 0) {
          throw new Error(snapshot?.error?.message || 'extension log snapshot was rejected');
        }
        const events = [];
        let position = cursor;
        for (;;) {
          const response = await send({
            version: 1,
            type: 'logs:events-page',
            limit: 250,
            afterEventId: position,
            maxEventId: snapshot.maxEventId,
          });
          if (response?.ok !== true) throw new Error(response?.error?.message || 'extension log page was rejected');
          events.push(...response.events);
          if (!response.hasMore) {
            position = response.nextAfterEventId ?? snapshot.maxEventId;
            break;
          }
          const next = response.nextAfterEventId ?? response.events.at(-1)?.eventId;
          if (!Number.isInteger(next) || next <= position) throw new Error('log paging did not advance');
          position = next;
        }
        return { events, maxEventId: snapshot.maxEventId };
      }, afterEventId);
      afterEventId = result.maxEventId;
      allEvents.push(...result.events);
      return result;
    },
    async readAllStoredEvents() {
      await reader.readNewEvents();
      return { events: [...allEvents] };
    },
  };
  logsReaders.set(context, reader);
  return reader;
}

async function readAllStoredEvents(context, extensionId) {
  return (await logsReaderFor(context, extensionId)).readAllStoredEvents();
}

// 默认 30 秒：无窗口模式下诊断批次可能经历一次 SW 唤醒重试才落库，10 秒会误报超时。
async function waitForStoredEvents(context, extensionId, predicate, timeout = 30000) {
  const reader = await logsReaderFor(context, extensionId);
  const deadline = Date.now() + timeout;
  for (;;) {
    await reader.readNewEvents();
    if (predicate(reader.events())) return { events: [...reader.events()] };
    if (Date.now() >= deadline) {
      throw new Error('等待 IndexedDB 日志条件超时');
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function createExportPage(context, extensionId, hash, options = {}) {
  const page = await context.newPage();
  await page.addInitScript(({ failAt, cancel }) => {
    const state = {
      lines: [],
      writes: 0,
      maxInFlight: 0,
      inFlight: 0,
      closed: false,
      aborted: false,
      release: false,
    };
    window.__exportState = state;
    window.showSaveFilePicker = async () => {
      if (cancel) throw new DOMException('user cancelled', 'AbortError');
      return {
        async createWritable() {
          return {
            async write(value) {
              state.writes += 1;
              state.inFlight += 1;
              state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
              try {
                while (state.release !== true && state.writes === 1) {
                  await new Promise((resolve) => setTimeout(resolve, 5));
                }
                if (failAt !== undefined && state.writes >= failAt) throw new Error('synthetic writer failure');
                state.lines.push(value);
              } finally {
                state.inFlight -= 1;
              }
            },
            async close() { state.closed = true; },
            async abort() { state.aborted = true; },
          };
        },
      };
    };
  }, options);
  await page.goto(`chrome-extension://${extensionId}/logs.html${hash}`, { waitUntil: 'domcontentloaded' });
  return page;
}

async function createBackgroundExtensionPage(context, launcher, url) {
  const [page] = await Promise.all([
    context.waitForEvent('page'),
    launcher.evaluate((nextUrl) => new Promise((resolve, reject) => {
      chrome.tabs.create({ url: nextUrl, active: false }, (tab) => {
        if (chrome.runtime.lastError !== undefined) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(tab.id);
      });
    }), url),
  ]);
  await page.waitForLoadState('domcontentloaded');
  return page;
}

async function clickExport(page) {
  await page.locator('[data-export]').click();
}

// 开关只能从 popup 页面本身切换：popup.html 开成标签页，操作它自己的复选框，
// 让真实的保存路径（change 事件 → chrome.storage.local）被完整执行。
// 每次自建一个 logs.html 启动页（tabs API 只在扩展页可用），用完即关。
async function togglePreferenceThroughPopup(context, extensionId, name, checked) {
  const launcher = await context.newPage();
  await launcher.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
  let popupPage;
  try {
    popupPage = await createBackgroundExtensionPage(context, launcher, `chrome-extension://${extensionId}/popup.html`);
  } finally {
    await launcher.close().catch(() => {});
  }
  try {
    const input = popupPage.locator(`input[data-preference="${name}"]`);
    await input.waitFor({ state: 'visible', timeout: 10000 });
    await input.setChecked(checked);
    const stored = await popupPage.evaluate(() => chrome.storage.local.get(null));
    const rendered = await input.isChecked();
    return { stored, rendered };
  } finally {
    await popupPage.close().catch(() => {});
  }
}

// 接管记录 = bank.serve 与 bank.fetch.chunk（README 的判定口径）。
// bank.inventory 是状态心跳，开关关闭时也照发（disabled: true），不算接管。
function assertNoBankRecords(sessionEvents) {
  assert.deepEqual(
    sessionEvents.filter((event) => ['bank.serve', 'bank.fetch.chunk'].includes(event.code)),
    [],
  );
}

function sessionEventsOf(events, sessionStartedEvent) {
  return events.filter((event) => event.sessionId === sessionStartedEvent?.sessionId);
}

const headed = parseHeadedFlag();
const chromeExecutablePath = await resolveChromeExecutablePath();
const cdpPort = await findAvailablePort();
const provenance = await readProvenance({ rootDirectory: root, extensionDirectory });
const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-e2e-profile-'));
const MAX_TAB_OPENS = 60;
const scenarios = [];
const markScenario = (name) => {
  scenarios.push(name);
  console.log('SCENARIO', name);
};
let context;
let extensionId;
let consoleCapture;
try {
  const launch = async (profile) => {
    const created = await chromium.launchPersistentContext(profile, {
      executablePath: chromeExecutablePath,
      cdpPort,
      headless: !headed,
      ignoreDefaultArgs: ['--disable-extensions'],
      args: [
        '--mute-audio',
        '--enable-unsafe-extension-debugging',
      ],
    });
    const originalNewPage = created.newPage.bind(created);
    let tabOpens = 0;
    created.newPage = async (...args) => {
      tabOpens += 1;
      if (tabOpens > MAX_TAB_OPENS) {
        throw new Error(`tab open ceiling exceeded (${MAX_TAB_OPENS} context.newPage() calls)`);
      }
      return originalNewPage(...args);
    };
    return created;
  };
  context = await launch(profileDirectory);
  const browserVersion = context.browser().version();
  console.log(`browser e2e provenance: ${JSON.stringify({
    commitSha: process.env.BILIBILI_E2E_COMMIT_SHA ?? provenance.commitSha,
    buildId: provenance.buildId,
    profileDirectory,
    browserVersion,
  })}`);
  extensionId = await installUnpackedExtension(context.browser(), extensionDirectory);
  consoleCapture = await startConsoleCapture(cdpPort, extensionId);
  await triggerExtensionPositiveControl(context, extensionId, consoleCapture);
  await context.addInitScript({ content: `(${silentAndAuditInit.toString()})()` });
  await context.addInitScript({ content: `(${autoOpenPopupLogs.toString()})()` });

  const videoPage = await openFixture(context, 'https://www.bilibili.com/video/BVfixture', videoFixture);
  await videoPage.evaluate(() => window.__fixture.start());
  await waitFor(videoPage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await videoPage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  await waitFor(videoPage, () => window.__fixture.calls.length === 1);
  assert.deepEqual(await videoPage.evaluate(() => window.__fixture.calls), [120]);
  assertNoForbiddenExtensionMediaWrites(await videoPage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  const videoEvents = await readAllStoredEvents(context, extensionId);
  const videoHint = videoEvents.events
    .filter((event) => event.code === 'video.buffer_hint.applied' && event.data?.targetSeconds === 120)
    .at(-1);
  assert.ok(videoHint);
  assert.equal(typeof videoHint.data.actualSeconds, 'number');
  assert.notEqual(videoHint.data.actualSeconds, videoHint.data.targetSeconds);
  markScenario('真实无音轨视频解码与 120 秒缓存');

  await videoPage.evaluate(() => window.__fixture.replace());
  await waitFor(videoPage, () => window.__fixture.calls.length === 2);
  assert.deepEqual(await videoPage.evaluate(() => window.__fixture.calls), [120, 120]);
  assertNoForbiddenExtensionMediaWrites(await videoPage.evaluate(() => window.__e2eAudit.extensionOwnership()));
  markScenario('视频 source/core generation replacement');
  await videoPage.close();

  const watchLaterPage = await openFixture(context, 'https://www.bilibili.com/list/watchlater/item-1', videoFixture);
  await watchLaterPage.evaluate(() => window.__fixture.start());
  await waitFor(watchLaterPage, () => window.__fixture.calls.length === 1 && window.__fixture.decodedFrames() > 0);
  await watchLaterPage.close();
  markScenario('Watch Later item route');

  const unrelatedPage = await openFixture(context, 'https://www.bilibili.com/search?keyword=fixture', videoFixture);
  await unrelatedPage.waitForTimeout(1000);
  assert.deepEqual(await unrelatedPage.evaluate(() => window.__fixture.calls), []);
  await unrelatedPage.close();
  markScenario('unrelated route remains untouched');

  const popupVideoPage = await openFixture(
    context,
    'https://www.bilibili.com/video/BVpopup-fixture',
    videoFixture,
    inventoryRequestHandler,
  );
  await popupVideoPage.evaluate(() => window.__fixture.start());
  await waitFor(popupVideoPage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.ok((await popupVideoPage.evaluate(() => window.__e2eAudit.silence())).every(({ muted, volume }) => muted && volume === 0));
  const popupLauncher = await context.newPage();
  await popupLauncher.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
  const pagesBeforeLogsTab = new Set(context.pages());
  // 无窗口模式下 tabs.create 之后新标签即成为活动标签：先把 popup 开成后台标签，
  // 再把视频页带回前台，popup 的 500ms 轮询才能读到视频页状态。
  const popupPage = await createBackgroundExtensionPage(
    context,
    popupLauncher,
    `chrome-extension://${extensionId}/popup.html?e2e-open-logs`,
  );
  await popupVideoPage.bringToFront();
  // tabs.create 的目标在建时还停在 about:blank，waitForEvent(page) 的 URL 谓词
  // 会错过它；轮询 context.pages() 等这个新标签导航到 logs.html。
  const videoLogsPage = await (async () => {
    const deadline = Date.now() + 30000;
    for (;;) {
      const candidate = context.pages()
        .find((page) => !pagesBeforeLogsTab.has(page) && page.url().includes('/logs.html'));
      if (candidate !== undefined) return candidate;
      if (Date.now() >= deadline) throw new Error('popup 打开的日志页标签没有出现');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  })();
  await videoLogsPage.waitForLoadState('domcontentloaded');
  assert.equal(await popupPage.evaluate(() => window.__e2ePopupLogsClicked), true);
  assert.equal(await popupPage.locator('[data-open-logs]').count(), 1);
  assert.equal(await popupPage.locator('[data-preference="vodEnabled"]:visible').count(), 1);
  assert.deepEqual(
    await popupPage.locator('[data-status-field]:visible').evaluateAll((elements) =>
      elements.map((element) => element.dataset.statusField)),
    ['state'],
  );
  const videoSessionId = (await readAllStoredEvents(context, extensionId)).events
    .find((event) => event.code === 'route.session_started' && event.data?.pathname === '/video/BVpopup-fixture')?.sessionId;
  assert.equal(typeof videoSessionId, 'string');
  const inventoryFixture = await popupVideoPage.evaluate(() => window.__fixture.populateBankInventory());
  assert.equal(inventoryFixture.advertised.length, INVENTORY_ADVERTISED_REPRESENTATION_COUNT);
  assert.deepEqual(inventoryFixture.requested.sort(), [INVENTORY_AUDIO_PATH, INVENTORY_VIDEO_PATH].sort());
  const inventoryEvents = await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.some((event) => event.code === 'bank.inventory'
      && event.sessionId === videoSessionId
      && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_VIDEO_PATH
        && resource.kind === 'video'
        && resource.active === true)
      && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_AUDIO_PATH
        && resource.kind === 'audio'
        && resource.active === true)
      && !event.data.resources.some((resource) => resource.pathname === INVENTORY_ADDRESS_BOOK_ONLY_PATH)),
  );
  const inventoryEvent = inventoryEvents.events.find(
    (event) => event.code === 'bank.inventory'
      && event.sessionId === videoSessionId
      && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_VIDEO_PATH
        && resource.kind === 'video'
        && resource.active === true)
      && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_AUDIO_PATH
        && resource.kind === 'audio'
        && resource.active === true)
      && !event.data.resources.some((resource) => resource.pathname === INVENTORY_ADDRESS_BOOK_ONLY_PATH),
  );
  assert.equal(typeof inventoryEvent.data.sessionGeneration, 'number');
  assert.equal(Array.isArray(inventoryEvent.data.resources), true);
  assert.equal(inventoryEvent.data.resources.length, 2);
  assert.equal(inventoryEvent.data.resources.some((resource) => resource.pathname === INVENTORY_VIDEO_PATH), true);
  assert.equal(inventoryEvent.data.resources.some((resource) => resource.pathname === INVENTORY_AUDIO_PATH), true);
  assert.equal(inventoryEvent.data.resources.some((resource) => resource.pathname === INVENTORY_ADDRESS_BOOK_ONLY_PATH), false);
  const cdnSummary = await extensionSend(popupLauncher, {
    version: 1,
    type: 'logs:cdn-summary',
    sessionId: videoSessionId,
  });
  assert.equal(cdnSummary.ok, true);
  assert.equal(cdnSummary.sampleCount > 0, true);
  assert.equal(cdnSummary.maxEventId >= inventoryEvent.eventId, true);
  assert.deepEqual(Object.keys(cdnSummary.summary.byResult).sort(), [
    'aborted',
    'fetched',
    'gave_up',
    'http_error',
    'invalid_response',
    'lost_race',
    'network_error',
    'stalled',
    'superseded',
  ]);
  await popupVideoPage.evaluate(() => window.__fixture.activateReadoutVideo());
  await waitFor(popupVideoPage, () => {
    const raw = document.documentElement.getAttribute('data-bilibili-buffer-shim-diagnostics');
    return raw !== null && JSON.parse(raw).sourceBufferRanges.some((track) => track.attached === true);
  });
  // 媒体记录器跟随最大 video 元素（reconcile 每 500ms 一拍）：等它真正切到
  // readout video（video.replaced），后面的 media.ended 才一定落在被记录的元素上。
  await waitForStoredEvents(context, extensionId, (events) => events.some((event) =>
    event.code === 'video.replaced' && event.sessionId === videoSessionId));
  await popupVideoPage.bringToFront();
  const readouts = await extensionTabSend(popupLauncher, {
    version: STATUS_MESSAGE_VERSION,
    type: 'readouts:get',
  });
  assert.equal(readouts.version, READOUTS_VERSION);
  assert.equal(readouts.diagnostics.sessionId, videoSessionId);
  assert.equal(readouts.routeKind, 'video');
  assert.equal(Number.isFinite(readouts.forwardSeconds), true);
  assert.doesNotMatch(JSON.stringify(readouts), /blob:|[?#]/);
  assert.equal(
    videoLogsPage.url(),
    `chrome-extension://${extensionId}/logs.html#sessionId=${encodeURIComponent(videoSessionId)}`,
  );
  await videoLogsPage.close();
  await popupPage.close();
  await popupLauncher.close();
  markScenario('video popup and video session log URL');

  const currentExport = await createExportPage(context, extensionId, `#sessionId=${encodeURIComponent(videoSessionId)}`);
  await clickExport(currentExport);
  await currentExport.evaluate(() => { window.__exportState.release = true; });
  await waitFor(currentExport, () => document.querySelector('[data-status]').textContent.includes('导出完成'));
  const currentExportState = await currentExport.evaluate(() => ({ ...window.__exportState }));
  assert.equal(currentExportState.closed, true);
  assert.equal(currentExportState.aborted, false);
  assert.equal(currentExportState.maxInFlight, 1);
  assert.ok(currentExportState.lines.every((line) => line.endsWith('\n')));
  assert.ok(currentExportState.lines.every((line) => JSON.parse(line).sessionId === videoSessionId));
  await currentExport.close();
  markScenario('日志 current snapshot export is paged and line-awaited');

  const snapshotExport = await createExportPage(context, extensionId, '');
  await clickExport(snapshotExport);
  await waitFor(snapshotExport, () => window.__exportState.writes >= 1);
  const endedCountBefore = (await readAllStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'media.ended').length;
  await popupVideoPage.evaluate(() => window.__fixture.triggerUniqueMediaEvent());
  await waitForStoredEvents(
    context,
    extensionId,
    (events) => events.filter((event) => event.code === 'media.ended').length > endedCountBefore,
  );
  await snapshotExport.evaluate(() => { window.__exportState.release = true; });
  await waitFor(snapshotExport, () => document.querySelector('[data-status]').textContent.includes('导出完成'));
  const snapshotLines = await snapshotExport.evaluate(() => window.__exportState.lines.map((line) => JSON.parse(line)));
  assert.equal(snapshotLines.some((record) => record.code === 'media.ended'), false);
  await snapshotExport.close();
  markScenario('日志 all export fixes eventId cutoff and excludes new events');

  const cancelledExport = await createExportPage(context, extensionId, '', { cancel: true });
  await clickExport(cancelledExport);
  await waitFor(cancelledExport, () => document.querySelector('[data-status]').textContent.includes('导出已取消'));
  await cancelledExport.close();
  markScenario('日志 export user cancellation');

  const failedExport = await createExportPage(context, extensionId, '', { failAt: 1 });
  await clickExport(failedExport);
  await failedExport.evaluate(() => { window.__exportState.release = true; });
  await waitFor(failedExport, () => document.querySelector('[data-status]').textContent.includes('导出失败'));
  assert.equal(await failedExport.evaluate(() => window.__exportState.aborted), true);
  await failedExport.close();
  markScenario('日志 writer failure aborts the file');

  const exportedEvents = (await readAllStoredEvents(context, extensionId)).events;
  const eventCounts = Object.fromEntries(
    [...new Set(exportedEvents.map((event) => event.code))]
      .sort()
      .map((code) => [code, exportedEvents.filter((event) => event.code === code).length]),
  );
  const reportDirectory = path.join(root, 'reports');
  await fs.mkdir(reportDirectory, { recursive: true });
  await fs.writeFile(
    path.join(reportDirectory, 'browser-e2e-events.jsonl'),
    `${exportedEvents.map((event) => JSON.stringify({ recordType: 'event', ...event })).join('\n')}\n`,
    'utf8',
  );
  console.log(`browser e2e event counts: ${JSON.stringify(eventCounts)}`);
  const measuredInventoryEvents = exportedEvents.filter((event) =>
    event.code === 'bank.inventory' && event.sessionId === videoSessionId);
  assert.ok(measuredInventoryEvents.length > 0);
  const averageInventoryLineBytes = measuredInventoryEvents.reduce((total, event) => total
    + Buffer.byteLength(`${JSON.stringify({ recordType: 'event', ...event })}\n`, 'utf8'), 0)
    / measuredInventoryEvents.length;
  const measuredInventoryEvent = measuredInventoryEvents.find((event) =>
    event.data?.resources?.some((resource) => resource.pathname === INVENTORY_VIDEO_PATH)
    && event.data?.resources?.some((resource) => resource.pathname === INVENTORY_AUDIO_PATH));
  assert.ok(measuredInventoryEvent);
  console.log(`bank.inventory volume: run=browser-e2e popupVideoPage session=${videoSessionId}`
    + ` averageUtf8JsonlBytes=${averageInventoryLineBytes}`
    + ` advertisedRepresentations=${INVENTORY_ADVERTISED_REPRESENTATION_COUNT}`
    + ` admittedResources=${measuredInventoryEvent.data.resources.length}`);

  await popupVideoPage.close();

  // ---- 直播 HLS 分片接管（夹具无配对地址 → 播放器所名地址单腿） ----
  const liveTakeoverPage = await openFixture(
    context,
    'https://live.bilibili.com/6-e2e-live',
    liveFixture,
    liveRequestHandler,
  );
  await waitFor(liveTakeoverPage, () => window.__liveFixture === undefined
    ? false
    : window.__liveFixture.responses.length >= 1);
  assert.ok((await liveTakeoverPage.evaluate(() => window.__liveFixture.responses))
    .some((response) => response.status === 206 && response.bytes === LIVE_SEGMENT_TOTAL_SIZE),
    JSON.stringify(await liveTakeoverPage.evaluate(() => window.__liveFixture)));
  const liveTakeoverServe = (await waitForStoredEvents(context, extensionId, (events) => events.some((event) =>
    event.code === 'bank.serve' && event.data?.result === 'hit'
    && String(event.data?.reason ?? '').startsWith('live_hls')))).events
    .filter((event) => event.code === 'bank.serve' && event.data?.result === 'hit'
      && String(event.data?.reason ?? '').startsWith('live_hls')).at(-1);
  const liveTakeoverSessionEvents = (await readAllStoredEvents(context, extensionId)).events
    .filter((event) => event.sessionId === liveTakeoverServe.sessionId);
  assert.ok(liveTakeoverSessionEvents.some((event) => event.code === 'route.session_started'
    && event.data?.routeKind === 'live' && event.data?.pathname === '/6-e2e-live'));
  assert.ok(liveTakeoverSessionEvents.some((event) => event.code === 'bank.fetch.chunk'
    && event.data?.slot !== undefined));
  assertNoForbiddenExtensionMediaWrites(
    await liveTakeoverPage.evaluate(() => window.__e2eAudit.extensionOwnership()),
  );
  markScenario('直播 HLS 分片单腿接管');
  await liveTakeoverPage.close();

  // ---- 视频增强开关关闭：popup 页面本身切换，保存路径真实执行 ----
  const vodOffToggle = await togglePreferenceThroughPopup(context, extensionId, 'vodEnabled', false);
  assert.equal(vodOffToggle.stored.vodEnabled, false);
  assert.equal(vodOffToggle.rendered, false);
  const vodOffPage = await openFixture(
    context,
    'https://www.bilibili.com/video/BVswitch-vod-off',
    videoFixture,
    inventoryRequestHandler,
  );
  await vodOffPage.evaluate(() => window.__fixture.start());
  await waitFor(vodOffPage, () => window.__fixture.decodedFrames() > 0 && window.__fixture.decodedNonBlack());
  assert.deepEqual(await vodOffPage.evaluate(() => window.__fixture.calls), []);
  const vodOffSessionEvent = (await waitForStoredEvents(context, extensionId, (events) => events.some((event) =>
    event.code === 'route.session_started' && event.data?.pathname === '/video/BVswitch-vod-off'
    && events.some((inner) => inner.sessionId === event.sessionId && inner.code === 'media.sample'
      && Number.isFinite(inner.data?.currentTime) && inner.data.currentTime > 0)))).events
    .filter((event) => event.code === 'route.session_started' && event.data?.pathname === '/video/BVswitch-vod-off')
    .at(-1);
  const vodOffSessionEvents = sessionEventsOf(
    (await readAllStoredEvents(context, extensionId)).events,
    vodOffSessionEvent,
  );
  assertNoBankRecords(vodOffSessionEvents);
  assert.ok(vodOffSessionEvents.some((event) => event.code === 'preference.read'
    && event.data?.name === 'vodEnabled' && event.data?.enabled === false));
  const vodOffSampleTimes = vodOffSessionEvents
    .filter((event) => event.code === 'media.sample')
    .map((event) => event.data?.currentTime)
    .filter((time) => Number.isFinite(time));
  assert.ok(vodOffSampleTimes.length >= 2 && vodOffSampleTimes.at(-1) > vodOffSampleTimes[0],
    JSON.stringify(vodOffSampleTimes));
  markScenario('视频增强关闭：视频照常播放，下载层让路，无接管记录');
  await vodOffPage.close();

  // 同一 profile 里直播页不受视频开关影响：仍接管。
  const liveOnVodOffPage = await openFixture(
    context,
    'https://live.bilibili.com/6-e2e-live-vod-off',
    liveFixture,
    liveRequestHandler,
  );
  await waitForStoredEvents(context, extensionId, (events) => events.some((event) =>
    event.code === 'route.session_started' && event.data?.pathname === '/6-e2e-live-vod-off'
    && events.some((inner) => inner.sessionId === event.sessionId
      && inner.code === 'bank.serve' && inner.data?.result === 'hit')));
  markScenario('视频增强关闭时直播页仍接管');
  await liveOnVodOffPage.close();

  const vodOnToggle = await togglePreferenceThroughPopup(context, extensionId, 'vodEnabled', true);
  assert.equal(vodOnToggle.stored.vodEnabled, true);
  const vodOnPage = await openFixture(
    context,
    'https://www.bilibili.com/video/BVswitch-vod-on',
    videoFixture,
    inventoryRequestHandler,
  );
  await vodOnPage.evaluate(() => window.__fixture.start());
  await waitFor(vodOnPage, () => window.__fixture.calls.length === 1);
  assert.deepEqual(await vodOnPage.evaluate(() => window.__fixture.calls), [120]);
  const vodOnInventory = await vodOnPage.evaluate(() => window.__fixture.populateBankInventory());
  assert.equal(vodOnInventory.advertised.length, INVENTORY_ADVERTISED_REPRESENTATION_COUNT);
  await waitForStoredEvents(context, extensionId, (events) => events.some((event) =>
    event.code === 'route.session_started' && event.data?.pathname === '/video/BVswitch-vod-on'
    && events.some((inner) => inner.sessionId === event.sessionId && inner.code === 'bank.fetch.chunk')));
  markScenario('视频增强恢复开启：120 秒缓存目标与分片接管恢复');
  await vodOnPage.close();

  // ---- 直播增强开关关闭：镜像场景 ----
  const liveOffToggle = await togglePreferenceThroughPopup(context, extensionId, 'liveEnabled', false);
  assert.equal(liveOffToggle.stored.liveEnabled, false);
  assert.equal(liveOffToggle.rendered, false);
  const liveOffPage = await openFixture(
    context,
    'https://live.bilibili.com/6-e2e-live-off',
    liveFixture,
    liveRequestHandler,
  );
  await waitFor(liveOffPage, () => window.__liveFixture.responses.length + window.__liveFixture.errors.length >= 3);
  await waitForStoredEvents(context, extensionId, (events) => events.some((event) =>
    event.code === 'route.session_started' && event.data?.pathname === '/6-e2e-live-off'
    && events.some((inner) => inner.sessionId === event.sessionId
      && (inner.code === 'media.sample' || inner.code === 'route.no_video'))), 15000)
    .catch(() => { /* 无 video 的直播夹具可能只留下 session 与 no_video 记录 */ });
  const liveOffSessionEvent = (await readAllStoredEvents(context, extensionId)).events
    .filter((event) => event.code === 'route.session_started' && event.data?.pathname === '/6-e2e-live-off')
    .at(-1);
  assert.ok(liveOffSessionEvent);
  const liveOffSessionEvents = sessionEventsOf(
    (await readAllStoredEvents(context, extensionId)).events,
    liveOffSessionEvent,
  );
  assertNoBankRecords(liveOffSessionEvents);
  assert.ok(liveOffSessionEvents.some((event) => event.code === 'preference.read'
    && event.data?.name === 'liveEnabled' && event.data?.enabled === false));
  markScenario('直播增强关闭：分片原生放行，无接管记录');
  await liveOffPage.close();

  // 同一 profile 里视频页不受直播开关影响：仍接管。
  const videoOnLiveOffPage = await openFixture(
    context,
    'https://www.bilibili.com/video/BVswitch-live-off',
    videoFixture,
    inventoryRequestHandler,
  );
  await videoOnLiveOffPage.evaluate(() => window.__fixture.start());
  await waitFor(videoOnLiveOffPage, () => window.__fixture.calls.length === 1);
  assert.deepEqual(await videoOnLiveOffPage.evaluate(() => window.__fixture.calls), [120]);
  const liveOffInventory = await videoOnLiveOffPage.evaluate(() => window.__fixture.populateBankInventory());
  assert.equal(liveOffInventory.advertised.length, INVENTORY_ADVERTISED_REPRESENTATION_COUNT);
  await waitForStoredEvents(context, extensionId, (events) => events.some((event) =>
    event.code === 'route.session_started' && event.data?.pathname === '/video/BVswitch-live-off'
    && events.some((inner) => inner.sessionId === event.sessionId && inner.code === 'bank.fetch.chunk')));
  markScenario('直播增强关闭时视频页仍接管');
  await videoOnLiveOffPage.close();

  const liveOnToggle = await togglePreferenceThroughPopup(context, extensionId, 'liveEnabled', true);
  assert.equal(liveOnToggle.stored.liveEnabled, true);
  const liveOnAgainPage = await openFixture(
    context,
    'https://live.bilibili.com/6-e2e-live-on',
    liveFixture,
    liveRequestHandler,
  );
  await waitForStoredEvents(context, extensionId, (events) => events.some((event) =>
    event.code === 'route.session_started' && event.data?.pathname === '/6-e2e-live-on'
    && events.some((inner) => inner.sessionId === event.sessionId
      && inner.code === 'bank.serve' && inner.data?.result === 'hit')));
  markScenario('直播增强恢复开启：分片接管恢复');
  await liveOnAgainPage.close();

  const consoleVerdict = consoleCapture.verdict();
  const extensionConsoleErrors = consoleCapture.events.filter((event) =>
    event.kind === 'console'
    && event.level === 'error'
    && event.source === 'extension'
    && event.positiveControl !== true);
  const expectedConsoleErrors = extensionConsoleErrors.filter((event) =>
    event.text.includes('AbortError: user cancelled')
    || event.text.includes('synthetic writer failure'));
  const unexpectedConsoleErrors = extensionConsoleErrors.filter(
    (event) => !expectedConsoleErrors.includes(event),
  );
  assert.equal(consoleVerdict.positiveControlCaptured, true, JSON.stringify(consoleVerdict));
  assert.deepEqual(unexpectedConsoleErrors, [], JSON.stringify({ consoleVerdict, unexpectedConsoleErrors }));
  console.log(`browser e2e console classification: ${JSON.stringify({
    consoleVerdict,
    expectedConsoleErrors: expectedConsoleErrors.map(({ text, targetUrl }) => ({ text, targetUrl })),
    unexpectedConsoleErrors,
  })}`);
  await consoleCapture.close();
  consoleCapture = undefined;
  await context.close();
  context = await launch(profileDirectory);
  await context.addInitScript({ content: `(${silentAndAuditInit.toString()})()` });
  extensionId = await installUnpackedExtension(context.browser(), extensionDirectory);
  const stored = await readAllStoredEvents(context, extensionId);
  assert.ok(stored.events.some((event) => event.code === 'route.session_started'));
  markScenario('extension worker/browser restart reads persisted IndexedDB logs');

  console.log(`browser e2e passed: ${scenarios.length} deterministic scenes`);
  for (const scenario of scenarios) console.log(`- ${scenario}`);
} finally {
  await consoleCapture?.close();
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}
