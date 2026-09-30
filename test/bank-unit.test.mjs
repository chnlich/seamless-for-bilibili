import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BANK_CONFIG, LIVE_FLV_BACKUP_CONFIG } from '../src/constants.js';
import {
  BANK_ENABLED_ATTRIBUTE,
  BANK_MESSAGE_NAMESPACE,
  isBankDiagnosticMessage,
  postBankControl,
} from '../src/bank/contract.js';
import {
  bankKey,
  cacheKey,
  classifyRequest,
  parseContentRange,
  parseRangeHeader,
  partialResponseHeaders,
  planFetchRanges,
  selectEvictions,
} from '../src/bank/logic.js';
import { BankFallbackError } from '../src/bank/errors.js';
import { createRouteIdentity } from '../src/diagnostics/client.js';
import {
  enforceMemoryLimit,
  readMemoryRange,
  totalMemoryBytes,
  writeMemoryChunk,
} from '../src/bank/storage.js';
import { SegmentBank } from '../src/bank/main.js';
import { createBankXMLHttpRequestClass } from '../src/bank/xhr.js';
import {
  FlvSegmentRebuilder,
  FlvTagReader,
  FlvUnsupportedError,
  buildFragment,
  crc32,
  parseBiliPlaylist,
  parseMediaSegment,
  planSegment,
} from '../src/bank/flv-rebuild.js';
import {
  LiveStreamStitcher,
  classifyLiveRequest,
  compareSegmentBytes,
  hlsStreamPathOf,
  isLiveLocation,
  liveUrlExpiresAt,
  urlFromLiveUrlInfo,
  visitLiveUrlInfoGroups,
} from '../src/bank/live.js';

const MEDIA_URL = 'https://upos-sz-mirrorcosov.bilivideo.com/video/track.m4s?deadline=secret&upsig=secret';
const PAIR_URL = 'https://upos-hz-mirrorakam.akamaized.net/video/track.m4s?deadline=pair&upsig=pair';
const MEDIA_KEY = '/video/track.m4s';
const PLAYURL_URL = 'https://api.bilibili.com/x/player/wbi/playurl?bvid=secret';
const LIVE_LOCATION = new URL('https://live.bilibili.com/21452505');
const LIVE_URL = 'https://d1--ov-gotcha07.bilivideo.com/live-bvc/1/stream.flv?expires=4102444800&sign=main';
const LIVE_PAIR_URL = 'https://d1--ov-gotcha07b.bilivideo.com/live-bvc/1/stream.flv?expires=4102444800&sign=backup';
const LIVE_HLS_URL = 'https://d1--ov-gotcha105.bilivideo.com/live-bvc/1/index.m3u8?expires=4102444800&sign=hls';
const LIVE_KEY = '/live-bvc/1/stream.flv';
const LIVE_PLAYURL_URL = 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=21452505&protocol=0';
const HLS_STREAM_DIR = '/live-bvc/791488/live_i9bl9s_SIPAZ9L_1b53ey_4000/';
const HLS_MAIN_PLAYLIST = `https://d1--ov-gotcha105.bilivideo.com${HLS_STREAM_DIR}index.m3u8?expires=4102444800&sign=hls105`;
const HLS_BACKUP_PLAYLIST = `https://d1--ov-gotcha105b.bilivideo.com${HLS_STREAM_DIR}index.m3u8?expires=4102444800&sign=hls105b`;
const HLS_SEGMENT_URL = `https://d1--ov-gotcha207.bilivideo.com${HLS_STREAM_DIR}423384050.m4s?expires=4102444800&sign=seg207`;
const HLS_SEGMENT_INIT_URL = `https://d1--ov-gotcha207.bilivideo.com${HLS_STREAM_DIR}423384050_init.m4s?expires=4102444800&sign=seg207`;
const HLS_SEGMENT_ON_MAIN_URL = `https://d1--ov-gotcha105.bilivideo.com${HLS_STREAM_DIR}423384050.m4s?expires=4102444800&sign=segmain`;
const HLS_SEGMENT_NEXT_URL = `https://d1--ov-gotcha207.bilivideo.com${HLS_STREAM_DIR}423384051.m4s?expires=4102444800&sign=seg207`;
const HLS_SEGMENT_PAIR_FOR_PLAYER = `https://d1--ov-gotcha105.bilivideo.com${HLS_STREAM_DIR}423384050.m4s?expires=4102444800&sign=hls105`;
const HLS_SEGMENT_PAIR_FOR_MAIN = `https://d1--ov-gotcha105b.bilivideo.com${HLS_STREAM_DIR}423384050.m4s?expires=4102444800&sign=hls105b`;
const HLS_PLAYURL_BODY = liveUrlInfoBody(
  [liveUrlInfoEntry(HLS_MAIN_PLAYLIST), liveUrlInfoEntry(HLS_BACKUP_PLAYLIST)],
  `${HLS_STREAM_DIR}index.m3u8?`,
);

function playurlBody(baseUrl = MEDIA_URL, backupUrl = [PAIR_URL]) {
  return {
    data: {
      dash: {
        video: [{ baseUrl, backupUrl }],
      },
    },
  };
}

function responseFor(start, end, totalSize = 100, body = new Uint8Array(end - start + 1), options = {}) {
  return new Response(body, {
    status: options.status || 206,
    statusText: options.statusText || 'Partial Content',
    headers: options.headers || {
      'Content-Range': `bytes ${start}-${end}/${totalSize}`,
      'Content-Length': String(body.byteLength),
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
    },
  });
}

function rangeFromInit(init) {
  return parseRangeHeader(init.headers.Range || init.headers.get('Range'));
}

function manualTimers() {
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(callback, milliseconds) {
      const id = ++nextId;
      pending.set(id, { callback, milliseconds });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    fire(milliseconds) {
      for (const [id, timer] of [...pending]) {
        if (timer.milliseconds !== milliseconds) continue;
        pending.delete(id);
        timer.callback();
      }
    },
    fireId(id) {
      const timer = pending.get(id);
      pending.delete(id);
      timer.callback();
    },
    pending,
  };
}

function windowFixture({ timers, location = new URL('https://www.bilibili.com/video/BVbank') } = {}) {
  const listeners = new Map();
  const realTimers = new Set();
  const messages = [];
  const attributes = new Map();
  return {
    location,
    Response,
    Event,
    Blob,
    performance: { now: () => Date.now() },
    document: {
      querySelectorAll: () => [],
      documentElement: { getAttribute: (name) => attributes.get(name) },
    },
    attributes,
    messages,
    setInterval() { return 1; },
    clearInterval() {},
    setTimeout(callback, milliseconds) {
      if (timers !== undefined) return timers.setTimeout(callback, milliseconds);
      const timer = setTimeout(callback, milliseconds);
      realTimers.add(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timers !== undefined) return timers.clearTimeout(timer);
      realTimers.delete(timer);
      clearTimeout(timer);
    },
    addEventListener(type, listener) {
      const set = listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener(type, listener) { listeners.get(type)?.delete(listener); },
    postMessage(message, _origin, transfer) {
      messages.push(message);
      for (const listener of listeners.get('message') || []) {
        listener({ source: this, data: message, transfer });
      }
    },
  };
}

function configFor(overrides = {}) {
  return {
    ...BANK_CONFIG,
    chunkBytes: 16,
    maxBankBytes: 64,
    stallMs: 10,
    lookAheadChunks: 3,
    maxChunkAttempts: 3,
    ...overrides,
  };
}

function bytesFor(start, end) {
  return Uint8Array.from({ length: end - start + 1 }, (_value, index) => (start + index) % 251);
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

function createBank({
  nativeFetch,
  config = BANK_CONFIG,
  maxPrefetchConcurrency = 2,
  chunks,
  timers,
  now,
  playinfo,
  location,
  enabled = true,
  attributeUnset = false,
} = {}) {
  const windowObject = windowFixture({ timers, location });
  // 默认模拟 controller 已读到开关并写入接管标记；attributeUnset 表示标记不存在，
  // 对应 controller 还没读到开关值的窗口（下载层让路）。
  if (!attributeUnset) {
    windowObject.attributes.set(BANK_ENABLED_ATTRIBUTE, enabled === true ? 'true' : 'false');
  }
  if (playinfo !== undefined) windowObject.__playinfo__ = playinfo;
  const calls = [];
  const fetchFunction = nativeFetch || (async (url, init) => {
    const range = rangeFromInit(init);
    calls.push({ url, init, range });
    return responseFor(range.start, range.end, 100, bytesFor(range.start, range.end));
  });
  const bank = new SegmentBank({
    windowObject,
    nativeFetch: fetchFunction,
    config,
    maxPrefetchConcurrency,
    chunks,
    now,
  });
  return { bank, windowObject, calls };
}

async function fetchThrough(
  bank,
  input = MEDIA_URL,
  init = { headers: { Range: 'bytes=0-9' } },
  originalFetch,
) {
  return bank.handleFetch(
    bank.windowObject,
    [input, init],
    originalFetch || bank.nativeFetch,
  );
}

function putChunk(bank, index, config = bank.config, totalSize = 100) {
  const start = index * config.chunkBytes;
  const end = Math.min(start + config.chunkBytes - 1, totalSize - 1);
  bank.chunks.set(cacheKey(MEDIA_KEY, index), {
    bytes: bytesFor(start, end).buffer,
    totalSize,
    storedAt: index + 1,
  });
  return { start, end, cacheKey: cacheKey(MEDIA_KEY, index) };
}

test('bank keys discard query and mirror host changes share the same path key', () => {
  assert.equal(bankKey(MEDIA_URL), MEDIA_KEY);
  assert.equal(bankKey('https://upos-hz-mirrorakam.akamaized.net/video/track.m4s?deadline=other'), MEDIA_KEY);
  assert.equal(cacheKey(MEDIA_KEY, 3), `${MEDIA_KEY}#3`);
});

test('closed single Range and video media hosts are the only intercepted shape', () => {
  const locationObject = new URL('https://www.bilibili.com/video/BVbank');
  assert.deepEqual(parseRangeHeader('bytes=4-9'), { start: 4, end: 9 });
  for (const value of ['bytes=4-', 'bytes=4-9,20-30', 'bytes=9-4', undefined]) {
    assert.equal(parseRangeHeader(value), undefined);
  }
  assert.deepEqual(classifyRequest({
    url: MEDIA_URL,
    headers: { Range: 'bytes=4-9' },
    locationObject,
  }).range, { start: 4, end: 9 });
  assert.equal(classifyRequest({
    url: MEDIA_URL,
    headers: { Range: 'bytes=4-' },
    locationObject,
  }).reason, 'range_not_closed');
  assert.equal(classifyRequest({
    url: MEDIA_URL,
    headers: {},
    locationObject,
  }).reason, 'range_missing');
  assert.equal(classifyRequest({
    url: 'https://api.bilibili.com/video/track.m4s',
    headers: { Range: 'bytes=4-9' },
    locationObject,
  }).reason, 'non_media_host');
  assert.equal(classifyRequest({
    url: MEDIA_URL,
    headers: { Range: 'bytes=4-9' },
    enabled: false,
    locationObject,
  }).intercepted, false);
});

test('response headers, content-range parser, and fetch plans are exact', () => {
  assert.deepEqual(partialResponseHeaders(4, 9, 100), {
    'Accept-Ranges': 'bytes',
    'Content-Length': '6',
    'Content-Range': 'bytes 4-9/100',
    'Content-Type': 'video/mp4',
  });
  assert.deepEqual(parseContentRange('bytes 4-9/100'), { start: 4, end: 9, totalSize: 100 });
  assert.equal(parseContentRange('bytes 4-9/*'), undefined);
  assert.deepEqual(planFetchRanges(5, 20, {
    chunkBytes: 16,
    totalSize: 100,
    bankKeyValue: MEDIA_KEY,
  }), [
    { start: 0, end: 15, chunkIndex: 0, cacheKey: `${MEDIA_KEY}#0` },
    { start: 16, end: 31, chunkIndex: 1, cacheKey: `${MEDIA_KEY}#1` },
  ]);
  assert.deepEqual(planFetchRanges(4, 10, {
    chunkBytes: 16,
    totalSize: 100,
    bankKeyValue: MEDIA_KEY,
  }), [{
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }]);
});

test('control stays in the DOM boundary and diagnostic messages carry no binary payload', () => {
  const attributes = new Map();
  const windowObject = {
    document: {
      documentElement: {
        setAttribute(name, value) { attributes.set(name, value); },
      },
    },
  };
  postBankControl(windowObject, false);
  assert.equal(attributes.get(BANK_ENABLED_ATTRIBUTE), 'false');
  postBankControl(windowObject, true);
  assert.equal(attributes.get(BANK_ENABLED_ATTRIBUTE), 'true');
  assert.equal(isBankDiagnosticMessage({
    namespace: BANK_MESSAGE_NAMESPACE,
    direction: 'event',
    type: 'diagnostic',
    code: 'bank.serve',
    data: { result: 'hit' },
  }), true);
  assert.equal(isBankDiagnosticMessage({
    namespace: BANK_MESSAGE_NAMESPACE,
    direction: 'request',
    type: 'write-chunk',
  }), false);
});

test('before the preference arrives the bank takes over nothing, including the first media request', async () => {
  // attributeUnset 对应 controller 尚未读到开关、接管标记不存在的窗口。
  const { bank, windowObject, calls } = createBank({ attributeUnset: true });
  const nativeResponse = responseFor(4, 6, 100, bytesFor(4, 6));
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-6' } }, async () => nativeResponse);
  assert.equal(response, nativeResponse, '偏好未读到时媒体请求必须原样交给播放器');
  assert.deepEqual(calls, [], '让路窗口不得以扩展名义取数');
  assert.equal(windowObject.messages.length, 0, '让路窗口不产生接管诊断');
  assert.equal([...bank.chunks.keys()].length, 0, '让路窗口不缓存任何分片');
  bank.destroy();
});

test('a disabled switch stops takeover on its own page type and leaves the other untouched', async () => {
  const videoLocation = new URL('https://www.bilibili.com/video/BVbank');
  const liveLocation = new URL('https://live.bilibili.com/21452505');

  // 视频开关关闭：www 视频页的分片请求原样放行，不缓存、不竞速。
  const offVideo = createBank({ location: videoLocation, enabled: false });
  const videoNative = responseFor(4, 6, 100, bytesFor(4, 6));
  const videoResponse = await fetchThrough(offVideo.bank, MEDIA_URL, { headers: { Range: 'bytes=4-6' } }, async () => videoNative);
  assert.equal(videoResponse, videoNative);
  assert.equal(offVideo.windowObject.messages.length, 0);
  offVideo.bank.destroy();

  // 直播开关关闭：live 页的 FLV 流原样放行。
  const offLive = createBank({ location: liveLocation, enabled: false });
  const liveNative = new Response('native-live-bytes', { status: 200 });
  const liveResponse = await fetchThrough(offLive.bank, LIVE_URL, {}, async () => liveNative);
  assert.equal(liveResponse, liveNative);
  assert.equal(offLive.windowObject.messages.length, 0);
  offLive.bank.destroy();

  // 直播开关开启：同一请求被接管（双腿竞速开始）。
  const onLive = createBank({
    location: liveLocation,
    enabled: true,
    nativeFetch: async (url) => {
      if (String(url) === LIVE_URL) {
        return new Response(Uint8Array.from({ length: 48 }, (_v, i) => i), { status: 200 });
      }
      return new Response(Uint8Array.from({ length: 48 }, (_v, i) => i), { status: 200 });
    },
    timers: manualTimers(),
  });
  const takeoverResponse = await Promise.race([
    fetchThrough(onLive.bank, LIVE_URL, {}),
    new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 500)),
  ]);
  assert.notEqual(takeoverResponse, 'TIMEOUT');
  assert.notEqual(takeoverResponse, undefined);
  assert.equal(onLive.windowObject.messages.some((message) => message.code === 'bank.serve'), true);
  onLive.bank.destroy();
});

test('memory hit returns exact bytes and canonical response fields while refilling the window', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config });
  putChunk(bank, 0, config);
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-6' } });
  assert.equal(response.status, 206);
  assert.equal(response.statusText, 'Partial Content');
  assert.equal(response.url, new URL(MEDIA_URL).href);
  assert.equal(response.type, 'basic');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5, 6]);
  assert.equal(response.headers.get('Content-Range'), 'bytes 4-6/100');
  assert.equal(response.headers.get('Content-Length'), '3');
  assert.equal(response.headers.get('Accept-Ranges'), 'bytes');
  assert.equal(response.headers.get('Content-Type'), 'video/mp4');
  const serveDiagnostic = bank.windowObject.messages.find(
    (message) => message.code === 'bank.serve' && message.data.reason === 'stored_range',
  );
  assert.equal(serveDiagnostic.data.mirror, new URL(MEDIA_URL).hostname);
  assert.equal(typeof serveDiagnostic.data.durationMs, 'number');
  assert.equal(serveDiagnostic.data.durationMs >= 0, true);
  assert.deepEqual(calls.map(({ range }) => range), [
    { start: 16, end: 31 },
    { start: 32, end: 47 },
  ]);
});

test('a query-only route rewrite preserves stored chunks', async () => {
  const config = configFor();
  const { bank, windowObject, calls } = createBank({
    config,
    location: new URL('https://www.bilibili.com/video/BVbank/'),
  });
  putChunk(bank, 0, config);
  windowObject.location = new URL(
    'https://www.bilibili.com/video/BVbank/?vd_source=abc&spm_id_from=333.788',
  );

  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-6' } });

  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [4, 5, 6]);
  assert.equal(calls.some(({ range }) => range.start === 0), false);
  assert.equal(bank.windowObject.messages.some(
    (message) => message.code === 'bank.serve' && message.data.reason === 'stored_range',
  ), true);
  bank.destroy();
});

test('diagnostics and download layers share the route identity', () => {
  const locationObject = new URL(
    'https://www.bilibili.com/video/BVbank/?p=2&vd_source=abc',
  );
  const { bank } = createBank({ location: locationObject });

  assert.equal(bank.videoIdentity, JSON.stringify(createRouteIdentity(locationObject)));
  bank.destroy();
});

test('a cache miss is served by the extension fetch and never passes to the original fetch', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config });
  let originalCalls = 0;
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-11' } }, async () => {
    originalCalls += 1;
    return responseFor(4, 11, 100, bytesFor(4, 11));
  });
  assert.equal(originalCalls, 0);
  assert.deepEqual(calls[0].range, { start: 0, end: 15 });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytesFor(4, 11)]);
  assert.equal(bank.chunks.has(`${MEDIA_KEY}#0`), true);
  const state = bank.stateFor(MEDIA_KEY);
  assert.equal(state.videoKey, '/video/BVbank');
  assert.equal(state.latestUrl, new URL(MEDIA_URL).href);
  assert.equal(state.credentials, 'same-origin');
  assert.equal(state.lastForegroundStart, 4);
  assert.equal(state.lastForegroundEnd, 11);
  assert.equal(bank.windowObject.messages.some(
    (message) => message.code === 'bank.serve'
      && message.data.result === 'pass'
      && message.data.reason === 'miss',
  ), false);
});

test('a cache miss spanning chunks fetches each aligned chunk and serves the original Range', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config, maxPrefetchConcurrency: 2 });
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-20' } });
  assert.deepEqual(calls.slice(0, 2).map(({ range }) => range), [
    { start: 0, end: 15 },
    { start: 16, end: 31 },
  ]);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytesFor(4, 20)]);
  assert.equal(bank.chunks.has(`${MEDIA_KEY}#0`), true);
  assert.equal(bank.chunks.has(`${MEDIA_KEY}#1`), true);
});

test('a cache miss does not replace a stored chunk and only fetches the missing aligned chunk', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config });
  putChunk(bank, 0, config, 64);
  const original = bank.chunks.get(`${MEDIA_KEY}#0`).bytes;
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-20' } });
  assert.deepEqual(calls[0].range, { start: 16, end: 31 });
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytesFor(4, 20)]);
  assert.equal(bank.chunks.get(`${MEDIA_KEY}#0`).bytes, original);
});

test('the extension fetch learns totalSize from its own Content-Range response', async () => {
  const config = configFor();
  const { bank, calls } = createBank({ config });
  const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-11' } });
  assert.notEqual(response, undefined);
  assert.deepEqual(calls[0].range, { start: 0, end: 15 });
  assert.equal(bank.stateFor(MEDIA_KEY).totalSize, 100);
});

test('a missing Content-Range from extension fetch is an internal fallback without a native header tap', async () => {
  const config = configFor();
  const { bank } = createBank({
    config,
    nativeFetch: async () => new Response(bytesFor(0, 15), { status: 206 }),
  });
  let fallbackCalls = 0;
  const response = await fetchThrough(
    bank,
    MEDIA_URL,
    { headers: { Range: 'bytes=4-11' } },
    async () => {
      fallbackCalls += 1;
      return new Response('fallback', { status: 503 });
    },
  );
  assert.equal(fallbackCalls, 1);
  assert.equal(response.status, 503);
  assert.equal(bank.stateFor(MEDIA_KEY).totalSize, undefined);
});

test('open, multi-range, no-range and non-media fetches pass the original arguments before body consumption', async () => {
  const { bank } = createBank();
  const input = new Request('https://api.bilibili.com/data', { method: 'POST', body: 'body' });
  const init = { credentials: 'include', headers: { 'X-Test': 'keep' } };
  let received;
  let bodyUsedAtEntry;
  const original = async (...args) => {
    received = args;
    bodyUsedAtEntry = input.bodyUsed;
    return args[0].text();
  };
  assert.equal(await fetchThrough(bank, input, init, original), 'body');
  assert.equal(bodyUsedAtEntry, false);
  assert.equal(received[0], input);
  assert.equal(received[1], init);
  const passthrough = async (...args) => args;
  assert.deepEqual(await fetchThrough(bank, MEDIA_URL, {}, passthrough), [MEDIA_URL, {}]);
  assert.deepEqual(await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-' } }, passthrough), [
    MEDIA_URL,
    { headers: { Range: 'bytes=4-' } },
  ]);
  assert.deepEqual(await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=4-9,20-30' } }, passthrough), [
    MEDIA_URL,
    { headers: { Range: 'bytes=4-9,20-30' } },
  ]);
});

test('a cross-chunk foreground request anchors on its smaller chunk and keeps it wanted', async () => {
  const config = configFor({ stallMs: 1000 });
  let release;
  const { bank } = createBank({
    config,
    maxPrefetchConcurrency: 1,
    nativeFetch: async (_url, init) => new Promise((resolve, reject) => {
      release = () => resolve(responseFor(0, 15, 64, bytesFor(0, 15)));
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.lastForegroundStart = 20;
  state.lastForegroundEnd = 20;
  bank.touchResource(MEDIA_KEY);
  const pending = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const request = { start: 4, end: 20 };
  state.outstanding.add(request);
  await bank.prefetch();
  assert.equal(bank.anchorChunkForState(state), 0);
  assert.equal(bank.inflight.get(`${MEDIA_KEY}#0`).controller.signal.aborted, false);
  release();
  await pending;
  bank.destroy();
});

test('a cache hit supersedes an in-flight chunk before its new anchor', async () => {
  const config = configFor({ stallMs: 1000 });
  const { bank, windowObject } = createBank({
    config,
    maxPrefetchConcurrency: 1,
    nativeFetch: async (_url, init) => {
      const range = rangeFromInit(init);
      if (range.start !== 0) {
        return responseFor(range.start, range.end, 64, bytesFor(range.start, range.end));
      }
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  putChunk(bank, 2, config, 64);
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.lastForegroundStart = 0;
  state.lastForegroundEnd = 0;
  bank.touchResource(MEDIA_KEY);
  const pending = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const firstTask = bank.inflight.get(`${MEDIA_KEY}#0`);

  await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=32-39' } });

  assert.equal(bank.anchorChunkForState(state), 2);
  assert.equal(firstTask.controller.signal.aborted, true);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(windowObject.messages.some(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'superseded',
  ), true);
  bank.destroy();
});

test('the default prefetch concurrency is four', () => {
  const bank = new SegmentBank({ windowObject: windowFixture() });
  assert.equal(bank.maxPrefetchConcurrency, 4);
  bank.destroy();
});

test('default prefetch concurrency runs four active tasks and queues a fifth', async () => {
  const config = configFor({ raceLegs: 1, stallMs: 1000 });
  const pending = new Map();
  const bank = new SegmentBank({
    windowObject: windowFixture(),
    config,
    nativeFetch: async (_url, init) => {
      const range = rangeFromInit(init);
      return new Promise((resolve, reject) => {
        pending.set(`${range.start}-${range.end}`, { resolve, reject });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const tasks = [0, 16, 32, 48, 64].map((start) => bank.getTask({
    start,
    end: start + 15,
    chunkIndex: start / 16,
    cacheKey: `${MEDIA_KEY}#${start / 16}`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  }));
  await tick();
  assert.equal(bank.maxPrefetchConcurrency, 4);
  assert.equal(bank.activePrefetch.size, 4);
  assert.equal(bank.queue.length, 1);
  assert.equal(pending.has('64-79'), false);

  pending.get('0-15').resolve(responseFor(0, 15, 80, bytesFor(0, 15)));
  await tick();
  assert.equal(bank.activePrefetch.size <= 4, true);
  assert.equal(pending.has('64-79'), true);

  bank.destroy();
  const results = await Promise.allSettled(tasks);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(
    results.slice(1).every((result) => result.status === 'rejected' && result.reason.name === 'AbortError'),
    true,
  );
});

test('default prefetch concurrency keeps two legs per in-flight chunk', async () => {
  const config = configFor({ raceLegs: 2, stallMs: 1000 });
  const calls = [];
  const windowObject = windowFixture();
  windowObject.__playinfo__ = playurlBody();
  const bank = new SegmentBank({
    windowObject,
    config,
    nativeFetch: (url, init) => {
      const range = rangeFromInit(init);
      calls.push({ url, range });
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const tasks = [0, 16, 32, 48].map((start) => bank.getTask({
    start,
    end: start + 15,
    chunkIndex: start / 16,
    cacheKey: `${MEDIA_KEY}#${start / 16}`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  }));
  await tick();

  assert.equal(bank.activePrefetch.size, 4);
  assert.equal(calls.length, 8);
  const callsByRange = new Map();
  for (const { range } of calls) {
    const key = `${range.start}-${range.end}`;
    callsByRange.set(key, (callsByRange.get(key) || 0) + 1);
  }
  assert.deepEqual([...callsByRange.values()].sort((left, right) => left - right), [2, 2, 2, 2]);
  assert.equal(calls.filter(({ url }) => new URL(url).hostname === new URL(MEDIA_URL).hostname).length, 4);
  assert.equal(calls.filter(({ url }) => new URL(url).hostname === new URL(PAIR_URL).hostname).length, 4);

  bank.destroy();
  const results = await Promise.allSettled(tasks);
  assert.equal(
    results.every((result) => result.status === 'rejected' && result.reason.name === 'AbortError'),
    true,
  );
});

test('explicit prefetch concurrency of two never exceeds two active tasks', async () => {
  const config = configFor({ stallMs: 1000 });
  const pending = new Map();
  const { bank } = createBank({
    config,
    maxPrefetchConcurrency: 2,
    nativeFetch: async (_url, init) => {
      const range = rangeFromInit(init);
      return new Promise((resolve, reject) => {
        pending.set(`${range.start}-${range.end}`, { resolve, reject });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const tasks = [0, 16, 32, 48].map((start) => bank.getTask({
    start,
    end: start + 15,
    chunkIndex: start / 16,
    cacheKey: `${MEDIA_KEY}#${start / 16}`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bank.activePrefetch.size <= 2, true);
  assert.equal(bank.activePrefetch.size, 2);
  assert.equal(bank.queue.length, 2);
  pending.get('0-15').resolve(responseFor(0, 15, 80, bytesFor(0, 15)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bank.activePrefetch.size <= 2, true);
  assert.equal(pending.has('32-47'), true);
  bank.destroy();
  const results = await Promise.allSettled(tasks);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results.slice(1).every((result) => result.status === 'rejected' && result.reason.name === 'AbortError'), true);
});

test('memory eviction removes the evicted chunk', () => {
  const config = configFor({ maxBankBytes: 32 });
  const { bank } = createBank({ config });
  const first = putChunk(bank, 0, config, 64);
  putChunk(bank, 1, config, 64);
  bank.stateFor(MEDIA_KEY).lastForegroundEnd = 20;
  bank.storeTask({
    cacheKey: `${MEDIA_KEY}#2`,
    bankKey: MEDIA_KEY,
    chunkIndex: 2,
  }, {
    start: 32,
    end: 47,
    totalSize: 64,
    bytes: bytesFor(32, 47).buffer,
  });
  assert.equal(bank.chunks.has(first.cacheKey), false);
  assert.equal(bank.chunks.size, 2);
  assert.equal(bank.windowObject.messages.some((message) => message.code === 'bank.evict'), true);
});

test('memory eviction prefers played chunks and then the farthest future chunk', () => {
  const entries = [
    { cacheKey: 'a#0', bankKey: 'a', start: 0, end: 9, byteLength: 10, storedAt: 1 },
    { cacheKey: 'a#1', bankKey: 'a', start: 100, end: 109, byteLength: 10, storedAt: 2 },
    { cacheKey: 'b#0', bankKey: 'b', start: 20, end: 29, byteLength: 10, storedAt: 3 },
  ];
  const selected = selectEvictions({
    entries,
    maxBankBytes: 20,
    currentByteByBank: { a: 50, b: 50 },
  });
  assert.equal(selected.bytes, 10);
  assert.equal(selected.entries[0].cacheKey, 'a#0');
  const farther = selectEvictions({
    entries: entries.slice(1),
    maxBankBytes: 10,
    currentByteByBank: { a: 50, b: 0 },
  });
  assert.equal(farther.entries[0].cacheKey, 'a#1');
});

test('memory limit is enforced after each write', async () => {
  const config = configFor({ maxBankBytes: 32 });
  const { bank } = createBank({ config });
  for (const start of [0, 16, 32]) {
    await bank.getTask({
      start,
      end: start + 15,
      chunkIndex: start / 16,
      cacheKey: `${MEDIA_KEY}#${start / 16}`,
    }, {
      kind: 'prefetch',
      url: MEDIA_URL,
      credentials: 'same-origin',
      videoKey: '/video/BVbank',
    });
  }
  assert.equal(totalMemoryBytes(bank.chunks, config.chunkBytes) <= config.maxBankBytes, true);
  assert.equal(bank.chunks.size, 2);
});

test('memory storage is atomic and never exposes a half chunk after an invalid response', async () => {
  const config = configFor();
  const { bank } = createBank({
    config,
    maxPrefetchConcurrency: 2,
    nativeFetch: async () => responseFor(0, 15, 64, new Uint8Array(15)),
  });
  let fallbackCalls = 0;
  const response = await fetchThrough(
    bank,
    MEDIA_URL,
    { headers: { Range: 'bytes=0-7' } },
    async () => {
      fallbackCalls += 1;
      return new Response(new Uint8Array(0), { status: 416, statusText: 'Range Not Satisfiable' });
    },
  );
  assert.equal(response.status, 416);
  assert.equal(fallbackCalls, 1);
  assert.equal(bank.chunks.size, 0);
});

test('a memory write failure disables the bank and lets subsequent requests pass', async () => {
  const config = configFor();
  const { bank, windowObject } = createBank({ config });
  bank.storeTask = () => { throw new Error('allocation failed'); };
  await bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  assert.equal(bank.disabled, true);
  assert.equal(windowObject.messages.some((message) => message.code === 'bank.store' && message.data.result === 'failed'), true);
  assert.equal(windowObject.messages.filter((message) => message.code === 'bank.disabled').length, 1);
  let passCalls = 0;
  const passed = await fetchThrough(
    bank,
    MEDIA_URL,
    { headers: { Range: 'bytes=0-7' } },
    async () => {
      passCalls += 1;
      return new Response('pass', { status: 200 });
    },
  );
  assert.equal(await passed.text(), 'pass');
  assert.equal(passCalls, 1);
});

test('non-2xx responses and network errors fail the intercepted player request', async () => {
  const networkResponse = new Response('failed', {
    status: 503,
    statusText: 'Unavailable',
    headers: { 'X-CDN': 'same' },
  });
  const { bank } = createBank({ maxPrefetchConcurrency: 2, nativeFetch: async () => networkResponse });
  await assert.rejects(fetchThrough(bank), (error) => error.name === 'BankNetworkError');

  const networkError = new TypeError('cdn failed');
  const failedBank = createBank({
    maxPrefetchConcurrency: 1,
    nativeFetch: async () => { throw networkError; },
  }).bank;
  await assert.rejects(fetchThrough(failedBank), (error) => error.name === 'BankNetworkError');
});

test('a foreground fetch failure is written to the console', async () => {
  const { bank } = createBank({
    maxPrefetchConcurrency: 1,
    nativeFetch: async () => { throw new TypeError('cdn failed'); },
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(fetchThrough(bank), (error) => error.name === 'BankNetworkError');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    bank.destroy();
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
});

test('an intercepted request uses the extension task signal instead of the caller signal', async () => {
  let signalSeen;
  const { bank } = createBank({
    config: configFor(),
    nativeFetch: async (_url, init) => {
      signalSeen = init.signal;
      return responseFor(0, 15, 100, bytesFor(0, 15));
    },
  });
  const controller = new AbortController();
  let originalCalls = 0;
  const response = await fetchThrough(
    bank,
    MEDIA_URL,
    { headers: { Range: 'bytes=0-9' }, signal: controller.signal },
    async () => {
      originalCalls += 1;
      return new Response('native', { status: 200 });
    },
  );
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...bytesFor(0, 9)]);
  assert.notEqual(signalSeen, controller.signal);
  assert.equal(originalCalls, 0);
  await tick();
  assert.equal(bank.inflight.size, 0);
  controller.abort();
});

test('a stalled stream is cancelled with the real bytes already received', async () => {
  const config = configFor({ stallMs: 20 });
  const timers = manualTimers();
  let streamController;
  const { bank, windowObject } = createBank({
    config,
    maxPrefetchConcurrency: 2,
    timers,
    nativeFetch: async () => {
      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(new Uint8Array([1, 2, 3]));
        },
      });
      return new Response(body, {
        status: 206,
        headers: {
          'Content-Range': 'bytes 0-15/64',
          'Content-Length': '16',
        },
      });
    },
  });
  const state = bank.stateFor(MEDIA_KEY);
  const pending = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  const task = bank.inflight.get(`${MEDIA_KEY}#0`);
  assert.equal(streamController !== undefined, true);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    timers.fire(config.stallMs);
    await assert.rejects(pending, (error) => error.name === 'AbortError');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = originalError;
  }
  assert.equal(task.legs[0].abortReason, 'stalled');
  assert.equal(bank.chunks.has(`${MEDIA_KEY}#0`), false);
  const diagnostic = windowObject.messages.find(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'stalled',
  );
  assert.equal(diagnostic.data.bytes, 3);
  assert.equal(state.chunkAttempts.get(0), 1);
  assert.deepEqual(errors, []);
});

test('aborting a waiting player request removes it from outstanding without cancelling its chunk task', async () => {
  const config = configFor({ stallMs: 1000 });
  let taskSignal;
  const { bank } = createBank({
    config,
    maxPrefetchConcurrency: 1,
    nativeFetch: (_url, init) => new Promise((_resolve, reject) => {
      taskSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = fetchThrough(bank, MEDIA_URL, {
    headers: { Range: 'bytes=0-7' },
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const state = bank.stateFor(MEDIA_KEY);
  assert.equal(state.outstanding.size, 1);

  controller.abort();

  assert.equal(state.outstanding.size, 0);
  assert.equal(taskSignal.aborted, false);
  bank.destroy();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('leaving the video route releases chunks', async () => {
  const config = configFor();
  const { bank, windowObject } = createBank({ config });
  putChunk(bank, 0, config);
  windowObject.location = new URL('https://www.bilibili.com/');
  await bank.prefetch();
  assert.equal(bank.chunks.size, 0);
});

test('changing bvid releases chunks', async () => {
  const config = configFor();
  const { bank, windowObject } = createBank({
    config,
    location: new URL('https://www.bilibili.com/video/BVbank/'),
  });
  putChunk(bank, 0, config);
  windowObject.location = new URL('https://www.bilibili.com/video/BVother/');

  await bank.prefetch();

  assert.equal(bank.chunks.size, 0);
  bank.destroy();
});

test('changing part releases chunks', async () => {
  const config = configFor();
  const { bank, windowObject } = createBank({
    config,
    location: new URL('https://www.bilibili.com/video/BVbank/?p=1'),
  });
  putChunk(bank, 0, config);
  windowObject.location = new URL('https://www.bilibili.com/video/BVbank/?p=2');

  await bank.prefetch();

  assert.equal(bank.chunks.size, 0);
  bank.destroy();
});

test('changing watch-later item releases chunks', async () => {
  const config = configFor();
  const { bank, windowObject } = createBank({
    config,
    location: new URL('https://www.bilibili.com/list/watchlater/item-a'),
  });
  putChunk(bank, 0, config);
  windowObject.location = new URL('https://www.bilibili.com/list/watchlater/item-b');

  await bank.prefetch();

  assert.equal(bank.chunks.size, 0);
  bank.destroy();
});

test('one prefetch call refills the anchored window after each successful store', async () => {
  const config = configFor({ lookAheadChunks: 3 });
  const pending = new Map();
  const ranges = [];
  const { bank } = createBank({
    config,
    nativeFetch: (_url, init) => {
      const range = rangeFromInit(init);
      ranges.push(range);
      return new Promise((resolve, reject) => {
        pending.set(`${range.start}-${range.end}`, { resolve, reject });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.totalSize = 48;
  state.lastForegroundStart = 0;
  state.lastForegroundEnd = 0;
  bank.touchResource(MEDIA_KEY);

  await bank.prefetch();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(ranges, [
    { start: 0, end: 15 },
    { start: 16, end: 31 },
  ]);
  pending.get('0-15').resolve(responseFor(0, 15, 48, bytesFor(0, 15)));
  pending.get('16-31').resolve(responseFor(16, 31, 48, bytesFor(16, 31)));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(pending.has('32-47'), true);
  pending.get('32-47').resolve(responseFor(32, 47, 48, bytesFor(32, 47)));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(ranges, [
    { start: 0, end: 15 },
    { start: 16, end: 31 },
    { start: 32, end: 47 },
  ]);
  assert.equal(bank.chunks.size, 3);
});

test('a failed chunk is selected again by the next window without retry code', async () => {
  const config = configFor();
  let calls = 0;
  const ranges = [];
  const { bank } = createBank({
    config,
    nativeFetch: async (_url, init) => {
      const range = rangeFromInit(init);
      ranges.push(range);
      calls += 1;
      if (calls === 1) throw new TypeError('temporary CDN failure');
      return responseFor(range.start, range.end, 64, bytesFor(range.start, range.end));
    },
  });
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.lastForegroundStart = 0;
  bank.touchResource(MEDIA_KEY);
  const plan = planFetchRanges(0, 15, {
    chunkBytes: config.chunkBytes,
    totalSize: 64,
    bankKeyValue: MEDIA_KEY,
  })[0];
  await assert.rejects(bank.getTask(plan, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  }), (error) => error.name === 'BankNetworkError');
  assert.equal(state.chunkAttempts.get(0), 1);
  await bank.prefetch();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ranges.filter((range) => range.start === 0).length, 2);
  assert.equal(bank.chunks.has(`${MEDIA_KEY}#0`), true);
});

test('a retry-absorbed prefetch failure records a chunk event without console output', async () => {
  const config = configFor();
  const { bank, windowObject } = createBank({
    config,
    maxPrefetchConcurrency: 1,
    nativeFetch: async () => { throw new TypeError('temporary CDN failure'); },
  });
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.lastForegroundStart = 0;
  bank.touchResource(MEDIA_KEY);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await bank.prefetch();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await bank.prefetch();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    bank.destroy();
    console.error = originalError;
  }
  assert.equal(errors.length, 0);
  assert.equal(state.chunkAttempts.get(0), 2);
  assert.equal(windowObject.messages.some(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'network_error',
  ), true);
});

test('a serve failure is reported before the native fallback', async () => {
  const { bank, windowObject } = createBank();
  bank.serveRequest = async () => { throw new Error('serve failed'); };
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const response = await fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=0-7' } }, async () => (
      new Response('native', { status: 200 })
    ));
    assert.equal(await response.text(), 'native');
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  const diagnostic = windowObject.messages.find(
    (message) => message.code === 'bank.serve' && message.data.reason === 'internal_error',
  );
  assert.equal(diagnostic.data.mirror, new URL(MEDIA_URL).hostname);
});

test('a chunk at maxChunkAttempts leaves the window and reports gave_up to its player', async () => {
  const config = configFor({ maxChunkAttempts: 3 });
  let calls = 0;
  const { bank, windowObject } = createBank({
    config,
    nativeFetch: async () => {
      calls += 1;
      throw new TypeError('permanent CDN failure');
    },
  });
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.lastForegroundStart = 0;
  bank.touchResource(MEDIA_KEY);
  const plan = planFetchRanges(0, 15, {
    chunkBytes: config.chunkBytes,
    totalSize: 64,
    bankKeyValue: MEDIA_KEY,
  })[0];
  for (let attempt = 0; attempt < config.maxChunkAttempts; attempt += 1) {
    await assert.rejects(bank.getTask(plan, {
      kind: 'prefetch',
      url: MEDIA_URL,
      credentials: 'same-origin',
      videoKey: '/video/BVbank',
    }), (error) => error.name === 'BankNetworkError');
  }
  assert.equal(state.chunkAttempts.get(0), config.maxChunkAttempts);
  await bank.prefetch();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls >= config.maxChunkAttempts, true);
  assert.equal(state.chunkAttempts.get(0), config.maxChunkAttempts);
  let originalCalls = 0;
  await assert.rejects(fetchThrough(bank, MEDIA_URL, { headers: { Range: 'bytes=0-7' } }, async () => {
    originalCalls += 1;
    return new Response('native');
  }), (error) => error.name === 'BankNetworkError');
  assert.equal(originalCalls, 0);
  assert.equal(state.chunkAttempts.has(0), false);
  assert.equal(windowObject.messages.some(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'gave_up',
  ), true);
});

test('the player moving past a chunk cancels its in-flight fetch as superseded', async () => {
  const config = configFor();
  let firstSignal;
  const { bank, windowObject } = createBank({
    config,
    maxPrefetchConcurrency: 1,
    nativeFetch: async (_url, init) => {
      firstSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.lastForegroundStart = 0;
  bank.touchResource(MEDIA_KEY);
  const task = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));
  state.lastForegroundStart = 32;
  await bank.prefetch();
  assert.equal(firstSignal.aborted, true);
  await assert.rejects(task, (error) => error.name === 'AbortError');
  assert.equal(windowObject.messages.some(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'superseded',
  ), true);
  assert.equal(state.chunkAttempts.has(0), false);
  bank.destroy();
});

test('a queued superseded task emits one chunk diagnostic', async () => {
  const config = configFor({ stallMs: 1000 });
  const { bank, windowObject } = createBank({
    config,
    maxPrefetchConcurrency: 1,
    nativeFetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    }),
  });
  const first = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  const queued = bank.getTask({
    start: 16,
    end: 31,
    chunkIndex: 1,
    cacheKey: `${MEDIA_KEY}#1`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await tick();

  bank.supersedeTasksBefore(MEDIA_KEY, 2);
  await Promise.allSettled([first, queued]);

  assert.equal(windowObject.messages.filter(
    (message) => message.code === 'bank.fetch.chunk'
      && message.data.chunkIndex === 1
      && message.data.result === 'superseded',
  ).length, 1);
  bank.destroy();
});

test('touching a third resource does not cancel a still-wanted chunk', async () => {
  const config = configFor({ stallMs: 1000 });
  let taskSignal;
  const { bank } = createBank({
    config,
    maxPrefetchConcurrency: 1,
    nativeFetch: (_url, init) => new Promise((_resolve, reject) => {
      taskSignal = init.signal;
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.lastForegroundStart = 0;
  bank.touchResource(MEDIA_KEY);
  const pending = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await new Promise((resolve) => setImmediate(resolve));

  bank.touchResource('/video/other-a.m4s');
  bank.touchResource('/video/other-b.m4s');

  assert.equal(bank.anchorChunkForState(state), 0);
  assert.equal(taskSignal.aborted, false);
  bank.destroy();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});

test('the window stays within the configured anchor plus lookAheadChunks', () => {
  const config = configFor({ lookAheadChunks: 3 });
  const { bank } = createBank({ config });
  const state = bank.stateFor(MEDIA_KEY);
  state.latestUrl = MEDIA_URL;
  state.lastForegroundStart = 17;
  const anchor = bank.anchorChunkForState(state);
  const plans = bank.windowPlansForState(state, anchor);
  assert.equal(anchor, 1);
  assert.equal(plans.every((plan) => plan.chunkIndex >= anchor && plan.chunkIndex < anchor + config.lookAheadChunks), true);
});

test('a raced chunk dispatches both mirrors and stores only the first complete body', async () => {
  const config = configFor({ raceLegs: 2 });
  const requests = new Map();
  const { bank, windowObject } = createBank({
    config,
    nativeFetch: (url, init) => new Promise((resolve, reject) => {
      requests.set(url, { resolve, reject, signal: init.signal });
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }),
  });
  bank.observePlayurlData(playurlBody());
  const taskPromise = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await tick();
  assert.deepEqual([...requests.keys()].map((url) => new URL(url).hostname), [
    new URL(MEDIA_URL).hostname,
    new URL(PAIR_URL).hostname,
  ]);

  requests.get(PAIR_URL).resolve(responseFor(0, 15, 100, bytesFor(40, 55)));
  await taskPromise;
  await tick();
  assert.deepEqual([...new Uint8Array(bank.chunks.get(`${MEDIA_KEY}#0`).bytes)], [...bytesFor(40, 55)]);
  assert.equal(requests.get(MEDIA_URL).signal.aborted, true);
  const chunkEvents = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.equal(chunkEvents.length, 2);
  assert.equal(chunkEvents.filter((message) => message.data.result === 'fetched').length, 1);
  assert.equal(chunkEvents.filter((message) => message.data.result === 'lost_race').length, 1);
  const winner = chunkEvents.find((message) => message.data.result === 'fetched').data;
  const loser = chunkEvents.find((message) => message.data.result === 'lost_race').data;
  assert.equal(winner.slot, 1);
  assert.equal(winner.mirror, new URL(PAIR_URL).hostname);
  assert.equal(typeof winner.ttfbMs, 'number');
  assert.equal(loser.slot, 0);
  assert.equal(loser.mirror, new URL(MEDIA_URL).hostname);
  assert.equal(Object.hasOwn(loser, 'ttfbMs'), false);
  bank.destroy();
});

test('a leg that arrives after settlement only emits lost_race and cannot store or record total size', async () => {
  const config = configFor({ raceLegs: 2 });
  const { bank, windowObject } = createBank({ config });
  bank.observePlayurlData(playurlBody());
  let releaseLateLeg;
  let totalSizeRecords = 0;
  bank.recordTotalSize = () => { totalSizeRecords += 1; };
  bank.runLeg = (_task, leg) => {
    leg.startedAt = 0;
    leg.ttfbAt = 0;
    leg.byteCount = 16;
    const result = {
      start: 0,
      end: 15,
      totalSize: 100,
      bytes: (leg.slot === 0 ? bytesFor(0, 15) : bytesFor(40, 55)).buffer,
    };
    if (leg.slot === 0) {
      leg.settled = true;
      return Promise.resolve(result);
    }
    return new Promise((resolve) => {
      releaseLateLeg = () => {
        leg.settled = true;
        resolve(result);
      };
    });
  };
  const taskPromise = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await taskPromise;
  assert.equal(totalSizeRecords, 1);
  assert.deepEqual([...new Uint8Array(bank.chunks.get(`${MEDIA_KEY}#0`).bytes)], [...bytesFor(0, 15)]);
  releaseLateLeg();
  await tick();
  assert.equal(totalSizeRecords, 1);
  assert.deepEqual([...new Uint8Array(bank.chunks.get(`${MEDIA_KEY}#0`).bytes)], [...bytesFor(0, 15)]);
  assert.equal(windowObject.messages.filter(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'lost_race',
  ).length, 1);
  bank.destroy();
});

test('raced failure classification is order-independent and counts one chunk attempt', async () => {
  const config = configFor({ raceLegs: 2 });
  const stateFor = (nativeFetch) => {
    const { bank, windowObject } = createBank({ config, nativeFetch });
    bank.observePlayurlData(playurlBody());
    return { bank, windowObject, state: bank.stateFor(MEDIA_KEY) };
  };
  const invalidResponse = () => responseFor(0, 15, 100, bytesFor(0, 15), {
    headers: { 'Content-Range': 'bytes 1-16/100' },
  });
  const allInvalid = stateFor(async () => invalidResponse());
  await assert.rejects(allInvalid.bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  }), (error) => error.name === 'BankFallbackError');
  assert.equal(allInvalid.state.chunkAttempts.get(0), 1);
  assert.equal(allInvalid.windowObject.messages.filter(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'invalid_response',
  ).length, 2);
  allInvalid.bank.destroy();

  const mixed = stateFor(async (url) => {
    if (url === MEDIA_URL) return invalidResponse();
    throw new TypeError('pair failed');
  });
  await assert.rejects(mixed.bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  }), (error) => error.name === 'BankNetworkError');
  assert.equal(mixed.state.chunkAttempts.get(0), 1);
  mixed.bank.destroy();

  const abort = stateFor((_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  }));
  const abortPromise = abort.bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await tick();
  abort.bank.inflight.get(`${MEDIA_KEY}#0`).controller.abort();
  await assert.rejects(abortPromise, (error) => error.name === 'AbortError');
  assert.equal(abort.state.chunkAttempts.has(0), false);
  abort.bank.destroy();
});

test('a stalled leg drops out while the paired leg wins the chunk', async () => {
  const config = configFor({ raceLegs: 2, stallMs: 20 });
  const timers = manualTimers();
  const pending = new Map();
  const { bank, windowObject } = createBank({
    config,
    timers,
    nativeFetch: (url, init) => {
      if (url === MEDIA_URL) {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
          },
        });
        return Promise.resolve(new Response(body, {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-15/64' },
        }));
      }
      return new Promise((resolve, reject) => {
        pending.set(url, { resolve, reject });
        init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    },
  });
  bank.observePlayurlData(playurlBody());
  const taskPromise = bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  await tick();
  const stallTimerId = Math.max(...timers.pending.keys());
  timers.fireId(stallTimerId);
  pending.get(PAIR_URL).resolve(responseFor(0, 15, 64, bytesFor(20, 35)));
  await taskPromise;
  await tick();
  assert.equal(windowObject.messages.some(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'stalled',
  ), true);
  assert.equal(windowObject.messages.some(
    (message) => message.code === 'bank.fetch.chunk' && message.data.result === 'fetched',
  ), true);
  assert.deepEqual([...new Uint8Array(bank.chunks.get(`${MEDIA_KEY}#0`).bytes)], [...bytesFor(20, 35)]);
  bank.destroy();
});

test('tail chunks are validated and stored when a raced response ends at totalSize minus one', async () => {
  const config = configFor({ raceLegs: 2 });
  const { bank } = createBank({
    config,
    nativeFetch: async () => responseFor(0, 9, 10, bytesFor(0, 9)),
  });
  bank.observePlayurlData(playurlBody());
  await bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  assert.equal(bank.chunks.get(`${MEDIA_KEY}#0`).bytes.byteLength, 10);
  assert.equal(bank.chunks.get(`${MEDIA_KEY}#0`).totalSize, 10);
  bank.destroy();
});

test('empty, stale, mismatched, and race-disabled address books degrade to one leg', async () => {
  const runSingle = async ({ config, now, observe, advance }) => {
    const calls = [];
    const { bank } = createBank({
      config,
      now,
      nativeFetch: async (url, init) => {
        calls.push({ url, signal: init.signal });
        return responseFor(0, 15, 100, bytesFor(0, 15));
      },
    });
    if (observe !== undefined) bank.observePlayurlData(observe);
    advance?.();
    await bank.getTask({
      start: 0,
      end: 15,
      chunkIndex: 0,
      cacheKey: `${MEDIA_KEY}#0`,
    }, {
      kind: 'prefetch',
      url: MEDIA_URL,
      credentials: 'same-origin',
      videoKey: '/video/BVbank',
    });
    assert.equal(calls.length, 1);
    bank.destroy();
  };
  await runSingle({ config: configFor({ raceLegs: 2 }), observe: playurlBody(MEDIA_URL, []) });
  let now = 1000;
  await runSingle({
    config: configFor({ raceLegs: 2, pairFreshnessMs: 10 }),
    now: () => now,
    observe: playurlBody(),
    advance: () => { now += 11; },
  });
  await runSingle({
    config: configFor({ raceLegs: 2 }),
    observe: playurlBody(MEDIA_URL, ['https://upos-hz-mirrorakam.akamaized.net/video/other.m4s']),
  });
  await runSingle({ config: configFor({ raceLegs: 1 }), observe: playurlBody() });
});

test('the first unpaired chunk reads inline playinfo before building its legs', async () => {
  const config = configFor({ raceLegs: 2 });
  const { bank, windowObject, calls } = createBank({ config });
  windowObject.__playinfo__ = playurlBody();
  await bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  assert.equal(calls.length, 2);
  assert.notEqual(new URL(calls[0].url).hostname, new URL(calls[1].url).hostname);
  bank.destroy();
});

test('an undefined inline playinfo keeps the first chunk single-legged without an error', async () => {
  const config = configFor({ raceLegs: 2 });
  const { bank, calls } = createBank({ config });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await bank.getTask({
      start: 0,
      end: 15,
      chunkIndex: 0,
      cacheKey: `${MEDIA_KEY}#0`,
    }, {
      kind: 'prefetch',
      url: MEDIA_URL,
      credentials: 'same-origin',
      videoKey: '/video/BVbank',
    });
  } finally {
    console.error = originalError;
    bank.destroy();
  }
  assert.equal(calls.length, 1);
  assert.equal(errors.length, 0);
});

test('inline playinfo is reparsed after an in-place mutation and after freshness expiry', async () => {
  const config = configFor({ raceLegs: 2, pairFreshnessMs: 10 });
  let now = 1000;
  const { bank, windowObject, calls } = createBank({ config, now: () => now });
  const inline = playurlBody(MEDIA_URL, []);
  windowObject.__playinfo__ = inline;
  const task = (chunkIndex) => bank.getTask({
    start: chunkIndex * 16,
    end: chunkIndex * 16 + 15,
    chunkIndex,
    cacheKey: `${MEDIA_KEY}#${chunkIndex}`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });

  await task(0);
  inline.data.dash.video[0].backupUrl = [PAIR_URL];
  now += 11;
  await task(1);

  assert.equal(calls.length, 3);
  assert.equal(new URL(calls[1].url).hostname, new URL(MEDIA_URL).hostname);
  assert.equal(new URL(calls[2].url).hostname, new URL(PAIR_URL).hostname);
  bank.destroy();
});

test('cyclic and throwing inline playinfo values cannot fail a successful chunk', async () => {
  const cases = [
    (() => {
      const value = playurlBody();
      value.self = value;
      return value;
    })(),
    'throwing getter',
  ];
  for (const value of cases) {
    const config = configFor({ raceLegs: 2 });
    const { bank, windowObject, calls } = createBank({ config });
    const thrown = new Error('page getter failed');
    if (value === 'throwing getter') {
      Object.defineProperty(windowObject, '__playinfo__', {
        configurable: true,
        get() { throw thrown; },
      });
    } else {
      windowObject.__playinfo__ = value;
    }
    const errors = [];
    const originalError = console.error;
    console.error = (...args) => errors.push(args);
    let attempts;
    let addressBookSize;
    try {
      await bank.getTask({
        start: 0,
        end: 15,
        chunkIndex: 0,
        cacheKey: `${MEDIA_KEY}#0`,
      }, {
        kind: 'prefetch',
        url: MEDIA_URL,
        credentials: 'same-origin',
        videoKey: '/video/BVbank',
      });
      attempts = bank.stateFor(MEDIA_KEY).chunkAttempts.has(0);
      addressBookSize = bank.addressBook.size;
    } finally {
      console.error = originalError;
      bank.destroy();
    }
    assert.equal(calls.length, 1);
    assert.equal(attempts, false);
    assert.equal(addressBookSize, 0);
    assert.equal(errors.length, 1);
    if (value === 'throwing getter') assert.equal(errors[0][1], thrown);
  }
});

test('invalid inline playinfo is reported on every read', () => {
  const { bank, windowObject } = createBank({ config: configFor({ raceLegs: 2 }) });
  windowObject.__playinfo__ = '{invalid json';
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    bank.readInlinePlayinfo();
    bank.readInlinePlayinfo();
  } finally {
    console.error = originalError;
    bank.destroy();
  }
  assert.equal(errors.length, 2);
});

test('inline dash audio representations pair audio chunks', async () => {
  const audioUrl = 'https://audio-one.example/audio/track.m4s?token=secret';
  const audioPairUrl = 'https://audio-two.example/audio/track.m4s?token=pair';
  const audioKey = '/audio/track.m4s';
  const config = configFor({ raceLegs: 2 });
  const { bank, windowObject, calls } = createBank({ config });
  windowObject.__playinfo__ = {
    data: {
      dash: {
        audio: [{ baseUrl: audioUrl, backupUrl: [audioPairUrl] }],
      },
    },
  };
  await bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${audioKey}#0`,
  }, {
    kind: 'prefetch',
    url: audioUrl,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  assert.equal(bank.addressBook.has(audioKey), true);
  assert.equal(calls.length, 2);
  assert.notEqual(new URL(calls[0].url).hostname, new URL(calls[1].url).hostname);
  bank.destroy();
});

test('raceLegs one never reads inline playinfo', async () => {
  const config = configFor({ raceLegs: 1 });
  const { bank, windowObject, calls } = createBank({ config });
  windowObject.__playinfo__ = playurlBody();
  let readCount = 0;
  bank.readInlinePlayinfo = () => { readCount += 1; };
  await bank.getTask({
    start: 0,
    end: 15,
    chunkIndex: 0,
    cacheKey: `${MEDIA_KEY}#0`,
  }, {
    kind: 'prefetch',
    url: MEDIA_URL,
    credentials: 'same-origin',
    videoKey: '/video/BVbank',
  });
  assert.equal(readCount, 0);
  assert.equal(calls.length, 1);
  bank.destroy();
});

test('video identity changes release the address book and pass fetch observes the original playurl response', async () => {
  const { bank, windowObject } = createBank({ playinfo: playurlBody() });
  assert.equal(bank.addressBook.has(MEDIA_KEY), true);
  const extraUrls = [
    PAIR_URL,
    'https://mirror-three.example/video/track.m4s',
    'https://mirror-four.example/video/track.m4s',
    'https://mirror-five.example/video/track.m4s',
  ];
  bank.observePlayurlData(playurlBody(MEDIA_URL, extraUrls));
  assert.deepEqual(bank.addressBook.get(MEDIA_KEY).urls, [MEDIA_URL, ...extraUrls.slice(0, 3)]);
  bank.observePlayurlData(playurlBody(MEDIA_URL, []));
  assert.deepEqual(bank.addressBook.get(MEDIA_KEY).urls, [MEDIA_URL]);
  windowObject.location = new URL('https://www.bilibili.com/video/BVother');
  assert.equal(bank.syncRouteLifecycle(), true);
  assert.equal(bank.addressBook.size, 0);

  const response = new Response(JSON.stringify(playurlBody()), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
  const returned = await fetchThrough(bank, PLAYURL_URL, {}, async () => response);
  assert.equal(returned, response);
  assert.equal(response.bodyUsed, false);
  assert.equal(bank.addressBook.has(MEDIA_KEY), true);
  bank.destroy();
});

class NativeXHR {
  constructor() {
    this.readyState = 0;
    this.responseType = '';
    this.timeout = 0;
    this.withCredentials = false;
    this.listeners = new Map();
    this.sendCalls = [];
    this.requestHeaders = [];
    this.responseHeaders = {};
  }

  open(...args) {
    this.openArgs = args;
    this.readyState = 1;
  }

  setRequestHeader(name, value) { this.requestHeaders.push([name, value]); }

  addEventListener(type, listener) {
    const set = this.listeners.get(type) || new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }

  emit(type) {
    for (const listener of this.listeners.get(type) || []) listener({ type });
  }

  send(body) { this.sendCalls.push(body); }

  abort() { this.abortCalls = (this.abortCalls || 0) + 1; }

  getResponseHeader(name) {
    const wanted = name.toLowerCase();
    const entry = Object.entries(this.responseHeaders).find(([key]) => key.toLowerCase() === wanted);
    return entry?.[1] || null;
  }

  getAllResponseHeaders() { return ''; }

  overrideMimeType() {}
}

test('XHR pass observation reads responseText without changing native XHR state', async () => {
  const { bank, windowObject } = createBank();
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.open('GET', PLAYURL_URL);
  xhr.send();
  assert.equal(xhr._intercepted, false);
  let addressBookAtLoad;
  xhr.addEventListener('load', () => {
    addressBookAtLoad = bank.addressBook.has(MEDIA_KEY);
  });
  xhr._native.responseText = JSON.stringify(playurlBody());
  xhr._native.emit('load');
  await tick();
  assert.equal(addressBookAtLoad, true);
  assert.equal(bank.addressBook.has(MEDIA_KEY), true);
  assert.equal(xhr._intercepted, false);
  assert.equal(xhr.readyState, xhr._native.readyState);
  bank.destroy();
});

test('XHR synchronizes video identity before handling a request', () => {
  const { bank, windowObject } = createBank({ playinfo: playurlBody() });
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  windowObject.location = new URL('https://www.bilibili.com/video/BVother');
  const xhr = new windowObject.XMLHttpRequest();
  xhr.open('GET', PLAYURL_URL);
  xhr.send();
  assert.equal(bank.addressBook.size, 0);
  bank.destroy();
});

test('XHR playurl observation stays with its request and cannot disrupt a non-text response', () => {
  const { bank, windowObject } = createBank();
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.open('GET', PLAYURL_URL);
  xhr.send();
  xhr.open('GET', 'https://api.bilibili.com/x/web-interface/nav');
  xhr.send();
  let laterResponseReads = 0;
  Object.defineProperty(xhr._native, 'responseText', {
    configurable: true,
    get() {
      laterResponseReads += 1;
      return JSON.stringify(playurlBody());
    },
  });
  xhr._native.emit('load');
  assert.equal(laterResponseReads, 0);
  assert.equal(bank.addressBook.size, 0);

  xhr.open('GET', PLAYURL_URL);
  xhr.send();
  Object.defineProperty(xhr._native, 'responseText', {
    configurable: true,
    get() { throw new DOMException('responseText is unavailable', 'InvalidStateError'); },
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    assert.doesNotThrow(() => xhr._native.emit('load'));
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  assert.equal(xhr._intercepted, false);
  assert.equal(xhr.readyState, xhr._native.readyState);
  bank.destroy();
});

test('XHR non-intercepted media requests record their classification reason', () => {
  for (const [range, reason] of [[undefined, 'range_missing'], ['bytes=4-', 'range_not_closed']]) {
    const { bank, windowObject } = createBank();
    windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
      windowObject,
      nativeConstructor: NativeXHR,
      bank,
    });
    const xhr = new windowObject.XMLHttpRequest();
    xhr.open('GET', MEDIA_URL);
    if (range !== undefined) xhr.setRequestHeader('Range', range);
    xhr.send();
    const diagnostic = windowObject.messages.find((message) => message.code === 'bank.serve');
    assert.deepEqual(diagnostic.data, {
      source: 'https://upos-sz-mirrorcosov.bilivideo.com/video/track.m4s',
      mirror: 'upos-sz-mirrorcosov.bilivideo.com',
      result: 'pass',
      reason,
    });
    assert.deepEqual(xhr._native.sendCalls, [undefined]);
    bank.destroy();
  }
});

test('synchronous XHR records a distinct pass reason', () => {
  const { bank, windowObject } = createBank();
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.open('GET', MEDIA_URL, false);
  xhr.setRequestHeader('Range', 'bytes=0-2');
  xhr.send();
  const diagnostic = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(diagnostic.data.result, 'pass');
  assert.equal(diagnostic.data.reason, 'sync_xhr');
  assert.equal(diagnostic.data.mirror, 'upos-sz-mirrorcosov.bilivideo.com');
  assert.deepEqual(xhr._native.sendCalls, [undefined]);
  bank.destroy();
});

test('serve and chunk hit diagnostics carry duration and mirror on both channels', async () => {
  const fetchFixture = createBank({ config: configFor() });
  const fetchResponse = await fetchThrough(fetchFixture.bank, MEDIA_URL, {
    headers: { Range: 'bytes=4-11' },
  });
  assert.deepEqual([...new Uint8Array(await fetchResponse.arrayBuffer())], [...bytesFor(4, 11)]);
  const fetchServe = fetchFixture.windowObject.messages.find(
    (message) => message.code === 'bank.serve' && message.data.reason === 'fetched_range',
  );
  assert.equal(typeof fetchServe.data.durationMs, 'number');
  assert.equal(fetchServe.data.durationMs >= 0, true);
  assert.equal(fetchServe.data.mirror, 'upos-sz-mirrorcosov.bilivideo.com');
  const chunk = fetchFixture.windowObject.messages.find((message) => message.code === 'bank.fetch.chunk');
  assert.equal(chunk.data.mirror, 'upos-sz-mirrorcosov.bilivideo.com');
  fetchFixture.bank.destroy();

  const xhrFixture = createBank({ config: configFor() });
  putChunk(xhrFixture.bank, 0, xhrFixture.bank.config);
  xhrFixture.windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject: xhrFixture.windowObject,
    nativeConstructor: NativeXHR,
    bank: xhrFixture.bank,
  });
  const xhr = new xhrFixture.windowObject.XMLHttpRequest();
  await new Promise((resolve) => {
    xhr.addEventListener('loadend', resolve);
    xhr.open('GET', MEDIA_URL);
    xhr.setRequestHeader('Range', 'bytes=4-11');
    xhr.send();
  });
  const xhrServe = xhrFixture.windowObject.messages.find(
    (message) => message.code === 'bank.serve' && message.data.reason === 'stored_range',
  );
  assert.equal(typeof xhrServe.data.durationMs, 'number');
  assert.equal(xhrServe.data.durationMs >= 0, true);
  assert.equal(xhrServe.data.mirror, 'upos-sz-mirrorcosov.bilivideo.com');
  xhrFixture.bank.destroy();
});

test('XHR preserves readyState 2→3→4 and event ordering with arraybuffer response', async () => {
  const windowObject = windowFixture();
  const bank = {
    enabled: true,
    serveRequest() {
      const bytes = new Uint8Array([1, 2, 3]).buffer;
      return { intercepted: true, response: responseFor(0, 2, 3, new Uint8Array(bytes)), bytes };
    },
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.responseType = 'arraybuffer';
  const events = [];
  for (const name of ['readystatechange', 'progress', 'load', 'loadend']) {
    xhr.addEventListener(name, () => events.push(`${name}:${xhr.readyState}`));
  }
  await new Promise((resolve) => {
    xhr.addEventListener('loadend', resolve);
    xhr.open('GET', MEDIA_URL);
    xhr.setRequestHeader('Range', 'bytes=0-2');
    xhr.send();
  });
  assert.deepEqual(events, [
    'readystatechange:2',
    'readystatechange:3',
    'progress:3',
    'readystatechange:4',
    'load:4',
    'loadend:4',
  ]);
  assert.equal(xhr.response.byteLength, 3);
  assert.equal(xhr.responseURL, new URL(MEDIA_URL).href);
  assert.equal(xhr.status, 206);
});

test('XHR cache miss is served by the extension fetch without native XHR network access', async () => {
  const { bank, windowObject, calls } = createBank({ config: configFor() });
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.responseType = 'arraybuffer';
  const events = [];
  await new Promise((resolve) => {
    xhr.addEventListener('loadend', resolve);
    xhr.addEventListener('loadstart', () => events.push('loadstart'));
    xhr.open('GET', MEDIA_URL);
    xhr.setRequestHeader('Range', 'bytes=4-11');
    xhr.send();
  });
  assert.deepEqual(calls[0].range, { start: 0, end: 15 });
  assert.deepEqual([...new Uint8Array(xhr.response)], [...bytesFor(4, 11)]);
  const serveDiagnostic = bank.windowObject.messages.find(
    (message) => message.code === 'bank.serve' && message.data.reason === 'fetched_range',
  );
  assert.equal(serveDiagnostic.data.mirror, new URL(MEDIA_URL).hostname);
  assert.equal(typeof serveDiagnostic.data.durationMs, 'number');
  assert.equal(serveDiagnostic.data.durationMs >= 0, true);
  const chunkDiagnostic = bank.windowObject.messages.find((message) => message.code === 'bank.fetch.chunk');
  assert.equal(chunkDiagnostic.data.mirror, new URL(MEDIA_URL).hostname);
  assert.deepEqual(xhr._native.openArgs, ['GET', MEDIA_URL]);
  assert.deepEqual(xhr._native.requestHeaders, [['Range', 'bytes=4-11']]);
  assert.deepEqual(xhr._native.sendCalls, []);
  assert.deepEqual(events, ['loadstart']);
  assert.notEqual(xhr._abortController, undefined);
  assert.equal(xhr._timer, undefined);
  bank.destroy();
});

test('XHR internal fallback does not learn totalSize from the native response', async () => {
  const { bank, windowObject } = createBank({
    nativeFetch: async () => new Response(bytesFor(0, 15), { status: 206 }),
  });
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=0-2');
  xhr.send();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(xhr._native.listeners.get('readystatechange').size, 1);
  assert.deepEqual(xhr._native.sendCalls, [undefined]);
  assert.equal(bank.stateFor(MEDIA_KEY).totalSize, undefined);
  bank.destroy();
});

test('XHR BankFallbackError returns the request to the native XHR unchanged', async () => {
  const windowObject = windowFixture();
  const bank = {
    enabled: true,
    emitDiagnostic() {},
    serveRequest() {
      throw new BankFallbackError('等待超过补取死线');
    },
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=0-2');
  xhr.send('body');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(xhr._native.sendCalls, ['body']);
  assert.equal(xhr.readyState, 1);
});

test('XHR ignores a cancelled prior generation after open starts a replacement request', async () => {
  let calls = 0;
  const windowObject = windowFixture();
  const bank = {
    enabled: true,
    serveRequest() {
      calls += 1;
      const value = calls === 1 ? 1 : 2;
      const bytes = new Uint8Array([value, value, value]).buffer;
      const start = calls === 1 ? 0 : 3;
      return { intercepted: true, response: responseFor(start, start + 2, 6, new Uint8Array(bytes)), bytes };
    },
  };
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.responseType = 'arraybuffer';
  let loadendCount = 0;
  xhr.addEventListener('loadend', () => { loadendCount += 1; });

  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=0-2');
  xhr.send();
  xhr.open('GET', MEDIA_URL);
  xhr.setRequestHeader('Range', 'bytes=3-5');
  xhr.send();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loadendCount, 1);
  assert.deepEqual([...new Uint8Array(xhr.response)], [2, 2, 2]);
});

test('pure memory functions keep records complete and enforce the global cap', () => {
  const config = configFor({ maxBankBytes: 16 });
  const chunks = new Map();
  const partialChunks = new Map([[`${MEDIA_KEY}#0`, {
    bytes: bytesFor(0, 7).buffer,
    totalSize: 64,
    storedAt: 1,
  }]]);
  assert.throws(() => readMemoryRange(partialChunks, MEDIA_KEY, 0, 7, config.chunkBytes));
  writeMemoryChunk({
    chunks,
    bankKey: MEDIA_KEY,
    start: 0,
    end: 15,
    totalSize: 64,
    bytes: bytesFor(0, 15).buffer,
    chunkBytes: config.chunkBytes,
    storedAt: 1,
  });
  assert.deepEqual([...new Uint8Array(readMemoryRange(chunks, MEDIA_KEY, 4, 6, 16).bytes)], [4, 5, 6]);
  assert.throws(() => writeMemoryChunk({
    chunks,
    bankKey: MEDIA_KEY,
    start: 0,
    end: 7,
    totalSize: 64,
    bytes: bytesFor(0, 7).buffer,
    chunkBytes: config.chunkBytes,
  }));
  writeMemoryChunk({
    chunks,
    bankKey: MEDIA_KEY,
    start: 16,
    end: 31,
    totalSize: 64,
    bytes: bytesFor(16, 31).buffer,
    chunkBytes: config.chunkBytes,
    storedAt: 2,
  });
  const eviction = enforceMemoryLimit({ chunks, maxBankBytes: 16, chunkBytes: config.chunkBytes });
  assert.equal(eviction.bytes, 16);
  assert.equal(totalMemoryBytes(chunks, config.chunkBytes), 16);
});

// 实测形状：base_url 挂在拥有 url_info 数组的 codec 对象上（.flv 路径，以 '?' 结尾），
// url_info 条目只带 host/extra/stream_ttl，完整地址 = host + codec.base_url + extra。
function liveUrlInfoBody(entries, codecBaseUrl) {
  const codec = { url_info: entries };
  if (codecBaseUrl !== undefined) codec.base_url = codecBaseUrl;
  return {
    data: {
      playurl_info: {
        playurl: {
          stream: [
            {
              format: [
                {
                  codec: [codec],
                },
              ],
            },
          ],
        },
      },
    },
  };
}

function liveUrlInfoEntry(url) {
  const parsed = new URL(url);
  return {
    host: parsed.origin,
    extra: parsed.search.slice(1),
    stream_ttl: 1,
  };
}

function livePlayurlBody(mainUrl = LIVE_URL, backupUrl = LIVE_PAIR_URL) {
  return liveUrlInfoBody(
    [liveUrlInfoEntry(mainUrl), liveUrlInfoEntry(backupUrl)],
    `${new URL(mainUrl).pathname}?`,
  );
}

function liveConfig(overrides = {}) {
  return configFor({ chunkBytes: 8, ...overrides });
}

function liveFeed({ status = 200, headers = { 'Content-Type': 'video/x-flv' } } = {}) {
  let controller;
  const feed = { cancelled: false };
  const stream = new ReadableStream({
    start(controllerArg) { controller = controllerArg; },
    cancel() { feed.cancelled = true; },
  });
  feed.response = new Response(stream, { status, headers });
  feed.push = (bytes) => controller.enqueue(bytes);
  feed.close = () => controller.close();
  return feed;
}

function createLiveBank({ nativeFetch, timers, config = liveConfig(), playinfo, now } = {}) {
  const fixture = createBank({
    nativeFetch,
    timers,
    config,
    now,
    location: LIVE_LOCATION,
  });
  if (playinfo !== undefined) fixture.windowObject.__NEPTUNE_IS_MY_WAIFU__ = playinfo;
  return fixture;
}

function liveFetchThrough(bank, url = LIVE_URL, init = {}) {
  return bank.handleFetch(bank.windowObject, [url, init], bank.nativeFetch);
}

function encoded(value) {
  return new TextEncoder().encode(value);
}

function stitcherHarness({ legCount = 2, chunkBytes = 8 } = {}) {
  const harness = {
    chunks: [],
    stitches: [],
    delivered: [],
    cancelled: [],
    failed: false,
    closed: false,
  };
  const legMetas = [
    {
      slot: 0,
      source: 'https://d1--ov-gotcha07.bilivideo.com/live-bvc/1/stream.flv',
      mirror: 'd1--ov-gotcha07.bilivideo.com',
    },
    {
      slot: 1,
      source: 'https://d1--ov-gotcha07b.bilivideo.com/live-bvc/1/stream.flv',
      mirror: 'd1--ov-gotcha07b.bilivideo.com',
    },
  ].slice(0, legCount);
  const stitcher = new LiveStreamStitcher({
    streamPath: LIVE_KEY,
    legs: legMetas,
    chunkBytes,
    now: () => 1000,
    emitChunk: (payload) => harness.chunks.push(payload),
    emitStitch: (payload) => harness.stitches.push(payload),
    deliver: (bytes, start, end) => harness.delivered.push({ bytes: [...bytes], start, end }),
    cancelLeg: (slot) => harness.cancelled.push(slot),
    failStream: () => { harness.failed = true; },
    closeStream: () => { harness.closed = true; },
  });
  return { stitcher, harness };
}

test('live locations classify flv streams and hls segments, passing playlists through', () => {
  assert.equal(isLiveLocation(LIVE_LOCATION), true);
  assert.equal(isLiveLocation(new URL('https://www.bilibili.com/video/BVbank')), false);
  assert.deepEqual(classifyLiveRequest({ url: LIVE_URL, locationObject: LIVE_LOCATION }), {
    intercepted: true,
    url: LIVE_URL,
    kind: 'flv_stream',
  });
  for (const url of [
    'https://d1--ov-gotcha105.bilivideo.com/live-bvc/1/live_xxx/seg-1.m4s?x=1',
    'https://d1--ov-gotcha105.bilivideo.com/live-bvc/1/live_xxx/seg-1_init.m4s?x=1',
    'https://d1--ov-gotcha105.bilivideo.com/live-bvc/1/live_xxx/seg-1.ts?x=1',
  ]) {
    const classification = classifyLiveRequest({ url, locationObject: LIVE_LOCATION });
    assert.equal(classification.intercepted, true);
    assert.equal(classification.kind, 'hls_segment');
  }
  assert.deepEqual(classifyLiveRequest({ url: LIVE_HLS_URL, locationObject: LIVE_LOCATION }), {
    intercepted: false,
    reason: 'live_hls_playlist',
  });
  assert.deepEqual(
    classifyLiveRequest({
      url: 'https://d1--ov-gotcha207.bilivideo.com/live-bvc/1/keepalive.txt?x=1',
      locationObject: LIVE_LOCATION,
    }),
    { intercepted: false, reason: 'live_other_media' },
  );
  assert.equal(
    classifyLiveRequest({ url: 'https://api.live.bilibili.com/xlive/room/flv', locationObject: LIVE_LOCATION }).reason,
    'non_media_host',
  );
  assert.equal(classifyLiveRequest({ url: LIVE_URL, enabled: false, locationObject: LIVE_LOCATION }).intercepted, false);
  assert.equal(
    classifyLiveRequest({ url: LIVE_HLS_URL, enabled: false, locationObject: LIVE_LOCATION }).intercepted,
    false,
  );
  const expiry = new URL(LIVE_URL).searchParams.get('expires');
  assert.equal(liveUrlExpiresAt(LIVE_URL), Number(expiry) * 1000);
  assert.equal(liveUrlExpiresAt('https://d1--ov-gotcha07.bilivideo.com/live-bvc/1/stream.flv'), undefined);
});

test('live urls rebuild from host, extra and the entry-over-group base_url precedence', () => {
  const host = 'https://d1--ov-gotcha07.bilivideo.com';
  assert.equal(urlFromLiveUrlInfo({
    host,
    extra: 'expires=4102444800&sign=main',
  }, '/live-bvc/1/stream.flv?'), LIVE_URL);
  assert.equal(urlFromLiveUrlInfo({
    host,
    extra: 'expires=4102444800&sign=main',
  }, '/live-bvc/1/stream.flv'), LIVE_URL);
  assert.equal(urlFromLiveUrlInfo({
    host,
    base_url: '/live-bvc/1/stream.flv?',
    extra: 'expires=4102444800&sign=main',
  }, '/live-bvc/1/other.flv?'), LIVE_URL);
  assert.equal(urlFromLiveUrlInfo({
    host,
    base_url: 5,
    extra: 'expires=4102444800&sign=main',
  }, '/live-bvc/1/stream.flv?'), LIVE_URL);
  assert.equal(urlFromLiveUrlInfo({
    host,
    base_url: '/live-bvc/1/stream.flv',
    extra: 'expires=4102444800&sign=main',
  }), LIVE_URL);
  assert.equal(urlFromLiveUrlInfo({
    host,
    base_url: '/live-bvc/1/stream.flv',
    extra: '?expires=4102444800&sign=main',
  }), LIVE_URL);
  assert.equal(urlFromLiveUrlInfo({ url: LIVE_PAIR_URL }), LIVE_PAIR_URL);
  assert.throws(() => urlFromLiveUrlInfo({ host, extra: 'expires=1' }));
  assert.throws(() => urlFromLiveUrlInfo({ host, extra: 'expires=1' }, 5));
  assert.throws(() => urlFromLiveUrlInfo({ host, base_url: 5, extra: 'expires=1' }));
});

test('the live address book reads inline url_info groups and pairs by pathname', () => {
  const { bank } = createLiveBank({ playinfo: livePlayurlBody() });
  bank.readInlineLivePlayinfo();
  assert.deepEqual([...bank.addressBook.keys()], [LIVE_KEY]);
  assert.deepEqual(bank.addressBook.get(LIVE_KEY).urls, [LIVE_URL, LIVE_PAIR_URL]);
  assert.equal(bank.pairUrlFor(LIVE_URL), LIVE_PAIR_URL);
  assert.equal(bank.pairUrlFor(LIVE_PAIR_URL), LIVE_URL);
  bank.destroy();
  const broken = createLiveBank({ playinfo: { data: { playurl_info: { unexpected: true } } } });
  broken.bank.readInlineLivePlayinfo();
  assert.equal(broken.bank.pairUrlFor(LIVE_URL), undefined);
  broken.bank.destroy();
});

test('the live address book joins the codec base_url and per-entry extra across question-mark variants', () => {
  const collected = [];
  visitLiveUrlInfoGroups(livePlayurlBody(), (group, groupBaseUrl) => collected.push({ group, groupBaseUrl }));
  assert.equal(collected.length, 1);
  assert.equal(collected[0].groupBaseUrl, `${LIVE_KEY}?`);
  assert.deepEqual(
    collected[0].group.map((info) => ({ host: info.host, extra: info.extra })),
    [LIVE_URL, LIVE_PAIR_URL].map((url) => {
      const parsed = new URL(url);
      return { host: parsed.origin, extra: parsed.search.slice(1) };
    }),
  );
  for (const [codecBaseUrl, extraPrefix] of [
    [`${LIVE_KEY}?`, ''],
    [LIVE_KEY, ''],
    [LIVE_KEY, '?'],
  ]) {
    const entries = [LIVE_URL, LIVE_PAIR_URL].map((url) => {
      const parsed = new URL(url);
      return { host: parsed.origin, extra: `${extraPrefix}${parsed.search.slice(1)}` };
    });
    const { bank } = createLiveBank({ playinfo: liveUrlInfoBody(entries, codecBaseUrl) });
    bank.readInlineLivePlayinfo();
    assert.equal(bank.pairUrlFor(LIVE_URL), LIVE_PAIR_URL);
    assert.equal(bank.pairUrlFor(LIVE_PAIR_URL), LIVE_URL);
    bank.destroy();
  }
});

test('a live url_info group disagreeing on the stream path is skipped', () => {
  const { bank } = createLiveBank({
    playinfo: liveUrlInfoBody([
      liveUrlInfoEntry(LIVE_URL),
      {
        host: 'https://d1--ov-gotcha07b.bilivideo.com',
        base_url: '/live-bvc/1/other.flv?',
        extra: 'expires=4102444800&sign=backup',
      },
    ], `${LIVE_KEY}?`),
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    bank.readInlineLivePlayinfo();
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0][1].message, /直播主备地址路径不一致/);
  assert.equal(bank.addressBook.size, 0);
  assert.equal(bank.pairUrlFor(LIVE_URL), undefined);
  bank.destroy();
});

test('a live url_info group with no path source is skipped with an error', () => {
  const { bank } = createLiveBank({
    playinfo: liveUrlInfoBody([
      liveUrlInfoEntry(LIVE_URL),
      { host: 'https://d1--ov-gotcha07b.bilivideo.com', extra: 'expires=4102444800&sign=backup' },
    ]),
  });
  const halfResolvable = createLiveBank({
    playinfo: liveUrlInfoBody([
      { url: LIVE_URL },
      { host: 'https://d1--ov-gotcha07b.bilivideo.com', extra: 'expires=4102444800&sign=backup' },
    ]),
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    bank.readInlineLivePlayinfo();
    halfResolvable.bank.readInlineLivePlayinfo();
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 2);
  assert.equal(bank.addressBook.size, 0);
  assert.equal(bank.pairUrlFor(LIVE_URL), undefined);
  assert.equal(halfResolvable.bank.addressBook.size, 0);
  assert.equal(halfResolvable.bank.pairUrlFor(LIVE_URL), undefined);
  bank.destroy();
  halfResolvable.bank.destroy();
});

test('live stitcher opens racing delivery only after the shared prefix compares equal', () => {
  const { stitcher, harness } = stitcherHarness();
  stitcher.noteLegBytes(0, encoded('AB'));
  stitcher.noteLegBytes(1, encoded('AB'));
  assert.deepEqual(harness.delivered, []);
  assert.deepEqual(harness.stitches, []);
  stitcher.noteLegBytes(0, encoded('CDEFGH'));
  stitcher.noteLegBytes(1, encoded('CDEFGH'));
  assert.deepEqual(harness.stitches, [
    { streamPath: LIVE_KEY, bytesChecked: 8, mismatch: false, phase: 'prefix' },
  ]);
  assert.deepEqual(harness.delivered, [{ bytes: [...encoded('ABCDEFGH')], start: 0, end: 7 }]);
  assert.deepEqual(
    harness.chunks.map(({ slot, result, bytes, chunkIndex: index }) => [slot, result, bytes, index]),
    [[0, 'fetched', 8, 0], [1, 'lost_race', 8, 0]],
  );
  assert.equal(harness.chunks[0].ttfbMs, 0);
  stitcher.noteLegBytes(0, encoded('IJKLMNOP'));
  assert.deepEqual(harness.delivered.at(-1), { bytes: [...encoded('IJKLMNOP')], start: 8, end: 15 });
  stitcher.noteLegDone(0);
  stitcher.noteLegDone(1);
  assert.equal(harness.failed, false);
  assert.equal(harness.closed, true);
});

test('live stitcher degrades to the player-named leg when the prefix mismatches', () => {
  const { stitcher, harness } = stitcherHarness();
  stitcher.noteLegBytes(0, encoded('ABCDEFGH'));
  stitcher.noteLegBytes(1, encoded('ABCxEFGH'));
  assert.deepEqual(harness.stitches, [
    { streamPath: LIVE_KEY, bytesChecked: 4, mismatch: true, phase: 'prefix' },
  ]);
  assert.deepEqual(harness.cancelled, [1]);
  assert.deepEqual(harness.delivered, [{ bytes: [...encoded('ABCDEFGH')], start: 0, end: 7 }]);
  stitcher.noteLegBytes(0, encoded('IJ'));
  stitcher.noteLegDone(0);
  assert.equal(harness.closed, true);
  assert.equal(harness.failed, false);
  const deliveredText = new TextDecoder().decode(
    Uint8Array.from(harness.delivered.flatMap((piece) => piece.bytes)),
  );
  assert.equal(deliveredText, 'ABCDEFGHIJ');
  assert.deepEqual(
    harness.chunks.map(({ slot, result, bytes }) => [slot, result, bytes]),
    [[1, 'lost_race', 8], [1, 'lost_race', 0], [0, 'fetched', 8], [0, 'fetched', 2]],
  );
});

test('live stitcher keeps the leading leg and revokes the other on a late mismatch', () => {
  const { stitcher, harness } = stitcherHarness();
  stitcher.noteLegBytes(0, encoded('ABCDEFGH'));
  stitcher.noteLegBytes(1, encoded('ABCDEFGH'));
  stitcher.noteLegBytes(0, encoded('IJKLMNOP'));
  assert.deepEqual(harness.delivered.at(-1), { bytes: [...encoded('IJKLMNOP')], start: 8, end: 15 });
  stitcher.noteLegBytes(1, encoded('IJxLMNOP'));
  assert.deepEqual(harness.stitches, [
    { streamPath: LIVE_KEY, bytesChecked: 8, mismatch: false, phase: 'prefix' },
    { streamPath: LIVE_KEY, bytesChecked: 19, mismatch: true, phase: 'stream' },
  ]);
  assert.deepEqual(harness.cancelled, [1]);
  stitcher.noteLegBytes(0, encoded('QRST'));
  stitcher.noteLegDone(0);
  assert.equal(harness.closed, true);
  assert.equal(harness.failed, false);
  const deliveredText = new TextDecoder().decode(
    Uint8Array.from(harness.delivered.flatMap((piece) => piece.bytes)),
  );
  assert.equal(deliveredText, 'ABCDEFGHIJKLMNOPQRST');
});

test('live stitcher releases delivered windows instead of retaining them for a long-running single leg', () => {
  const { stitcher, harness } = stitcherHarness({ legCount: 1 });
  for (let index = 0; index < 50; index += 1) stitcher.noteLegBytes(0, encoded('ABCDEFGH'));
  assert.equal(harness.delivered.length, 50);
  assert.equal(stitcher.legs[0].ahead.size, 0);
  stitcher.noteLegDone(0);
  assert.equal(harness.closed, true);
});

test('live stitcher treats a stalled backup leg during the gate as a single-leg death', () => {
  const { stitcher, harness } = stitcherHarness();
  stitcher.noteLegBytes(0, encoded('ABCDEFGH'));
  stitcher.noteLegBytes(0, encoded('IJKLMNOP'));
  stitcher.noteLegBytes(1, encoded('ABCD'));
  assert.deepEqual(harness.delivered, []);
  stitcher.noteLegDead(1, 'stalled');
  assert.deepEqual(harness.stitches, []);
  assert.deepEqual(harness.cancelled, []);
  const stalled = harness.chunks.find(({ result }) => result === 'stalled');
  assert.equal(stalled.slot, 1);
  assert.equal(stalled.bytes, 4);
  assert.deepEqual(harness.delivered, [
    { bytes: [...encoded('ABCDEFGH')], start: 0, end: 7 },
    { bytes: [...encoded('IJKLMNOP')], start: 8, end: 15 },
  ]);
  stitcher.noteLegDone(0);
  assert.equal(harness.closed, true);
  assert.equal(harness.failed, false);
});

test('live stitcher fails the stream when both legs die', () => {
  const { stitcher, harness } = stitcherHarness();
  stitcher.noteLegBytes(0, encoded('ABCDEFGH'));
  stitcher.noteLegBytes(1, encoded('ABCDEFGH'));
  stitcher.noteLegDead(0, 'network_error');
  assert.equal(harness.failed, false);
  stitcher.noteLegDead(1, 'http_error');
  assert.equal(harness.failed, true);
  assert.equal(harness.closed, false);
});

test('live fetch takeover races the inline-paired backup and streams the winner', async () => {
  const feeds = { [LIVE_URL]: liveFeed(), [LIVE_PAIR_URL]: liveFeed() };
  const calls = [];
  const { bank, windowObject } = createLiveBank({
    playinfo: livePlayurlBody(),
    nativeFetch: async (url) => {
      calls.push(url);
      return feeds[url].response;
    },
  });
  const response = await liveFetchThrough(bank);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'video/x-flv');
  assert.deepEqual(calls, [LIVE_URL, LIVE_PAIR_URL]);
  feeds[LIVE_URL].push(encoded('ABCD'));
  feeds[LIVE_PAIR_URL].push(encoded('ABCD'));
  await tick();
  feeds[LIVE_URL].push(encoded('EFGH'));
  feeds[LIVE_PAIR_URL].push(encoded('EFGH'));
  feeds[LIVE_URL].close();
  feeds[LIVE_PAIR_URL].close();
  assert.equal(await response.text(), 'ABCDEFGH');
  await tick();
  const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(serve.data.result, 'hit');
  assert.equal(serve.data.reason, 'live_stream');
  assert.equal(serve.data.mirror, 'd1--ov-gotcha07.bilivideo.com');
  assert.equal(typeof serve.data.durationMs, 'number');
  const stitches = windowObject.messages.filter((message) => message.code === 'live.stream.stitch');
  assert.deepEqual(stitches.map((message) => message.data), [
    { streamPath: LIVE_KEY, bytesChecked: 8, mismatch: false, phase: 'prefix' },
  ]);
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.bytes, data.chunkIndex, data.priority]),
    [[0, 'fetched', 8, 0, 'foreground'], [1, 'lost_race', 8, 0, 'foreground']],
  );
  assert.equal(chunks[0].data.mirror, 'd1--ov-gotcha07.bilivideo.com');
  assert.equal(chunks[1].data.mirror, 'd1--ov-gotcha07b.bilivideo.com');
  assert.equal(bank.resourceState.size, 0);
  assert.equal(bank.inflight.size, 0);
  bank.destroy();
});

test('live fetch takeover without a pair covers the stream with the player-named URL alone', async () => {
  const feed = liveFeed();
  const { bank, windowObject } = createLiveBank({ nativeFetch: async () => feed.response });
  const response = await liveFetchThrough(bank);
  feed.push(encoded('XYZ'));
  feed.close();
  assert.equal(await response.text(), 'XYZ');
  const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(serve.data.result, 'hit');
  assert.equal(serve.data.reason, 'live_stream_unpaired');
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.bytes]),
    [[0, 'fetched', 3]],
  );
  assert.equal(windowObject.messages.some((message) => message.code === 'live.stream.stitch'), false);
  bank.destroy();
});

test('live takeover treats expired signatures as invalid addresses and fails when none remain', async () => {
  const expiredMain = 'https://d1--ov-gotcha07.bilivideo.com/live-bvc/1/stream.flv?expires=946684800&sign=main';
  const expiredBackup = 'https://d1--ov-gotcha07b.bilivideo.com/live-bvc/1/stream.flv?expires=946684800&sign=backup';
  let nativeCalled = 0;
  const { bank, windowObject } = createLiveBank({
    playinfo: livePlayurlBody(expiredMain, expiredBackup),
    nativeFetch: async () => {
      nativeCalled += 1;
      return liveFeed().response;
    },
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(liveFetchThrough(bank, expiredMain), /直播流地址签名到期且无可用地址/);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  assert.equal(nativeCalled, 0);
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.bytes]),
    [[0, 'address_expired', 0], [1, 'address_expired', 0]],
  );
  assert.equal(windowObject.messages.some((message) => message.code === 'bank.serve'
    && message.data.result === 'hit'), false);
  bank.destroy();
});

test('live takeover drops an expired pair address and continues with the player URL', async () => {
  const expiredBackup = 'https://d1--ov-gotcha07b.bilivideo.com/live-bvc/1/stream.flv?expires=946684800&sign=backup';
  const feed = liveFeed();
  const calls = [];
  const { bank, windowObject } = createLiveBank({
    playinfo: livePlayurlBody(LIVE_URL, expiredBackup),
    nativeFetch: async (url) => {
      calls.push(url);
      return feed.response;
    },
  });
  const response = await liveFetchThrough(bank);
  feed.push(encoded('OK'));
  feed.close();
  assert.equal(await response.text(), 'OK');
  assert.deepEqual(calls, [LIVE_URL]);
  const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(serve.data.reason, 'live_stream_unpaired');
  const expired = windowObject.messages.find((message) => message.code === 'bank.fetch.chunk'
    && message.data.result === 'address_expired');
  assert.equal(expired.data.slot, 1);
  bank.destroy();
});

test('live fetch passes playlists and other live media back with their own reasons', async () => {
  let nativeCalled = 0;
  const { bank, windowObject } = createLiveBank({
    nativeFetch: async () => {
      nativeCalled += 1;
      return new Response('playlist');
    },
  });
  const response = await liveFetchThrough(bank, LIVE_HLS_URL);
  assert.equal(await response.text(), 'playlist');
  assert.equal(nativeCalled, 1);
  const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.deepEqual(serve.data, {
    source: 'https://d1--ov-gotcha105.bilivideo.com/live-bvc/1/index.m3u8',
    mirror: 'd1--ov-gotcha105.bilivideo.com',
    result: 'pass',
    reason: 'live_hls_playlist',
  });
  const other = await liveFetchThrough(bank, 'https://d1--ov-gotcha207.bilivideo.com/live-bvc/1/keepalive.txt?x=1');
  assert.equal(await other.text(), 'playlist');
  const otherServe = windowObject.messages.filter((message) => message.code === 'bank.serve').at(-1);
  assert.equal(otherServe.data.reason, 'live_other_media');
  bank.destroy();
});

test('live fetch observes the player playurl traffic as an address-book supplement', async () => {
  const { bank } = createLiveBank({
    nativeFetch: async () => new Response(JSON.stringify(livePlayurlBody()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  });
  const response = await liveFetchThrough(bank, LIVE_PLAYURL_URL);
  assert.equal(response.status, 200);
  assert.equal(bank.pairUrlFor(LIVE_URL), LIVE_PAIR_URL);
  bank.destroy();
});

test('a stalled backup leg during the live gate degrades through the real stall timer', async () => {
  const timers = manualTimers();
  const feeds = { [LIVE_URL]: liveFeed(), [LIVE_PAIR_URL]: liveFeed() };
  const { bank, windowObject } = createLiveBank({
    playinfo: livePlayurlBody(),
    timers,
    nativeFetch: async (url) => feeds[url].response,
  });
  const response = await liveFetchThrough(bank);
  feeds[LIVE_URL].push(encoded('ABCDEFGH'));
  feeds[LIVE_PAIR_URL].push(encoded('ABCD'));
  await tick();
  assert.equal(windowObject.messages.some((message) => message.code === 'live.stream.stitch'), false);
  const pendingIds = [...timers.pending.keys()];
  assert.equal(pendingIds.length, 2);
  timers.fireId(pendingIds.at(-1));
  await tick();
  const stalled = windowObject.messages.find((message) => message.code === 'bank.fetch.chunk'
    && message.data.result === 'stalled');
  assert.equal(stalled.data.slot, 1);
  assert.equal(stalled.data.bytes, 4);
  assert.equal(windowObject.messages.some((message) => message.code === 'live.stream.stitch'), false);
  feeds[LIVE_URL].push(encoded('IJKLMNOP'));
  feeds[LIVE_URL].close();
  assert.equal(await response.text(), 'ABCDEFGHIJKLMNOP');
  assert.equal(feeds[LIVE_PAIR_URL].cancelled, true);
  const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(serve.data.reason, 'live_stream');
  bank.destroy();
});

test('live fetch logs a console error when the sole leg stalls after streaming already started', async () => {
  const timers = manualTimers();
  const feed = liveFeed();
  const { bank } = createLiveBank({
    timers,
    nativeFetch: async () => feed.response,
  });
  const response = await liveFetchThrough(bank);
  feed.push(encoded('ABCDEFGH'));
  await tick();
  const pendingIds = [...timers.pending.keys()];
  assert.equal(pendingIds.length, 1);
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    timers.fireId(pendingIds.at(-1));
    await assert.rejects(response.text(), /直播流双腿取数失败/);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  bank.destroy();
});

test('live fetch surfaces an explicit failure when both legs die', async () => {
  const feeds = { [LIVE_URL]: liveFeed({ status: 500 }), [LIVE_PAIR_URL]: liveFeed({ status: 500 }) };
  const { bank, windowObject } = createLiveBank({
    playinfo: livePlayurlBody(),
    nativeFetch: async (url) => feeds[url].response,
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(liveFetchThrough(bank), /直播流双腿取数失败/);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result]),
    [[0, 'http_error'], [1, 'http_error']],
  );
  bank.destroy();
});

test('live XHR takeover races the paired backup and streams response bytes', async () => {
  const feeds = { [LIVE_URL]: liveFeed(), [LIVE_PAIR_URL]: liveFeed() };
  const calls = [];
  const { bank, windowObject } = createLiveBank({
    playinfo: livePlayurlBody(),
    nativeFetch: async (url) => {
      calls.push(url);
      return feeds[url].response;
    },
  });
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.responseType = 'arraybuffer';
  const events = [];
  xhr.addEventListener('readystatechange', () => events.push(`readystatechange:${xhr.readyState}`));
  xhr.addEventListener('progress', () => events.push(`progress:${xhr._liveLoaded}`));
  xhr.open('GET', LIVE_URL);
  xhr.send();
  assert.equal(xhr._intercepted, true);
  await tick();
  assert.deepEqual(calls, [LIVE_URL, LIVE_PAIR_URL]);
  feeds[LIVE_URL].push(encoded('ABCD'));
  feeds[LIVE_PAIR_URL].push(encoded('ABCD'));
  await tick();
  feeds[LIVE_URL].push(encoded('EFGH'));
  feeds[LIVE_PAIR_URL].push(encoded('EFGH'));
  feeds[LIVE_URL].close();
  feeds[LIVE_PAIR_URL].close();
  await new Promise((resolve) => xhr.addEventListener('loadend', resolve));
  assert.equal(xhr.status, 200);
  assert.deepEqual([...new Uint8Array(xhr.response)], [...encoded('ABCDEFGH')]);
  assert.equal(xhr._native.sendCalls.length, 0);
  assert.equal(events[0], 'readystatechange:2');
  assert.equal(events[1], 'readystatechange:3');
  assert.equal(events.at(-1), 'readystatechange:4');
  const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(serve.data.result, 'hit');
  assert.equal(serve.data.reason, 'live_stream');
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.bytes, data.chunkIndex]),
    [[0, 'fetched', 8, 0], [1, 'lost_race', 8, 0]],
  );
  assert.equal(windowObject.messages.filter((message) => message.code === 'live.stream.stitch').length, 1);
  bank.destroy();
});

test('live XHR passes non-flv live media and synchronous requests back', async () => {
  for (const [url, asyncFlag, reason] of [
    [LIVE_HLS_URL, true, 'live_hls_playlist'],
    [LIVE_URL, false, 'sync_xhr'],
  ]) {
    const { bank, windowObject } = createLiveBank({ nativeFetch: async () => new Response('x') });
    windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
      windowObject,
      nativeConstructor: NativeXHR,
      bank,
    });
    const xhr = new windowObject.XMLHttpRequest();
    if (asyncFlag) xhr.open('GET', url);
    else xhr.open('GET', url, false);
    xhr.send();
    const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
    assert.equal(serve.data.result, 'pass');
    assert.equal(serve.data.reason, reason);
    assert.equal(xhr._native.sendCalls.length, 1);
    assert.equal(xhr._intercepted, false);
    bank.destroy();
  }
});

test('live XHR observes live playurl traffic through responseText on load', async () => {
  const { bank, windowObject } = createLiveBank({ nativeFetch: async () => new Response('x') });
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  const xhr = new windowObject.XMLHttpRequest();
  xhr.open('GET', LIVE_PLAYURL_URL);
  xhr.send();
  xhr._native.responseText = JSON.stringify(livePlayurlBody());
  xhr._native.emit('load');
  await tick();
  assert.equal(bank.pairUrlFor(LIVE_URL), LIVE_PAIR_URL);
  bank.destroy();
});

test('live XHR surfaces an explicit failure when every address is expired', async () => {
  const expiredMain = 'https://d1--ov-gotcha07.bilivideo.com/live-bvc/1/stream.flv?expires=946684800&sign=main';
  const expiredBackup = 'https://d1--ov-gotcha07b.bilivideo.com/live-bvc/1/stream.flv?expires=946684800&sign=backup';
  const { bank, windowObject } = createLiveBank({
    playinfo: livePlayurlBody(expiredMain, expiredBackup),
    nativeFetch: async () => new Response('x'),
  });
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  const xhr = new windowObject.XMLHttpRequest();
  const events = [];
  xhr.addEventListener('error', () => events.push('error'));
  xhr.addEventListener('loadend', () => events.push('loadend'));
  xhr.open('GET', expiredMain);
  xhr.send();
  await tick();
  assert.deepEqual(events, ['error', 'loadend']);
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result]),
    [[0, 'address_expired'], [1, 'address_expired']],
  );
  bank.destroy();
});

test('live pairing evaluator names the three miss branches and keeps pairUrlFor unchanged', () => {
  const clock = { value: 100000 };
  const { bank } = createLiveBank({ nativeFetch: async () => new Response('x'), now: () => clock.value });
  assert.deepEqual(bank.evaluateLivePair(LIVE_URL), { pairUrl: undefined, miss: 'no_book_entry' });

  bank.observeLivePlayurlData(livePlayurlBody());
  const pairedDecision = bank.evaluateLivePair(LIVE_URL);
  assert.equal(pairedDecision.pairUrl, LIVE_PAIR_URL);
  assert.equal(pairedDecision.miss, undefined);
  assert.equal(bank.pairUrlFor(LIVE_URL), LIVE_PAIR_URL);

  clock.value += 3600000 + 1;
  assert.deepEqual(bank.evaluateLivePair(LIVE_URL), { pairUrl: undefined, miss: 'stale' });
  assert.equal(bank.pairUrlFor(LIVE_URL), undefined);
  bank.destroy();

  const single = createLiveBank({ nativeFetch: async () => new Response('x') });
  single.bank.observeLivePlayurlData(liveUrlInfoBody(
    [liveUrlInfoEntry(LIVE_URL)],
    `${new URL(LIVE_URL).pathname}?`,
  ));
  assert.deepEqual(single.bank.evaluateLivePair(LIVE_URL), { pairUrl: undefined, miss: 'no_alt_host' });
  assert.equal(single.bank.pairUrlFor(LIVE_URL), undefined);
  single.bank.destroy();
});

test('live playurl observation emits channel, group counts, and error names', () => {
  const { bank, windowObject } = createLiveBank({ nativeFetch: async () => new Response('x') });

  bank.observeLivePlayurlData(undefined);
  let observed = windowObject.messages.at(-1);
  assert.equal(observed.code, 'live.playurl_observed');
  assert.deepEqual(observed.data, { channel: 'playinfo_api', groupCount: 0, flvGroupCount: 0 });

  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    bank.observeLivePlayurlData('{broken json');
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  observed = windowObject.messages.at(-1);
  assert.equal(observed.code, 'live.playurl_observed');
  assert.deepEqual(observed.data, {
    channel: 'playinfo_api',
    groupCount: 0,
    flvGroupCount: 0,
    errorName: 'SyntaxError',
  });
  const logError = windowObject.messages.filter((message) => message.code === 'log.error').at(-1);
  assert.equal(logError.data.code, 'LIVE_PLAYURL');
  assert.equal(logError.data.errorName, 'SyntaxError');

  bank.observeLivePlayurlData(livePlayurlBody());
  observed = windowObject.messages.at(-1);
  assert.deepEqual(observed.data, { channel: 'playinfo_api', groupCount: 1, flvGroupCount: 1 });

  const hlsGroup = liveUrlInfoBody(
    [liveUrlInfoEntry('https://d1--ov-gotcha105.bilivideo.com/live-bvc/1/index.m3u8?expires=4102444800&sign=hls')],
    '/live-bvc/1/index.m3u8?',
  );
  bank.observeLivePlayurlData(hlsGroup, 'playinfo_api');
  observed = windowObject.messages.at(-1);
  assert.deepEqual(observed.data, { channel: 'playinfo_api', groupCount: 1, flvGroupCount: 0 });
  bank.destroy();
});

test('live inline address-book read reports the inline_blob channel and zero groups when absent', () => {
  const { bank, windowObject } = createLiveBank({ nativeFetch: async () => new Response('x') });
  bank.readInlineLivePlayinfo();
  const observed = windowObject.messages.at(-1);
  assert.equal(observed.code, 'live.playurl_observed');
  assert.deepEqual(observed.data, { channel: 'inline_blob', groupCount: 0, flvGroupCount: 0 });
  bank.destroy();

  const withInline = createLiveBank({
    nativeFetch: async () => new Response('x'),
    playinfo: livePlayurlBody(),
  });
  withInline.bank.readInlineLivePlayinfo();
  const inlineObserved = withInline.windowObject.messages.at(-1);
  assert.equal(inlineObserved.code, 'live.playurl_observed');
  assert.deepEqual(inlineObserved.data, { channel: 'inline_blob', groupCount: 1, flvGroupCount: 1 });
  withInline.bank.destroy();
});

test('live serve hit events carry pairMiss on unpaired and pairedAddressAvailable on paired', async () => {
  const pairedFeeds = { [LIVE_URL]: liveFeed(), [LIVE_PAIR_URL]: liveFeed() };
  const paired = createLiveBank({
    playinfo: livePlayurlBody(),
    nativeFetch: async (url) => pairedFeeds[url].response,
  });
  const pairedResponse = await liveFetchThrough(paired.bank);
  pairedFeeds[LIVE_URL].push(encoded('ABCD'));
  pairedFeeds[LIVE_PAIR_URL].push(encoded('ABCD'));
  await tick();
  pairedFeeds[LIVE_URL].close();
  pairedFeeds[LIVE_PAIR_URL].close();
  await pairedResponse.text();
  const pairedServe = paired.windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(pairedServe.data.result, 'hit');
  assert.equal(pairedServe.data.pairedAddressAvailable, true);
  assert.equal(Object.hasOwn(pairedServe.data, 'pairMiss'), false);
  paired.bank.destroy();

  const single = liveFeed();
  const unpaired = createLiveBank({ nativeFetch: async () => single.response });
  const response = await liveFetchThrough(unpaired.bank);
  single.push(encoded('OK'));
  single.close();
  assert.equal(await response.text(), 'OK');
  const unpairedServe = unpaired.windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(unpairedServe.data.reason, 'live_stream_unpaired');
  assert.equal(unpairedServe.data.pairMiss, 'no_book_entry');
  assert.equal(Object.hasOwn(unpairedServe.data, 'pairedAddressAvailable'), false);
  unpaired.bank.destroy();
});

test('live takeover emits one failed serve with errorName when every address is expired', async () => {
  const expiredMain = 'https://d1--ov-gotcha07.bilivideo.com/live-bvc/1/stream.flv?expires=946684800&sign=main';
  const expiredBackup = 'https://d1--ov-gotcha07b.bilivideo.com/live-bvc/1/stream.flv?expires=946684800&sign=backup';
  const { bank, windowObject } = createLiveBank({
    playinfo: livePlayurlBody(expiredMain, expiredBackup),
    nativeFetch: async () => new Response('x'),
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(liveFetchThrough(bank, expiredMain), /直播流地址签名到期且无可用地址/);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  const failedServes = windowObject.messages.filter((message) => message.code === 'bank.serve'
    && message.data.result === 'failed');
  assert.equal(failedServes.length, 1);
  assert.equal(failedServes[0].data.reason, 'live_stream_failed');
  assert.equal(failedServes[0].data.errorName, 'BankNetworkError');
  assert.equal(typeof failedServes[0].data.durationMs, 'number');
  const logErrors = windowObject.messages.filter((message) => message.code === 'log.error');
  assert.equal(logErrors.length, 1);
  assert.equal(logErrors[0].data.code, 'LIVE_TAKEOVER');
  bank.destroy();
});

test('live takeover emits exactly one failed serve after both legs die', async () => {
  const feeds = { [LIVE_URL]: liveFeed({ status: 500 }), [LIVE_PAIR_URL]: liveFeed({ status: 500 }) };
  const { bank, windowObject } = createLiveBank({
    playinfo: livePlayurlBody(),
    nativeFetch: async (url) => feeds[url].response,
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(liveFetchThrough(bank), /直播流双腿取数失败/);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  const failedServes = windowObject.messages.filter((message) => message.code === 'bank.serve'
    && message.data.result === 'failed');
  assert.equal(failedServes.length, 1);
  assert.equal(failedServes[0].data.reason, 'live_stream_failed');
  assert.equal(failedServes[0].data.errorName, 'BankNetworkError');
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.httpStatus]),
    [[0, 'http_error', 500], [1, 'http_error', 500]],
  );
  bank.destroy();
});

test('live chunk events carry errorName on network errors and omit details on success paths', async () => {
  const { bank, windowObject } = createLiveBank({
    nativeFetch: async () => { throw new TypeError('fetch failed'); },
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(liveFetchThrough(bank), /直播流双腿取数失败/);
  } finally {
    console.error = originalError;
  }
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].data.result, 'network_error');
  assert.equal(chunks[0].data.errorName, 'TypeError');
  assert.equal(Object.hasOwn(chunks[0].data, 'httpStatus'), false);
  assert.equal(errors.length, 1);
  assert.equal(windowObject.messages.some((message) => message.code === 'log.error'
    && message.data.code === 'LIVE_TAKEOVER'), true);
  bank.destroy();

  const feeds = { [LIVE_URL]: liveFeed(), [LIVE_PAIR_URL]: liveFeed() };
  const paired = createLiveBank({
    playinfo: livePlayurlBody(),
    nativeFetch: async (url) => feeds[url].response,
  });
  const response = await liveFetchThrough(paired.bank);
  feeds[LIVE_URL].push(encoded('ABCD'));
  feeds[LIVE_PAIR_URL].push(encoded('ABCD'));
  await tick();
  feeds[LIVE_URL].close();
  feeds[LIVE_PAIR_URL].close();
  assert.equal(await response.text(), 'ABCD');
  const successChunks = paired.windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.equal(successChunks.length > 0, true);
  for (const chunk of successChunks) {
    assert.equal(Object.hasOwn(chunk.data, 'httpStatus'), false);
    assert.equal(Object.hasOwn(chunk.data, 'errorName'), false);
  }
  paired.bank.destroy();
});

// ---- HLS 直播分片 ----

function segmentFeed(bytes, { status = 200, headers = { 'Content-Type': 'video/mp4' } } = {}) {
  const feed = liveFeed({ status, headers });
  feed.push(bytes);
  feed.close();
  return feed;
}

function hlsFetchThrough(bank, url = HLS_SEGMENT_URL, init = {}) {
  return liveFetchThrough(bank, url, init);
}

test('hls segment pairing builds the paired url from the entry host, its own query, and the same stream path', () => {
  const { bank } = createLiveBank({ nativeFetch: async () => new Response('x') });
  assert.deepEqual(bank.pairSegmentDecisionFor(new URL(HLS_SEGMENT_URL)), {
    pairUrl: undefined,
    miss: 'no_book_entry',
  });

  bank.observeLivePlayurlData(HLS_PLAYURL_BODY);
  const pairedForPlayer = bank.pairSegmentDecisionFor(new URL(HLS_SEGMENT_URL));
  assert.equal(pairedForPlayer.pairUrl, HLS_SEGMENT_PAIR_FOR_PLAYER);
  assert.equal(pairedForPlayer.miss, undefined);
  // 播放器本身命名主址时分到备址，配对 query 用条目自己的签名。
  const pairedForMain = bank.pairSegmentDecisionFor(new URL(HLS_SEGMENT_ON_MAIN_URL));
  assert.equal(pairedForMain.pairUrl, HLS_SEGMENT_PAIR_FOR_MAIN);
  assert.equal(pairedForMain.miss, undefined);
  // init 分片与媒体分片同流目录，同样配对。
  assert.equal(
    bank.pairSegmentDecisionFor(new URL(HLS_SEGMENT_INIT_URL)).pairUrl,
    `https://d1--ov-gotcha105.bilivideo.com${HLS_STREAM_DIR}423384050_init.m4s?expires=4102444800&sign=hls105`,
  );

  // 跨流目录（跨 cluster 的另一条流）不配：只认同目录的 .m3u8 条目。
  const otherStream = liveUrlInfoBody(
    [liveUrlInfoEntry('https://d1--ov-gotcha07.bilivideo.com/live-bvc/247297/live_other.flv?expires=4102444800&sign=flv')],
    '/live-bvc/247297/live_other.flv?',
  );
  bank.observeLivePlayurlData(otherStream);
  assert.equal(
    bank.pairSegmentDecisionFor(new URL(HLS_SEGMENT_URL)).pairUrl,
    HLS_SEGMENT_PAIR_FOR_PLAYER,
  );
  assert.deepEqual(bank.pairSegmentDecisionFor(new URL(
    `https://d1--ov-gotcha07.bilivideo.com/live-bvc/247297/423384050.m4s?x=1`,
  )), { pairUrl: undefined, miss: 'no_book_entry' });

  // 只有单腿条目时，条目主机与播放器主机不同仍配对。
  const single = createLiveBank({ nativeFetch: async () => new Response('x') });
  single.bank.observeLivePlayurlData(liveUrlInfoBody(
    [liveUrlInfoEntry(HLS_MAIN_PLAYLIST)],
    `${HLS_STREAM_DIR}index.m3u8?`,
  ));
  assert.equal(
    single.bank.pairSegmentDecisionFor(new URL(HLS_SEGMENT_URL)).pairUrl,
    HLS_SEGMENT_PAIR_FOR_PLAYER,
  );
  // 播放器命名的就是条目主机时无备可配。
  assert.deepEqual(single.bank.pairSegmentDecisionFor(new URL(HLS_SEGMENT_ON_MAIN_URL)), {
    pairUrl: undefined,
    miss: 'no_alt_host',
  });
  single.bank.destroy();

  // 条目过期不配。
  const clock = { value: 100000 };
  const stale = createLiveBank({ nativeFetch: async () => new Response('x'), now: () => clock.value });
  stale.bank.observeLivePlayurlData(HLS_PLAYURL_BODY);
  clock.value += 3600000 + 1;
  assert.deepEqual(stale.bank.pairSegmentDecisionFor(new URL(HLS_SEGMENT_URL)), {
    pairUrl: undefined,
    miss: 'stale',
  });
  stale.bank.destroy();
  bank.destroy();
});

test('hls fetch gate compares the first raced pair in full, then races first-completion', async () => {
  const feeds = {
    [HLS_SEGMENT_URL]: segmentFeed(encoded('ABCD')),
    [HLS_SEGMENT_PAIR_FOR_PLAYER]: segmentFeed(encoded('ABCD')),
  };
  const calls = [];
  const { bank, windowObject } = createLiveBank({
    playinfo: HLS_PLAYURL_BODY,
    nativeFetch: async (url) => {
      calls.push(url);
      return feeds[url].response;
    },
  });
  const response = await hlsFetchThrough(bank);
  assert.equal(response.status, 200);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...encoded('ABCD')]);

  const stitch = windowObject.messages.find((message) => message.code === 'live.stream.stitch');
  assert.deepEqual(stitch.data, {
    streamPath: HLS_STREAM_DIR,
    bytesChecked: 4,
    mismatch: false,
    phase: 'segment',
  });
  const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(serve.data.result, 'hit');
  assert.equal(serve.data.reason, 'live_hls_segment');
  assert.equal(serve.data.pairedAddressAvailable, true);
  // 与视频页 bank.serve 命中同形：mirror 记播放器所名地址的主机（竞速各腿的主机记在
  // bank.fetch.chunk），不随胜出腿改变。
  assert.equal(serve.data.mirror, new URL(HLS_SEGMENT_URL).hostname);
  let chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.bytes, data.chunkIndex]),
    [[0, 'fetched', 4, 0], [1, 'lost_race', 4, 0]],
  );
  assert.deepEqual(calls, [HLS_SEGMENT_URL, HLS_SEGMENT_PAIR_FOR_PLAYER]);

  // 门开后的第二个分片：先完成的腿直接供给，另一腿取消，其已读字节按浪费口径记录。
  const nextFeeds = {
    [HLS_SEGMENT_NEXT_URL]: liveFeed(),
    [`https://d1--ov-gotcha105.bilivideo.com${HLS_STREAM_DIR}423384051.m4s?expires=4102444800&sign=hls105`]: liveFeed(),
  };
  const pairNext = `https://d1--ov-gotcha105.bilivideo.com${HLS_STREAM_DIR}423384051.m4s?expires=4102444800&sign=hls105`;
  bank.nativeFetch = async (url) => {
    calls.push(url);
    return nextFeeds[url].response;
  };
  const second = await hlsFetchThrough(bank, HLS_SEGMENT_NEXT_URL);
  const bodyPromise = second.arrayBuffer();
  nextFeeds[pairNext].push(encoded('EFGH'));
  nextFeeds[pairNext].close();
  await tick();
  await tick();
  assert.deepEqual([...new Uint8Array(await bodyPromise)], [...encoded('EFGH')]);
  assert.equal(nextFeeds[HLS_SEGMENT_NEXT_URL].cancelled, true);
  chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk').slice(-2);
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.bytes]),
    [[1, 'fetched', 4], [0, 'lost_race', 0]],
  );
  // 备址（另一主机）胜出的分片：bank.serve 命中仍记播放器所名主机，与视频页一致；
  // 胜出腿的主机在 bank.fetch.chunk 上。
  const secondServe = windowObject.messages.filter((message) => message.code === 'bank.serve').at(-1);
  assert.equal(secondServe.data.reason, 'live_hls_segment');
  assert.equal(secondServe.data.mirror, new URL(HLS_SEGMENT_NEXT_URL).hostname);
  assert.equal(chunks[0].data.mirror, new URL(pairNext).hostname);
  bank.destroy();
});

test('hls fetch identity mismatch downgrades the stream to permanent single leg', async () => {
  const calls = [];
  const feeds = {
    [HLS_SEGMENT_URL]: segmentFeed(encoded('ABCD')),
    [HLS_SEGMENT_PAIR_FOR_PLAYER]: segmentFeed(encoded('ABCE')),
  };
  const { bank, windowObject } = createLiveBank({
    playinfo: HLS_PLAYURL_BODY,
    nativeFetch: async (url) => {
      calls.push(url);
      return feeds[url].response;
    },
  });
  const response = await hlsFetchThrough(bank);
  // 不一致时交付播放器所名地址的字节。
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...encoded('ABCD')]);
  const stitch = windowObject.messages.find((message) => message.code === 'live.stream.stitch');
  assert.deepEqual(stitch.data, {
    streamPath: HLS_STREAM_DIR,
    bytesChecked: 4,
    mismatch: true,
    phase: 'segment',
  });
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.bytes]),
    [[0, 'fetched', 4], [1, 'lost_race', 4]],
  );

  // 后续分片单腿：只请求播放器所名地址。
  bank.nativeFetch = async (url) => {
    calls.push(url);
    return segmentFeed(encoded('WXYZ')).response;
  };
  const second = await hlsFetchThrough(bank, HLS_SEGMENT_NEXT_URL);
  assert.deepEqual([...new Uint8Array(await second.arrayBuffer())], [...encoded('WXYZ')]);
  assert.deepEqual(calls.slice(-1), [HLS_SEGMENT_NEXT_URL]);
  const secondServe = windowObject.messages.filter((message) => message.code === 'bank.serve').at(-1);
  assert.equal(secondServe.data.reason, 'live_hls_segment_unpaired');
  assert.equal(secondServe.data.pairedAddressAvailable, undefined);
  bank.destroy();
});

test('hls fetch delivers the survivor and permanently downgrades after repeated gate leg deaths', async () => {
  const calls = [];
  const { bank, windowObject } = createLiveBank({
    playinfo: HLS_PLAYURL_BODY,
    nativeFetch: async (url) => {
      calls.push(url);
      if (url === HLS_SEGMENT_URL) return segmentFeed(encoded('ABCD')).response;
      return segmentFeed(encoded('X'), { status: 503 }).response;
    },
  });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await hlsFetchThrough(bank, HLS_SEGMENT_URL);
    assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...encoded('ABCD')]);
  }
  const deadLegChunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk'
    && message.data.slot === 1);
  assert.deepEqual(deadLegChunks.map(({ data }) => data.result), ['http_error', 'http_error', 'http_error']);
  assert.deepEqual(deadLegChunks.map(({ data }) => data.httpStatus), [503, 503, 503]);

  // 三次门期失败后永久降级：下一分片只请求播放器所名地址。
  bank.nativeFetch = async (url) => {
    calls.push(url);
    return segmentFeed(encoded('WXYZ')).response;
  };
  const downgraded = await hlsFetchThrough(bank, HLS_SEGMENT_NEXT_URL);
  assert.deepEqual([...new Uint8Array(await downgraded.arrayBuffer())], [...encoded('WXYZ')]);
  assert.deepEqual(calls.slice(-1), [HLS_SEGMENT_NEXT_URL]);
  const serve = windowObject.messages.filter((message) => message.code === 'bank.serve').at(-1);
  assert.equal(serve.data.reason, 'live_hls_segment_unpaired');
  bank.destroy();
});

test('hls fetch fails explicitly when both legs fail', async () => {
  const { bank, windowObject } = createLiveBank({
    playinfo: HLS_PLAYURL_BODY,
    nativeFetch: async () => new Response('no', { status: 500 }),
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(hlsFetchThrough(bank), /直播分片双腿取数失败/);
  } finally {
    console.error = originalError;
  }
  assert.equal(errors.length, 1);
  const failedServes = windowObject.messages.filter((message) => message.code === 'bank.serve'
    && message.data.result === 'failed');
  assert.equal(failedServes.length, 1);
  assert.equal(failedServes[0].data.reason, 'live_hls_segment_failed');
  assert.equal(failedServes[0].data.errorName, 'BankNetworkError');
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.httpStatus]),
    [[0, 'http_error', 500], [1, 'http_error', 500]],
  );
  bank.destroy();
});

test('hls fetch without a pair covers the segment with the player-named URL alone', async () => {
  const calls = [];
  const { bank, windowObject } = createLiveBank({
    nativeFetch: async (url) => {
      calls.push(url);
      return segmentFeed(encoded('ABCD')).response;
    },
  });
  const response = await hlsFetchThrough(bank);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...encoded('ABCD')]);
  assert.deepEqual(calls, [HLS_SEGMENT_URL]);
  const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(serve.data.result, 'hit');
  assert.equal(serve.data.reason, 'live_hls_segment_unpaired');
  assert.equal(serve.data.pairMiss, 'no_book_entry');
  bank.destroy();
});

test('hls XHR takeover gates, races, and passes playlists through like the fetch channel', async () => {
  const feeds = {
    [HLS_SEGMENT_URL]: segmentFeed(encoded('ABCD')),
    [HLS_SEGMENT_PAIR_FOR_PLAYER]: segmentFeed(encoded('ABCD')),
  };
  const { bank, windowObject } = createLiveBank({
    playinfo: HLS_PLAYURL_BODY,
    nativeFetch: async (url) => feeds[url].response,
  });
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });

  const playlistXhr = new windowObject.XMLHttpRequest();
  playlistXhr.open('GET', LIVE_HLS_URL);
  playlistXhr.send();
  await tick();
  assert.equal(playlistXhr._native.sendCalls.length, 1);
  const playlistServe = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(playlistServe.data.reason, 'live_hls_playlist');

  const events = [];
  const xhr = new windowObject.XMLHttpRequest();
  xhr.responseType = 'arraybuffer';
  for (const type of ['readystatechange', 'load', 'loadend']) {
    xhr.addEventListener(type, () => events.push(`${type}:${xhr.readyState}`));
  }
  xhr.open('GET', HLS_SEGMENT_URL);
  xhr.send();
  await new Promise((resolve) => xhr.addEventListener('loadend', resolve));
  assert.equal(xhr.status, 200);
  assert.deepEqual([...new Uint8Array(xhr.response)], [...encoded('ABCD')]);
  assert.equal(xhr._native.sendCalls.length, 0);
  assert.equal(events[0], 'readystatechange:2');
  assert.equal(events.includes('load:4'), true);
  assert.equal(events.at(-1), 'loadend:4');
  const serve = windowObject.messages.filter((message) => message.code === 'bank.serve').at(-1);
  assert.equal(serve.data.result, 'hit');
  assert.equal(serve.data.reason, 'live_hls_segment');
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.bytes]),
    [[0, 'fetched', 4], [1, 'lost_race', 4]],
  );
  const stitch = windowObject.messages.find((message) => message.code === 'live.stream.stitch');
  assert.equal(stitch.data.mismatch, false);
  assert.equal(stitch.data.phase, 'segment');
  bank.destroy();
});

test('hls XHR surfaces an explicit failure when both segment legs fail', async () => {
  const { bank, windowObject } = createLiveBank({
    playinfo: HLS_PLAYURL_BODY,
    nativeFetch: async () => new Response('no', { status: 500 }),
  });
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
    windowObject,
    nativeConstructor: NativeXHR,
    bank,
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  const xhr = new windowObject.XMLHttpRequest();
  const events = [];
  xhr.addEventListener('error', () => events.push('error'));
  xhr.addEventListener('loadend', () => events.push('loadend'));
  xhr.open('GET', HLS_SEGMENT_URL);
  xhr.send();
  await tick();
  console.error = originalError;
  assert.deepEqual(events, ['error', 'loadend']);
  assert.equal(errors.length >= 1, true);
  const failedServes = windowObject.messages.filter((message) => message.code === 'bank.serve'
    && message.data.result === 'failed');
  assert.equal(failedServes.length, 1);
  assert.equal(failedServes[0].data.reason, 'live_hls_segment_failed');
  bank.destroy();
});

test('hls fetch stall rule kills a silent leg after stallMs and the survivor serves', async () => {
  const timers = manualTimers();
  const calls = [];
  const { bank, windowObject } = createLiveBank({
    playinfo: HLS_PLAYURL_BODY,
    timers,
    nativeFetch: async (url) => {
      calls.push(url);
      if (url === HLS_SEGMENT_URL) return segmentFeed(encoded('ABCD')).response;
      return liveFeed().response;
    },
  });
  const response = await hlsFetchThrough(bank);
  const bodyPromise = response.arrayBuffer();
  await tick();
  // 门期：先到且收完的腿不立即交付，等静默腿在 10 秒无字节后死亡再交付存活腿。
  assert.equal(windowObject.messages.some((message) => message.code === 'live.stream.stitch'), false);
  // 收完的腿计时器已清，只剩静默腿的停滞计时器。
  const stallTimerIds = [...timers.pending.keys()];
  assert.equal(stallTimerIds.length, 1);
  timers.fireId(stallTimerIds[0]);
  await tick();
  assert.deepEqual([...new Uint8Array(await bodyPromise)], [...encoded('ABCD')]);
  const chunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk');
  assert.deepEqual(
    chunks.map(({ data }) => [data.slot, data.result, data.bytes]),
    [[1, 'stalled', 0], [0, 'fetched', 4]],
  );
  // 门期一腿停滞按一次无法完整比对记；流未降级，但三次后降级由其余测试覆盖。
  const serve = windowObject.messages.find((message) => message.code === 'bank.serve');
  assert.equal(serve.data.result, 'hit');
  bank.destroy();
});

test('hls fetch treats expired segment signatures as invalid addresses and fails when none remain', async () => {
  const expiredSegment = `https://d1--ov-gotcha207.bilivideo.com${HLS_STREAM_DIR}423384050.m4s?expires=946684800&sign=old`;
  const expiredPair = `https://d1--ov-gotcha105.bilivideo.com${HLS_STREAM_DIR}423384050.m4s?expires=946684800&sign=old105`;
  const expiredBody = liveUrlInfoBody(
    [liveUrlInfoEntry(expiredPair.replace('.m4s', '.m3u8')), liveUrlInfoEntry(
      `https://d1--ov-gotcha105b.bilivideo.com${HLS_STREAM_DIR}index.m3u8?expires=946684800&sign=old105b`,
    )],
    `${HLS_STREAM_DIR}index.m3u8?`,
  );
  const { bank, windowObject } = createLiveBank({
    playinfo: expiredBody,
    nativeFetch: async () => new Response('x'),
  });
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    await assert.rejects(hlsFetchThrough(bank, expiredSegment), /直播分片地址签名到期且无可用地址/);
  } finally {
    console.error = originalError;
  }
  const expiredChunks = windowObject.messages.filter((message) => message.code === 'bank.fetch.chunk'
    && message.data.result === 'address_expired');
  assert.deepEqual(expiredChunks.map(({ data }) => [data.slot, data.chunkIndex]), [[0, 0], [1, 0]]);
  const failedServe = windowObject.messages.find((message) => message.code === 'bank.serve'
    && message.data.result === 'failed');
  assert.equal(failedServe.data.reason, 'live_hls_segment_failed');
  assert.equal(errors.length, 1);
  bank.destroy();

  // 播放器地址过期但配对地址有效时，仍由配对地址单腿接管。
  const calls = [];
  const mixed = createLiveBank({
    playinfo: HLS_PLAYURL_BODY,
    nativeFetch: async (url) => {
      calls.push(url);
      return segmentFeed(encoded('ABCD')).response;
    },
  });
  const expiredPlayer = `https://d1--ov-gotcha207.bilivideo.com${HLS_STREAM_DIR}423384050.m4s?expires=946684800&sign=old`;
  const response = await hlsFetchThrough(mixed.bank, expiredPlayer);
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [...encoded('ABCD')]);
  assert.deepEqual(mixed.bank ? calls : [], [HLS_SEGMENT_PAIR_FOR_PLAYER]);
  mixed.bank.destroy();
});

test('hls segment byte comparison treats length differences as mismatches', async () => {
  assert.equal(compareSegmentBytes(encoded('ABCD'), encoded('ABCD')), -1);
  assert.equal(compareSegmentBytes(encoded('ABCD'), encoded('ABCE')), 3);
  assert.equal(compareSegmentBytes(encoded('ABC'), encoded('ABCD')), 3);
  assert.equal(compareSegmentBytes(encoded('ABCD'), encoded('ABC')), 3);
});

// ---- FLV 后备拼接 ----

function concatBytes(parts) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

const FLV_FILE_HEADER = Uint8Array.of(0x46, 0x4c, 0x56, 0x01, 0x05, 0, 0, 0, 9, 0, 0, 0, 0);

function flvTag(type, ts, body) {
  const tag = new Uint8Array(11 + body.byteLength + 4);
  tag[0] = type;
  tag[1] = (body.byteLength >> 16) & 0xff;
  tag[2] = (body.byteLength >> 8) & 0xff;
  tag[3] = body.byteLength & 0xff;
  tag[4] = (ts >> 16) & 0xff;
  tag[5] = (ts >> 8) & 0xff;
  tag[6] = ts & 0xff;
  tag[7] = (ts >>> 24) & 0xff;
  tag.set(body, 11);
  new DataView(tag.buffer).setUint32(11 + body.byteLength, 11 + body.byteLength);
  return tag;
}

function flvVideoTag(ts, { key = false, cts = 0, packetType = 1, codecId = 7, data = new Uint8Array(0) } = {}) {
  const body = new Uint8Array(5 + data.byteLength);
  body[0] = ((key ? 1 : 2) << 4) | codecId;
  body[1] = packetType;
  body[2] = (cts >> 16) & 0xff;
  body[3] = (cts >> 8) & 0xff;
  body[4] = cts & 0xff;
  body.set(data, 5);
  return flvTag(9, ts, body);
}

function flvAudioTag(ts, { packetType = 1, soundFormat = 10, data = new Uint8Array(0) } = {}) {
  return flvTag(8, ts, concatBytes([Uint8Array.of((soundFormat << 4) | 0x0f, packetType), data]));
}

// 每帧负载互不相同（前两字节是帧号）；视频与音频的负载长度区间不重叠。
function framePayload(kind, index) {
  const length = kind === 'video' ? 24 + (index % 5) * 9 : 12 + (index % 3) * 5;
  return Uint8Array.from({ length }, (_value, offset) => {
    if (offset === 0) return index >> 8;
    if (offset === 1) return index & 0xff;
    return (index * 13 + offset * 7 + (kind === 'video' ? 0 : 101)) & 0xff;
  });
}

// 录制分片实测的盒子形状：tfhd/trun 标志、tfdt 与 trun 均为 version 1。
const REAL_VIDEO_SHAPE = Object.freeze({
  tfhdFlags: 0x20022,
  sampleDescriptionIndex: 1,
  defaultFlags: 0x1010000,
  tfdtVersion: 1,
  trunVersion: 1,
  trunFlags: 0xb05,
});
const REAL_AUDIO_SHAPE = Object.freeze({
  tfhdFlags: 0x2002a,
  sampleDescriptionIndex: 1,
  defaultDuration: 1024,
  defaultFlags: 0x2000000,
  tfdtVersion: 1,
  trunVersion: 1,
  trunFlags: 0x205,
});

// 合成直播间：30 fps 视频（关键帧位置由 keyFrames 给出，非关键帧带 33 毫秒 CTS）与
// 48 kHz AAC 音频（每帧 1024 个采样），FLV 标签按时间交错、同时刻音频在前。真分片与
// 模块独立地按规则切出：关键帧或距分片首帧满 1000 毫秒开新分片，距小片段首帧满
// 250 毫秒开新小片段，音频按精确时间归入小片段，同时刻按标签顺序归前一个。
// audioFirst 模拟原画档的 traf 次序（音频轨 1 在前）。
function syntheticLive({ videoCount, keyFrames, audioFirst = false, firstMsn = 423384050, firstSeq = 700 }) {
  const flvStart = 100000;
  const clockMs = 7200000;
  const video = Array.from({ length: videoCount }, (_value, index) => {
    const key = keyFrames.includes(index);
    return { index, ts: flvStart + Math.round((index * 100) / 3), key, cts: key ? 0 : 33, data: framePayload('video', index) };
  });
  const audioCount = Math.ceil((videoCount * 100) / 64) + 8;
  const audio = Array.from({ length: audioCount }, (_value, index) => ({
    index,
    ts: flvStart + Math.round((index * 64) / 3),
    data: framePayload('audio', index),
  }));
  const tags = [
    ...audio.map((frame) => ({ ts: frame.ts, rank: 0, frame, bytes: flvAudioTag(frame.ts, { data: frame.data }) })),
    ...video.map((frame) => ({
      ts: frame.ts,
      rank: 1,
      frame,
      bytes: flvVideoTag(frame.ts, { key: frame.key, cts: frame.cts, data: frame.data }),
    })),
  ].sort((left, right) => left.ts - right.ts || left.rank - right.rank);
  tags.forEach((tag, order) => { tag.frame.order = order; });
  const header = concatBytes([
    FLV_FILE_HEADER,
    flvTag(18, 0, encoded('onMetaData')),
    flvVideoTag(0, { key: true, packetType: 0, data: Uint8Array.of(1, 0x64, 0, 0x1f) }),
    flvAudioTag(0, { packetType: 0, data: Uint8Array.of(0x11, 0x90) }),
  ]);
  const videoTime = (frame) => 90 * clockMs + 90 * (frame.ts - flvStart);
  const audioTime = (frame) => 48 * clockMs + 1024 * frame.index;
  // 两轨换到同一单位比较：audio/48000 与 video/90000 秒。
  const audioBefore = (sound, picture) => {
    const left = audioTime(sound) * 15;
    const right = videoTime(picture) * 8;
    return left !== right ? left < right : sound.order < picture.order;
  };
  const videoShape = { ...REAL_VIDEO_SHAPE, trackId: audioFirst ? 2 : 1 };
  const audioShape = { ...REAL_AUDIO_SHAPE, trackId: audioFirst ? 1 : 2 };
  const template = audioFirst ? [audioShape, videoShape] : [videoShape, audioShape];
  const segments = [];
  let audioCursor = 0;
  while (audioBefore(audio[audioCursor], video[0])) audioCursor += 1;
  let seq = firstSeq;
  let start = 0;
  for (;;) {
    let end = start + 1;
    while (end < video.length && !video[end].key && video[end].ts - video[start].ts < 1000) end += 1;
    if (end >= video.length) break;
    const fragmentStarts = [start];
    for (let index = start + 1; index < end; index += 1) {
      if (video[index].ts - video[fragmentStarts.at(-1)].ts >= 250) fragmentStarts.push(index);
    }
    const bounds = [...fragmentStarts, end];
    const pieces = fragmentStarts.map((_fragmentStart, fragmentIndex) => {
      const pictures = video.slice(bounds[fragmentIndex], bounds[fragmentIndex + 1]);
      const next = video[bounds[fragmentIndex + 1]];
      const sounds = [];
      while (audioBefore(audio[audioCursor], next)) {
        sounds.push(audio[audioCursor]);
        audioCursor += 1;
      }
      const videoTrack = {
        baseTime: videoTime(pictures[0]),
        firstSampleFlags: pictures[0].key ? 0x2000000 : 0x1010000,
        samples: pictures.map((frame, index) => ({
          data: frame.data,
          duration: videoTime(pictures[index + 1] ?? next) - videoTime(frame),
          cts: frame.cts * 90,
        })),
      };
      const audioTrack = {
        baseTime: audioTime(sounds[0]),
        firstSampleFlags: 0x1010000,
        samples: sounds.map((frame) => ({ data: frame.data })),
      };
      const piece = buildFragment(template, seq, audioFirst ? [audioTrack, videoTrack] : [videoTrack, audioTrack]);
      seq += 1;
      return piece;
    });
    const bytes = concatBytes(pieces);
    const first = video[start];
    const msn = firstMsn + segments.length;
    segments.push({
      bytes,
      frames: end - start,
      fragmentStarts,
      aux: {
        name: `${msn}.m4s`,
        msn,
        duration: Number(((video[end].ts - first.ts) / 1000).toFixed(3)),
        ptsMs: clockMs + (first.ts - flvStart) + first.cts,
        key: first.key,
        size: bytes.byteLength,
        crc: crc32(bytes),
      },
    });
    start = end;
  }
  return {
    header,
    tags,
    segments,
    flv: concatBytes([header, ...tags.map((tag) => tag.bytes)]),
    // FLV 字节按时间切段：[fromMs, toMs) 相对首帧，from 为 0 时带文件头。
    flvBetween(fromMs, toMs) {
      const parts = tags.filter((tag) => tag.ts - flvStart >= fromMs && tag.ts - flvStart < toMs).map((tag) => tag.bytes);
      return concatBytes(fromMs === 0 ? [header, ...parts] : parts);
    },
  };
}

function syntheticPlaylist(segments, { mapUri = 'h1790783173.m4s', crcOf = (segment) => segment.aux.crc } = {}) {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    `#EXT-X-MEDIA-SEQUENCE:${segments[0].aux.msn}`,
    '#EXT-X-TARGETDURATION:1',
    `#EXT-X-MAP:URI="${mapUri}?trid=1"`,
  ];
  for (const [index, segment] of segments.entries()) {
    const { aux } = segment;
    lines.push(`#EXT-BILI-AUX:${aux.ptsMs.toString(16)}|${aux.key ? 'K' : 'N'}|${aux.size.toString(16)}|${crcOf(segment, index).toString(16)}`);
    lines.push(`#EXTINF:${aux.duration.toFixed(3)},`);
    lines.push(`${aux.name}?trid=1`);
  }
  return `${lines.join('\n')}\n`;
}

test('crc32 matches the standard check values', () => {
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(encoded('123456789')), 0xcbf43926);
  assert.equal(crc32(encoded('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('flv tag reader yields AVC/HEVC NALU frames and AAC raw frames across any chunking, skipping headers', () => {
  const bytes = concatBytes([
    FLV_FILE_HEADER,
    flvTag(18, 0, encoded('onMetaData')),
    flvVideoTag(0, { key: true, packetType: 0, data: Uint8Array.of(1, 2, 3) }),
    flvAudioTag(0, { packetType: 0, data: Uint8Array.of(0x11, 0x90) }),
    flvVideoTag(0x01020304, { key: true, cts: 66, data: Uint8Array.of(9, 9) }),
    flvAudioTag(40, { data: Uint8Array.of(7, 7, 7) }),
    flvVideoTag(73, { cts: -33, codecId: 12, data: Uint8Array.of(5) }),
    flvTag(9, 80, Uint8Array.of(0x57, 0, 0, 0, 0)),
    flvVideoTag(90, { key: true, packetType: 2 }),
  ]);
  const expected = [
    { kind: 'video', ts: 0x01020304, cts: 66, key: true, data: [9, 9] },
    { kind: 'audio', ts: 40, data: [7, 7, 7] },
    { kind: 'video', ts: 73, cts: -33, key: false, data: [5] },
  ];
  const summarize = (frames) => frames.map(({ order: _order, data, ...rest }) => ({ ...rest, data: [...data] }));
  const whole = new FlvTagReader().push(bytes);
  assert.deepEqual(summarize(whole), expected);
  assert.equal(whole[0].order < whole[1].order && whole[1].order < whole[2].order, true);
  const reader = new FlvTagReader();
  const byteByByte = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 1) byteByByte.push(...reader.push(bytes.subarray(offset, offset + 1)));
  assert.deepEqual(summarize(byteByByte), expected);
  assert.deepEqual(byteByByte.map((frame) => frame.order), whole.map((frame) => frame.order));

  const unsupported = [
    flvVideoTag(0, { codecId: 2, data: Uint8Array.of(1) }),
    flvAudioTag(0, { soundFormat: 2, data: Uint8Array.of(1) }),
    flvTag(9, 0, Uint8Array.of(0x91, 0x68, 0x76, 0x63, 0x31)),
  ];
  for (const tag of unsupported) {
    assert.throws(() => new FlvTagReader().push(concatBytes([FLV_FILE_HEADER, tag])), FlvUnsupportedError);
  }
});

test('bili playlist parsing keeps each segment EXTINF, key flag, size, and unpadded CRC32 by name', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:7',
    '#EXT-X-MEDIA-SEQUENCE:423384050',
    '#EXT-X-TARGETDURATION:1',
    '#EXT-X-MAP:URI="h1790783173.m4s?trid=abc"',
    '#EXT-BILI-AUX:1d8e2f0a1|K|1a2b3|9f3e21',
    '#EXTINF:1.00,',
    '423384050.m4s?trid=abc',
    '#EXTINF:1.00,',
    '423384051.m4s',
    '#EXT-BILI-AUX:1d8e2f4e9|N|3c4|f',
    '#EXTINF:0.17,',
    `https://d1--ov-gotcha207.bilivideo.com${HLS_STREAM_DIR}423384052.m4s?trid=abc`,
  ].join('\r\n');
  assert.deepEqual(parseBiliPlaylist(text), {
    mediaSequence: 423384050,
    mapUri: 'h1790783173.m4s',
    entries: [
      { name: '423384050.m4s', msn: 423384050, duration: 1, ptsMs: 0x1d8e2f0a1, key: true, size: 0x1a2b3, crc: 0x9f3e21 },
      { name: '423384052.m4s', msn: 423384052, duration: 0.17, ptsMs: 0x1d8e2f4e9, key: false, size: 0x3c4, crc: 0xf },
    ],
  });
  assert.throws(() => parseBiliPlaylist('#EXT-X-MEDIA-SEQUENCE:1\n#EXT-BILI-AUX:1|X|2|3\n#EXTINF:1,\n1.m4s'));
  assert.throws(() => parseBiliPlaylist('#EXT-X-MEDIA-SEQUENCE:1\n#EXT-BILI-AUX:1|K|zz|3\n#EXTINF:1,\n1.m4s'));
});

test('fragment building round-trips through the segment parser with the recorded box shapes', () => {
  const template = [{ ...REAL_VIDEO_SHAPE, trackId: 1 }, { ...REAL_AUDIO_SHAPE, trackId: 2 }];
  const video = {
    baseTime: 2 ** 33 + 90,
    firstSampleFlags: 0x2000000,
    samples: [
      { data: Uint8Array.of(1, 2, 3), duration: 2970, cts: 0 },
      { data: Uint8Array.of(4, 5), duration: 3060, cts: 2970 },
    ],
  };
  const audio = { baseTime: 345600000, firstSampleFlags: 0x1010000, samples: [{ data: Uint8Array.of(6) }, { data: Uint8Array.of(7, 8) }] };
  const bytes = concatBytes([buildFragment(template, 41, [video, audio]), buildFragment(template, 42, [video, audio])]);
  const fragments = parseMediaSegment(bytes);
  assert.deepEqual(fragments.map((fragment) => fragment.seq), [41, 42]);
  const [videoTraf, audioTraf] = fragments[0].trafs;
  assert.deepEqual(
    [videoTraf.trackId, videoTraf.tfhdFlags, videoTraf.defaultFlags, videoTraf.tfdtVersion, videoTraf.baseTime],
    [1, 0x20022, 0x1010000, 1, 2 ** 33 + 90],
  );
  assert.deepEqual([videoTraf.trun.version, videoTraf.trun.flags, videoTraf.trun.firstSampleFlags], [1, 0xb05, 0x2000000]);
  assert.deepEqual(videoTraf.samples.map(({ data, time, duration, cts }) => [[...data], time, duration, cts]), [
    [[1, 2, 3], 2 ** 33 + 90, 2970, 0],
    [[4, 5], 2 ** 33 + 90 + 2970, 3060, 2970],
  ]);
  assert.deepEqual(
    [audioTraf.trackId, audioTraf.tfhdFlags, audioTraf.defaultDuration, audioTraf.trun.flags, audioTraf.trun.firstSampleFlags],
    [2, 0x2002a, 1024, 0x205, 0x1010000],
  );
  assert.deepEqual(audioTraf.samples.map(({ data, time, duration }) => [[...data], time, duration]), [
    [[6], 345600000, 1024],
    [[7, 8], 345601024, 1024],
  ]);
});

test('segment and fragment frame selection follows keyframes and the 1000/250 ms thresholds, short segments included', () => {
  const live = syntheticLive({ videoCount: 160, keyFrames: [0, 125] });
  const video = new FlvTagReader().push(live.flv).filter((frame) => frame.kind === 'video');
  const timing = {
    video: { base: 0, flvTs: video[0].ts, ptsBase: 0, flvPts: video[0].ts, grid: 90 },
    audio: { base: 0, flvTs: video[0].ts, grids: [1024] },
  };
  assert.deepEqual(planSegment(video, 0, timing), { endIndex: 30, fragmentStarts: [0, 8, 16, 24] });
  assert.deepEqual(planSegment(video, 90, timing), { endIndex: 120, fragmentStarts: [90, 98, 106, 114] });
  // 关键帧前的 0.17 秒短分片：5 帧、一个小片段。
  assert.deepEqual(planSegment(video, 120, timing), { endIndex: 125, fragmentStarts: [120] });
  assert.deepEqual(live.segments.map((segment) => segment.frames), [30, 30, 30, 30, 5, 30]);
  assert.deepEqual(live.segments.map((segment) => segment.aux.duration), [1, 1, 1, 1, 0.167, 1]);
  // 下一分片首帧未到时不出结果。
  assert.equal(planSegment(video.slice(0, 30), 0, timing), undefined);
});

test('the rebuilder calibrates on a real-shaped segment and rebuilds later segments byte for byte', () => {
  for (const audioFirst of [false, true]) {
    const live = syntheticLive({ videoCount: 290, keyFrames: [0, 125, 250], audioFirst });
    assert.deepEqual(live.segments.map((segment) => segment.frames), [30, 30, 30, 30, 5, 30, 30, 30, 30, 5, 30]);
    const rebuilder = new FlvSegmentRebuilder({ windowMs: 30000 });
    rebuilder.appendFrames(new FlvTagReader().push(live.flv));
    const [calibration, ...later] = live.segments;
    assert.equal(rebuilder.calibrated, false);
    assert.deepEqual(rebuilder.noteRealSegment(calibration.aux, calibration.bytes), { calibrated: true });
    for (const segment of later) {
      const result = rebuilder.attempt(segment.aux);
      assert.equal(result.status, 'verified', `${segment.aux.name} audioFirst=${audioFirst}`);
      assert.equal(Buffer.compare(Buffer.from(result.bytes), Buffer.from(segment.bytes)), 0);
    }
    // 拼出的字节与播放列表的 CRC32 或长度不符时只报 mismatch，不给出可交付的结果。
    const target = later[3].aux;
    assert.deepEqual(rebuilder.attempt({ ...target, crc: (target.crc ^ 1) >>> 0 }), { status: 'mismatch', bytes: target.size });
    assert.equal(rebuilder.attempt({ ...target, size: target.size + 1 }).status, 'mismatch');
  }
});

// FLV 后备的页面夹具：地址簿含同流名、同编码的 fMP4 与 FLV 条目；FLV 连接与各网络腿
// 的字节都由测试手动推送，计时器手动触发。segmentModes 按分片名让网络腿挂起到取消
// （hold，连响应头都不回）或回 HTTP 500（fail）。
const FLV_BACKUP_HOST = 'd1--cn-gotcha04.bilivideo.com';
const FLV_BACKUP_PATH = '/live-bvc/791488/live_i9bl9s_SIPAZ9L_1b53ey_4000.flv';
const FLV_BACKUP_URL = `https://${FLV_BACKUP_HOST}${FLV_BACKUP_PATH}?expires=4102444800&sign=flv04`;

function flvBackupPlayinfo({ flvCodec = 'avc' } = {}) {
  const group = (formatName, codecName, baseUrl, urls) => ({
    format: [{ format_name: formatName, codec: [{ codec_name: codecName, base_url: baseUrl, url_info: urls.map(liveUrlInfoEntry) }] }],
  });
  return {
    data: {
      playurl_info: {
        playurl: {
          stream: [
            group('fmp4', 'avc', `${HLS_STREAM_DIR}index.m3u8?`, [HLS_MAIN_PLAYLIST, HLS_BACKUP_PLAYLIST]),
            group('flv', flvCodec, `${FLV_BACKUP_PATH}?`, [FLV_BACKUP_URL]),
          ],
        },
      },
    },
  };
}

function hlsSegmentUrls(name) {
  return {
    player: `https://d1--ov-gotcha207.bilivideo.com${HLS_STREAM_DIR}${name}?expires=4102444800&sign=seg207`,
    pair: `https://d1--ov-gotcha105.bilivideo.com${HLS_STREAM_DIR}${name}?expires=4102444800&sign=hls105`,
  };
}

function flvBackupHarness({ playlistText, enabled = true, playinfo = flvBackupPlayinfo(), flvResponder } = {}) {
  const timers = manualTimers();
  const flvFeed = liveFeed();
  const feeds = new Map();
  const segmentModes = new Map();
  const calls = [];
  const feedFor = (url) => {
    if (!feeds.has(url)) feeds.set(url, liveFeed({ headers: { 'Content-Type': 'video/mp4' } }));
    return feeds.get(url);
  };
  const fixture = createBank({
    timers,
    config: liveConfig(),
    location: LIVE_LOCATION,
    enabled,
    nativeFetch: async (url, init = {}) => {
      calls.push(url);
      if (url === FLV_BACKUP_URL) return flvResponder === undefined ? flvFeed.response : flvResponder();
      const pathname = new URL(url).pathname;
      if (pathname.endsWith('.m3u8')) {
        return new Response(playlistText, { headers: { 'Content-Type': 'application/vnd.apple.mpegurl' } });
      }
      const mode = segmentModes.get(pathname.slice(pathname.lastIndexOf('/') + 1));
      if (mode === 'fail') return new Response('', { status: 500 });
      if (mode === 'hold') {
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
        });
      }
      return feedFor(url).response;
    },
  });
  fixture.windowObject.__NEPTUNE_IS_MY_WAIFU__ = playinfo;
  return {
    ...fixture,
    timers,
    flvFeed,
    calls,
    feedFor,
    segmentModes,
    deliver(segment) {
      for (const url of Object.values(hlsSegmentUrls(segment.aux.name))) {
        const feed = feedFor(url);
        feed.push(segment.bytes);
        feed.close();
      }
    },
    events(code, from = 0) {
      return fixture.windowObject.messages.slice(from).filter((message) => message.code === code).map(({ data }) => data);
    },
  };
}

async function settle(rounds = 4) {
  for (let round = 0; round < rounds; round += 1) await tick();
}

// 校准：先推 FLV 字节，再让首个分片走网络腿送达。
async function calibrateOverFetch(harness, live, flvBytes) {
  const [first] = live.segments;
  const response = hlsFetchThrough(harness.bank, hlsSegmentUrls(first.aux.name).player);
  await settle();
  harness.flvFeed.push(flvBytes);
  await settle();
  harness.deliver(first);
  const body = new Uint8Array(await (await response).arrayBuffer());
  assert.equal(Buffer.compare(Buffer.from(body), Buffer.from(first.bytes)), 0);
  await settle();
}

test('hls fetch serves segments from the verified FLV rebuild when the network is slow, and the network when it is not', async () => {
  const live = syntheticLive({ videoCount: 160, keyFrames: [0, 125] });
  const [first, second, third, fourth, short] = live.segments;
  const playlistText = syntheticPlaylist(live.segments, {
    crcOf: (segment, index) => (index === 3 ? (segment.aux.crc ^ 1) >>> 0 : segment.aux.crc),
  });
  const harness = flvBackupHarness({ playlistText });
  const { bank } = harness;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    // 播放列表原样到达播放器，AUX 值被记下。
    const playlistResponse = await liveFetchThrough(bank, HLS_MAIN_PLAYLIST);
    assert.equal(await playlistResponse.text(), playlistText);
    assert.deepEqual(bank.livePlaylistAuxFor(HLS_STREAM_DIR, second.aux.name), second.aux);

    // 首个分片：连接随首个分片请求打开，校准前没有拼接腿。FLV 先只到第二个分片的终点帧之前。
    await calibrateOverFetch(harness, live, live.flvBetween(0, 1990));
    assert.deepEqual(harness.events('live.flv.backup'), [
      { state: 'connected', streamPath: FLV_BACKUP_PATH, mirror: FLV_BACKUP_HOST },
      { state: 'calibrated', streamPath: FLV_BACKUP_PATH, mirror: FLV_BACKUP_HOST },
    ]);
    assert.deepEqual(harness.events('bank.fetch.chunk').map((data) => data.slot).sort(), [0, 1]);
    assert.equal(harness.events('bank.serve').at(-1).winner, 'network');

    // 网络先到：拼接腿还在等终点帧，被取消记 lost_race。
    let mark = bank.windowObject.messages.length;
    const secondResponse = await hlsFetchThrough(bank, hlsSegmentUrls(second.aux.name).player);
    const secondBody = secondResponse.arrayBuffer();
    await settle();
    harness.deliver(second);
    assert.equal(Buffer.compare(Buffer.from(new Uint8Array(await secondBody)), Buffer.from(second.bytes)), 0);
    await settle();
    assert.equal(harness.events('bank.serve', mark).at(-1).winner, 'network');
    const rebuildLost = harness.events('bank.fetch.chunk', mark).find((data) => data.slot === 2);
    assert.deepEqual([rebuildLost.result, rebuildLost.mirror, rebuildLost.bytes], ['lost_race', FLV_BACKUP_HOST, 0]);

    // 网络两腿都回 500：失败先不交给播放器，等 FLV 帧到齐后由拼接腿交付；响应头沿用上一个网络分片。
    mark = bank.windowObject.messages.length;
    harness.segmentModes.set(third.aux.name, 'fail');
    const thirdResponse = hlsFetchThrough(bank, hlsSegmentUrls(third.aux.name).player);
    await settle();
    assert.deepEqual(harness.events('bank.fetch.chunk', mark).map((data) => [data.slot, data.result]).sort(), [
      [0, 'http_error'],
      [1, 'http_error'],
    ]);
    assert.equal(harness.events('bank.serve', mark).length, 0);
    harness.flvFeed.push(live.flvBetween(1990, 1e9));
    const rescued = await thirdResponse;
    assert.equal(rescued.status, 200);
    assert.equal(rescued.headers.get('Content-Type'), 'video/mp4');
    assert.equal(Buffer.compare(Buffer.from(new Uint8Array(await rescued.arrayBuffer())), Buffer.from(third.bytes)), 0);
    const rescuedServe = harness.events('bank.serve', mark).at(-1);
    assert.deepEqual([rescuedServe.result, rescuedServe.winner], ['hit', 'flv_rebuild']);
    const rebuildFetched = harness.events('bank.fetch.chunk', mark).find((data) => data.slot === 2);
    assert.deepEqual(
      [rebuildFetched.result, rebuildFetched.mirror, rebuildFetched.source, rebuildFetched.bytes],
      ['fetched', FLV_BACKUP_HOST, hlsSegmentUrls(third.aux.name).player.split('?')[0], third.bytes.byteLength],
    );

    // CRC32 对不上：拼出的字节丢弃并记 crc_mismatch，分片等网络腿交付。
    mark = bank.windowObject.messages.length;
    const fourthResponse = await hlsFetchThrough(bank, hlsSegmentUrls(fourth.aux.name).player);
    let fourthDone = false;
    const fourthBody = fourthResponse.arrayBuffer().then((buffer) => {
      fourthDone = true;
      return buffer;
    });
    await settle();
    const mismatch = harness.events('bank.fetch.chunk', mark).find((data) => data.slot === 2);
    assert.deepEqual([mismatch.result, mismatch.bytes], ['crc_mismatch', fourth.bytes.byteLength]);
    assert.equal(fourthDone, false);
    harness.deliver(fourth);
    assert.equal(Buffer.compare(Buffer.from(new Uint8Array(await fourthBody)), Buffer.from(fourth.bytes)), 0);
    assert.equal(harness.events('bank.serve', mark).at(-1).winner, 'network');

    // 0.17 秒短分片：网络腿连响应头都不回，拼接腿胜出，网络腿取消记 lost_race。
    mark = bank.windowObject.messages.length;
    harness.segmentModes.set(short.aux.name, 'hold');
    const shortResponse = await hlsFetchThrough(bank, hlsSegmentUrls(short.aux.name).player);
    assert.equal(Buffer.compare(Buffer.from(new Uint8Array(await shortResponse.arrayBuffer())), Buffer.from(short.bytes)), 0);
    await settle();
    assert.equal(harness.events('bank.serve', mark).at(-1).winner, 'flv_rebuild');
    assert.deepEqual(harness.events('bank.fetch.chunk', mark).map((data) => [data.slot, data.result]).sort(), [
      [0, 'lost_race'],
      [1, 'lost_race'],
      [2, 'fetched'],
    ]);
    assert.equal(harness.calls.filter((url) => url === FLV_BACKUP_URL).length, 1);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(errors, []);
  bank.destroy();
  assert.equal(harness.flvFeed.cancelled, true);
});

test('hls XHR reads playlists from the native response and serves the verified FLV rebuild like the fetch channel', async () => {
  const live = syntheticLive({ videoCount: 160, keyFrames: [0, 125] });
  const [first, second] = live.segments;
  const playlistText = syntheticPlaylist(live.segments);
  const harness = flvBackupHarness({ playlistText });
  const { bank, windowObject } = harness;
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });

  const playlistXhr = new windowObject.XMLHttpRequest();
  playlistXhr.open('GET', HLS_MAIN_PLAYLIST);
  playlistXhr.send();
  assert.equal(playlistXhr._native.sendCalls.length, 1);
  playlistXhr._native.status = 200;
  playlistXhr._native.responseText = playlistText;
  playlistXhr._native.emit('load');
  assert.equal(playlistXhr.responseText, playlistText);
  assert.deepEqual(bank.livePlaylistAuxFor(HLS_STREAM_DIR, second.aux.name), second.aux);

  const segmentThroughXhr = (segment) => {
    const xhr = new windowObject.XMLHttpRequest();
    xhr.responseType = 'arraybuffer';
    const done = new Promise((resolve) => xhr.addEventListener('loadend', resolve));
    xhr.open('GET', hlsSegmentUrls(segment.aux.name).player);
    xhr.send();
    return { xhr, done };
  };
  const calibration = segmentThroughXhr(first);
  await settle();
  harness.flvFeed.push(live.flv);
  await settle();
  harness.deliver(first);
  await calibration.done;
  assert.equal(Buffer.compare(Buffer.from(new Uint8Array(calibration.xhr.response)), Buffer.from(first.bytes)), 0);
  await settle();
  assert.deepEqual(harness.events('live.flv.backup').map((data) => data.state), ['connected', 'calibrated']);

  const mark = windowObject.messages.length;
  harness.segmentModes.set(second.aux.name, 'hold');
  const rebuilt = segmentThroughXhr(second);
  await rebuilt.done;
  assert.equal(rebuilt.xhr.status, 200);
  assert.equal(rebuilt.xhr.getResponseHeader('Content-Type'), 'video/mp4');
  assert.equal(Buffer.compare(Buffer.from(new Uint8Array(rebuilt.xhr.response)), Buffer.from(second.bytes)), 0);
  await settle();
  assert.equal(harness.events('bank.serve', mark).at(-1).winner, 'flv_rebuild');
  assert.deepEqual(harness.events('bank.fetch.chunk', mark).map((data) => [data.slot, data.result]).sort(), [
    [0, 'lost_race'],
    [1, 'lost_race'],
    [2, 'fetched'],
  ]);
  bank.destroy();
});

test('with the live switch off neither channel reads playlists or opens an FLV connection', async () => {
  const live = syntheticLive({ videoCount: 70, keyFrames: [0] });
  const harness = flvBackupHarness({ playlistText: syntheticPlaylist(live.segments), enabled: false });
  const { bank, windowObject } = harness;
  windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({ windowObject, nativeConstructor: NativeXHR, bank });
  await liveFetchThrough(bank, HLS_MAIN_PLAYLIST);
  await hlsFetchThrough(bank, hlsSegmentUrls(live.segments[0].aux.name).player);
  const xhr = new windowObject.XMLHttpRequest();
  xhr.open('GET', hlsSegmentUrls(live.segments[1].aux.name).player);
  xhr.send();
  assert.equal(xhr._native.sendCalls.length, 1);
  await settle();
  assert.equal(harness.calls.includes(FLV_BACKUP_URL), false);
  assert.equal(bank.livePlaylists.size, 0);
  assert.deepEqual(harness.events('live.flv.backup'), []);
  bank.destroy();
});

test('the FLV backup needs a same-name same-codec address and reports unavailable once per stream and reason', async () => {
  const live = syntheticLive({ videoCount: 70, keyFrames: [0] });
  const harness = flvBackupHarness({
    playlistText: syntheticPlaylist(live.segments),
    playinfo: flvBackupPlayinfo({ flvCodec: 'hevc' }),
  });
  const { bank } = harness;
  for (const segment of live.segments) {
    const response = hlsFetchThrough(bank, hlsSegmentUrls(segment.aux.name).player);
    harness.deliver(segment);
    await (await response).arrayBuffer();
  }
  assert.deepEqual(harness.events('live.flv.backup'), [
    { state: 'unavailable', streamPath: HLS_STREAM_DIR, reason: 'no_flv_entry' },
  ]);
  assert.equal(harness.calls.includes(FLV_BACKUP_URL), false);
  assert.deepEqual(harness.events('bank.fetch.chunk').filter((data) => data.slot === 2), []);
  bank.destroy();
});

test('the FLV backup reconnects at most three times, then gives up with a full-rate error while segments keep the network legs', async () => {
  const live = syntheticLive({ videoCount: 70, keyFrames: [0] });
  const [first, second] = live.segments;
  let flvAttempts = 0;
  const harness = flvBackupHarness({
    playlistText: syntheticPlaylist(live.segments),
    flvResponder: async () => {
      flvAttempts += 1;
      throw new TypeError('Failed to fetch');
    },
  });
  const { bank, timers } = harness;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args);
  try {
    const response = hlsFetchThrough(bank, hlsSegmentUrls(first.aux.name).player);
    for (let reconnect = 0; reconnect < 3; reconnect += 1) {
      await settle();
      timers.fire(LIVE_FLV_BACKUP_CONFIG.reconnectDelayMs);
    }
    await settle();
    harness.deliver(first);
    assert.equal(Buffer.compare(Buffer.from(new Uint8Array(await (await response).arrayBuffer())), Buffer.from(first.bytes)), 0);
    const followUp = hlsFetchThrough(bank, hlsSegmentUrls(second.aux.name).player);
    harness.deliver(second);
    await (await followUp).arrayBuffer();
  } finally {
    console.error = originalError;
  }
  assert.equal(flvAttempts, 4);
  assert.deepEqual(harness.events('live.flv.backup').map((data) => [data.state, data.reason]), [
    ['reconnecting', 'network_error'],
    ['reconnecting', 'network_error'],
    ['reconnecting', 'network_error'],
    ['given_up', 'network_error'],
  ]);
  const flvErrors = harness.events('log.error').filter((data) => data.code === 'LIVE_FLV_BACKUP');
  assert.equal(flvErrors.length, 1);
  assert.equal(flvErrors[0].errorName, 'TypeError');
  assert.equal(errors.length, 1);
  assert.deepEqual(harness.events('bank.serve').map((data) => data.winner), ['network', 'network']);
  bank.destroy();
});
