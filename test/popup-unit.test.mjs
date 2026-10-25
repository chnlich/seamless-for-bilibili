import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  POPUP_ROUTE,
  applyPopupRoute,
  emptyLiveFacts,
  foldLiveEvents,
  liveServeClass,
  popupRouteForTabUrl,
  preferenceNames,
  savePreferenceChange,
  storedPreferences,
} from '../src/extension/popup-live.js';
import { deriveDownloadStatus } from '../src/diagnostics/download-status.js';
import {
  DOWNLOAD_CARD_TEXT,
  NO_PAGE_MESSAGES,
  SWITCH_OFF_TEXT,
  applyPageAvailability,
  bytesText,
  clockText,
  downloadLinesView,
  liveTakeoverText,
  renderBuffer,
  renderCdnLines,
  renderLiveTakeover,
  renderVideoPanel,
  shortMirrorName,
  speedText,
  surfaceErrorText,
  targetStateText,
} from '../src/extension/popup-view.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const popupHtml = fs.readFileSync(path.join(root, 'src/extension/popup.html'), 'utf8');

function popupDocument() {
  return new JSDOM(popupHtml).window.document;
}

function popupRefs(document) {
  return {
    bar: document.querySelector('[data-buffer-bar]'),
    fill: document.querySelector('[data-buffer-fill]'),
    seconds: document.querySelector('[data-buffer-seconds]'),
    goal: document.querySelector('[data-buffer-goal]'),
    note: document.querySelector('[data-buffer-note]'),
    targetLabel: document.querySelector('[data-buffer-target-label]'),
    targetValue: document.querySelector('[data-target-value]'),
    stateLine: document.querySelector('[data-status-field="state"]'),
    errorLine: document.querySelector('[data-status-field="error"]'),
  };
}

test('popup route classification treats live.bilibili.com as live and everything else as video', () => {
  assert.equal(popupRouteForTabUrl('https://live.bilibili.com/21452505'), POPUP_ROUTE.LIVE);
  assert.equal(popupRouteForTabUrl('https://www.bilibili.com/video/BV1'), POPUP_ROUTE.VIDEO);
  assert.equal(popupRouteForTabUrl('https://search.bilibili.com/all'), POPUP_ROUTE.VIDEO);
  assert.equal(popupRouteForTabUrl(undefined), POPUP_ROUTE.VIDEO);
  assert.equal(popupRouteForTabUrl('not a url'), POPUP_ROUTE.VIDEO);
});

test('popup always shows both switches with their own labels, on either route', () => {
  for (const route of [POPUP_ROUTE.VIDEO, POPUP_ROUTE.LIVE]) {
    const document = popupDocument();
    applyPopupRoute(document, route);
    const labels = [...document.querySelectorAll('.switch-row span')].map((span) => span.textContent);
    assert.deepEqual(labels, ['视频增强', '直播增强']);
    for (const name of preferenceNames()) {
      const input = document.querySelector(`input[data-preference="${name}"]`);
      assert.notEqual(input, undefined, `缺少开关 input: ${name}`);
      assert.equal(input.closest('.switch-row').hidden, false);
    }
  }
});

test('popup on a video route shows the buffer card and hides the live takeover card', () => {
  const document = popupDocument();
  applyPopupRoute(document, POPUP_ROUTE.VIDEO);
  assert.equal(document.querySelector('[data-live-panel]').hidden, true);
  assert.equal(document.querySelector('[aria-label="缓冲"]').hidden, false);
  assert.equal(document.querySelector('[aria-label="下载线路"]').hidden, false);
});

test('popup on a live route hides the buffer card and shows the takeover card', () => {
  const document = popupDocument();
  applyPopupRoute(document, POPUP_ROUTE.LIVE);
  assert.equal(document.querySelector('[data-live-panel]').hidden, false);
  assert.equal(document.querySelector('[aria-label="缓冲"]').hidden, true);
  assert.equal(document.querySelector('[aria-label="下载线路"]').hidden, false);
});

test('stored preferences default both switches to on and treat only false as off', () => {
  assert.deepEqual(storedPreferences({}), { vodEnabled: true, liveEnabled: true });
  assert.deepEqual(
    storedPreferences({ vodEnabled: false, liveEnabled: false }),
    { vodEnabled: false, liveEnabled: false },
  );
  assert.deepEqual(
    storedPreferences({ vodEnabled: true, liveEnabled: 'no' }),
    { vodEnabled: true, liveEnabled: true },
  );
});

test('each switch saves its own preference and only the video switch affects the video panel', async () => {
  const writes = [];
  const storageObject = {
    async set(value) { writes.push(value); },
  };
  assert.equal(
    await savePreferenceChange({ name: 'liveEnabled', checked: false, storageObject }),
    false,
    '直播开关不得影响视频面板',
  );
  assert.deepEqual(writes, [{ liveEnabled: false }]);
  assert.equal(
    await savePreferenceChange({ name: 'vodEnabled', checked: false, storageObject }),
    true,
    '视频开关改动要刷新缓冲卡目标状态',
  );
  assert.deepEqual(writes, [{ liveEnabled: false }, { vodEnabled: false }]);
  await assert.rejects(
    savePreferenceChange({ name: 'other', checked: true, storageObject }),
    /未允许的偏好开关/,
  );
  assert.deepEqual(writes, [{ liveEnabled: false }, { vodEnabled: false }]);
});

test('mirror hosts shrink to readable line names that stay distinguishable', () => {
  assert.equal(shortMirrorName('upos-sz-mirrorcosov.bilivideo.com'), 'sz-mirrorcosov');
  assert.equal(shortMirrorName('upos-hz-mirrorakam.akamaized.net'), 'hz-mirrorakam');
  assert.equal(shortMirrorName('d1--ov-gotcha07.bilivideo.com'), 'ov-gotcha07');
  assert.equal(shortMirrorName('d1--ov-gotcha07b.bilivideo.com'), 'ov-gotcha07b');
  assert.equal(shortMirrorName('a.bilivideo.com'), 'a.bilivideo.com');
  assert.equal(shortMirrorName(undefined), '未知线路');
});

// ---- 下载线路卡片：此刻的下载状态 ----
// 时间线复刻设计稿第二节折叠块里的那次卡顿（合成记录，不含真实日志）：
// 全程两条线路竞速同一块，hz-mirrorakam（Akamai）几乎每块都赢；视频第 3 块
// akam 反复只发回一部分（invalid_response）、sz-mirrorcosov 反复停滞，最后补到
// 第 3 块、整个文件存好、在途与排队清零。三个时刻对应设计稿第三节的三张卡片。
const MB = 1_048_576;
const AKAM = 'upos-hz-mirrorakam.akamaized.net';
const COS = 'upos-sz-mirrorcosov.bilivideo.com';
const VIDEO_PATH = '/video/track.m4s';
const AUDIO_PATH = '/audio/track.m4s';
const VIDEO_TOTAL = 55_105_041;
const AUDIO_TOTAL = 12_582_912;
const DURATION = 1_460;
const NOW_A = 1_000_000;
const NOW_B = NOW_A + 75_000;
const NOW_C = NOW_B + 101_000;

function fetchEvent({
  at,
  mirror,
  path = VIDEO_PATH,
  chunkIndex = 0,
  bytes = MB,
  durationMs = 500,
  slot = 0,
  result = 'fetched',
}) {
  const start = chunkIndex * MB;
  return {
    wallTime: new Date(at).toISOString(),
    data: {
      source: `https://${mirror}${path}`,
      mirror,
      chunkIndex,
      start,
      end: Math.min(start + MB - 1, VIDEO_TOTAL - 1),
      bytes,
      durationMs,
      slot,
      result,
    },
  };
}

function incidentInventory({ inflight, queued, videoContiguousEnd, videoOutstanding = 0 }) {
  return {
    data: {
      inflight,
      queued,
      resources: [
        {
          pathname: VIDEO_PATH,
          kind: 'video',
          active: true,
          totalSize: VIDEO_TOTAL,
          contiguousEnd: videoContiguousEnd,
          outstanding: videoOutstanding,
        },
        {
          pathname: AUDIO_PATH,
          kind: 'audio',
          active: true,
          totalSize: AUDIO_TOTAL,
          contiguousEnd: AUDIO_TOTAL,
          outstanding: 0,
        },
      ],
    },
  };
}

// 块 0、1、2、4 到 29 的双腿竞速：akam 每块取到，cos 每块输掉且一个字节也没收到。
function raceEvents() {
  const events = [];
  for (let i = 0; i < 29; i += 1) {
    const chunkIndex = i < 3 ? i : i + 1;
    const at = NOW_A - 4_300 + i * 150;
    events.push(fetchEvent({ at, mirror: AKAM, chunkIndex, result: 'fetched', slot: 0 }));
    events.push(fetchEvent({
      at: at + 50,
      mirror: COS,
      chunkIndex,
      bytes: 0,
      result: 'lost_race',
      slot: 1,
    }));
  }
  return events;
}

// 视频第 3 块：akam 与 cos 各自连续失败 8 次，前几次已落在 15 秒活动窗口之外。
function chunk3FailureEvents() {
  const events = [];
  for (let i = 0; i < 8; i += 1) {
    events.push(fetchEvent({
      at: NOW_B - 70_000 + i * 10_000,
      mirror: AKAM,
      chunkIndex: 3,
      bytes: 818_559,
      durationMs: 4_000,
      result: 'invalid_response',
    }));
    events.push(fetchEvent({
      at: NOW_B - 63_000 + i * 9_000,
      mirror: COS,
      chunkIndex: 3,
      bytes: 0,
      durationMs: 10_000,
      result: 'stalled',
    }));
  }
  return events;
}

function completionEvents() {
  return [
    fetchEvent({ at: NOW_C - 60_000, mirror: AKAM, chunkIndex: 3, result: 'fetched' }),
    fetchEvent({
      at: NOW_C - 60_000,
      mirror: COS,
      chunkIndex: 3,
      bytes: 0,
      result: 'lost_race',
      slot: 1,
    }),
    fetchEvent({ at: NOW_C - 59_000, mirror: AKAM, chunkIndex: 51, result: 'fetched' }),
    fetchEvent({ at: NOW_C - 59_000, mirror: AKAM, chunkIndex: 52, result: 'fetched' }),
  ];
}

// nowMs 是 worker 取数的时刻，renderNowMs 是弹窗渲染的时刻（默认同一时刻）。
function downloadCard({
  events,
  latestInventory,
  latestLiveInventory,
  nowMs,
  renderNowMs = nowMs,
  live = false,
  readouts,
  vodEnabled = true,
  liveEnabled = true,
}) {
  const status = deriveDownloadStatus({ chunkEvents: events, latestInventory, latestLiveInventory, nowMs });
  const response = { sampleCount: events.length, summary: { rows: [] }, downloadStatus: status };
  const view = downloadLinesView({
    response,
    error: undefined,
    inFlight: false,
    live,
    readouts,
    vodEnabled,
    liveEnabled,
    nowMs: renderNowMs,
  });
  const document = popupDocument();
  const container = document.querySelector('[data-cdn-lines]');
  renderCdnLines(document, container, view);
  return {
    headline: container.querySelector('.cdn-headline')?.textContent ?? null,
    subline: container.querySelector('.cdn-subline')?.textContent ?? null,
    message: container.querySelector('.cdn-empty')?.textContent ?? null,
    rows: [...container.querySelectorAll('.cdn-line')].map((line) => ({
      name: line.querySelector('.cdn-name').textContent,
      text: line.querySelector('.cdn-status').textContent,
      tone: line.dataset.tone,
    })),
  };
}

test('speeds and clock positions format the way the card promises', () => {
  assert.equal(speedText(9_949_900), '9.9 Mbps');
  assert.equal(speedText(10_000_000), '10 Mbps');
  assert.equal(speedText(48_653_926.4), '49 Mbps');
  assert.equal(speedText(500_000), '0.5 Mbps');
  assert.equal(clockText(0), '0:00');
  assert.equal(clockText(85), '1:25');
  assert.equal(clockText(91.3), '1:31');
  assert.equal(clockText(1460), '24:20');
  assert.equal(clockText(3600), '60:00');
});

test('downloading moment: total and per-line speeds, how far ahead, and the leg that lost', () => {
  const card = downloadCard({
    events: raceEvents(),
    latestInventory: incidentInventory({ inflight: 2, queued: 40, videoContiguousEnd: 3 * MB }),
    nowMs: NOW_A,
    readouts: { waiting: false, currentTime: 45, duration: DURATION, forwardSeconds: 40 },
  });
  assert.equal(card.headline, '正在下载 · 合计 49 Mbps');
  assert.equal(card.subline, '已提前下载到约 1:25（全长 24:20）');
  assert.deepEqual(card.rows, [
    { name: 'hz-mirrorakam', text: '下载中 · 49 Mbps', tone: 'ok' },
    { name: 'sz-mirrorcosov', text: '另一条线路更快', tone: 'idle' },
  ]);
});

test('stalled moment: what the player waits for and how many retry rounds, no second line', () => {
  const card = downloadCard({
    events: [...raceEvents(), ...chunk3FailureEvents()],
    latestInventory: incidentInventory({ inflight: 2, queued: 20, videoContiguousEnd: 3 * MB, videoOutstanding: 1 }),
    nowMs: NOW_B,
    readouts: { waiting: true, currentTime: 91.3, duration: DURATION, forwardSeconds: 0 },
  });
  assert.equal(card.headline, '正在等 1:31 处的数据，已重试 8 轮');
  assert.equal(card.subline, null);
  assert.deepEqual(card.rows, [
    { name: 'hz-mirrorakam', text: '数据没给全就断开', tone: 'bad' },
    { name: 'sz-mirrorcosov', text: '10 秒没有收到数据', tone: 'warn' },
  ]);
});

test('caught-up moment: downloads paused by design, the whole video stored, lines idle', () => {
  const card = downloadCard({
    events: [...raceEvents(), ...chunk3FailureEvents(), ...completionEvents()],
    latestInventory: incidentInventory({ inflight: 0, queued: 0, videoContiguousEnd: VIDEO_TOTAL }),
    nowMs: NOW_C,
    readouts: { waiting: false, currentTime: 91.5, duration: DURATION, forwardSeconds: 120 },
  });
  assert.equal(card.headline, '已下载够，暂停下载');
  assert.equal(card.subline, '整个视频已下载（全长 24:20）');
  assert.deepEqual(card.rows, [
    { name: 'hz-mirrorakam', text: '空闲', tone: 'idle' },
    { name: 'sz-mirrorcosov', text: '空闲', tone: 'idle' },
  ]);
});

test('a line that failed earlier and then recovered shows only that it is downloading', () => {
  const card = downloadCard({
    events: [
      fetchEvent({ at: NOW_A - 20_000, mirror: AKAM, chunkIndex: 3, bytes: 818_559, result: 'invalid_response' }),
      fetchEvent({ at: NOW_A - 1_000, mirror: AKAM, chunkIndex: 3, durationMs: 250, result: 'fetched' }),
    ],
    latestInventory: incidentInventory({ inflight: 1, queued: 5, videoContiguousEnd: 4 * MB }),
    nowMs: NOW_A,
    readouts: { waiting: false, currentTime: 45, duration: DURATION, forwardSeconds: 40 },
  });
  assert.equal(card.headline, '正在下载 · 合计 1.7 Mbps');
  assert.deepEqual(card.rows, [{ name: 'hz-mirrorakam', text: '下载中 · 1.7 Mbps', tone: 'ok' }]);
});

test('with no records the card says so, or names the switch that is off', () => {
  const noRecords = { latestInventory: undefined, nowMs: NOW_A, readouts: undefined, events: [] };
  assert.equal(downloadCard({ ...noRecords }).headline, '还没有下载数据');
  assert.equal(downloadCard({ ...noRecords, vodEnabled: false }).headline, '视频增强开关已关闭');
  assert.equal(downloadCard({ ...noRecords, live: true }).headline, '还没有下载数据');
  assert.equal(downloadCard({ ...noRecords, live: true, liveEnabled: false }).headline, '直播增强开关已关闭');
  const card = downloadCard({ ...noRecords });
  assert.equal(card.rows.length, 0);
  assert.equal(card.subline, null);
});

test('waiting with the data already in hand writes no retry rounds', () => {
  const card = downloadCard({
    events: [
      fetchEvent({ at: NOW_A - 30_000, mirror: AKAM, chunkIndex: 0, result: 'fetched' }),
      fetchEvent({ at: NOW_A - 10_000, mirror: AKAM, chunkIndex: 3, bytes: 818_559, result: 'invalid_response' }),
      fetchEvent({ at: NOW_A - 9_000, mirror: COS, chunkIndex: 3, bytes: 0, durationMs: 10_000, result: 'stalled' }),
    ],
    latestInventory: incidentInventory({ inflight: 1, queued: 2, videoContiguousEnd: 3 * MB, videoOutstanding: 0 }),
    nowMs: NOW_A,
    readouts: { waiting: true, currentTime: 91.3, duration: DURATION, forwardSeconds: 0 },
  });
  // outstanding 是 0：播放器要的数据已在扩展手里，等待另有原因，不写重试轮数。
  assert.equal(card.headline, '正在等 1:31 处的数据');
});

test('waiting with 124 seconds buffered names the decoder and keeps the download progress', () => {
  // 用户实测的那次：播放位置 100:56，缓冲 124 秒，整个视频已存好，第一行却写「在等
  // 数据」。数据都在手里，停下的是解码器。
  const card = downloadCard({
    events: [...raceEvents(), ...chunk3FailureEvents(), ...completionEvents()],
    latestInventory: incidentInventory({ inflight: 0, queued: 0, videoContiguousEnd: VIDEO_TOTAL }),
    nowMs: NOW_C,
    readouts: { waiting: true, currentTime: 6056, duration: 9637, forwardSeconds: 124 },
  });
  assert.equal(card.headline, '播放器解码没跟上，缓冲里还有 124 秒数据');
  assert.equal(card.subline, '整个视频已下载（全长 160:37）');
});

test('waiting with under 2 seconds buffered still reads as waiting for data', () => {
  const card = downloadCard({
    events: raceEvents(),
    latestInventory: incidentInventory({ inflight: 2, queued: 40, videoContiguousEnd: 3 * MB }),
    nowMs: NOW_A,
    readouts: { waiting: true, currentTime: 91.3, duration: DURATION, forwardSeconds: 1.9 },
  });
  assert.equal(card.headline, '正在等 1:31 处的数据');
  assert.equal(card.subline, null);
});

test('2.6 seconds buffered rounds to 3 seconds in the decoder line, same as the buffer card', () => {
  const card = downloadCard({
    events: raceEvents(),
    latestInventory: incidentInventory({ inflight: 2, queued: 40, videoContiguousEnd: 3 * MB }),
    nowMs: NOW_A,
    readouts: { waiting: true, currentTime: 91.3, duration: DURATION, forwardSeconds: 2.6 },
  });
  assert.equal(card.headline, '播放器解码没跟上，缓冲里还有 3 秒数据');
});

test('a new playback session starts the retry rounds at zero', () => {
  const failures = chunk3FailureEvents();
  const newestSession = deriveDownloadStatus({
    chunkEvents: [
      fetchEvent({ at: NOW_B - 1_000, mirror: AKAM, chunkIndex: 0, result: 'fetched' }),
    ],
    latestInventory: incidentInventory({ inflight: 2, queued: 20, videoContiguousEnd: 3 * MB, videoOutstanding: 1 }),
    nowMs: NOW_B,
  });
  assert.equal(newestSession.inventory.resources[0].failedRounds, 0);
  const oldSession = deriveDownloadStatus({
    chunkEvents: failures,
    latestInventory: incidentInventory({ inflight: 2, queued: 20, videoContiguousEnd: 3 * MB, videoOutstanding: 1 }),
    nowMs: NOW_B,
  });
  assert.equal(oldSession.inventory.resources[0].failedRounds, 8);
});

test('the last chunk just fetched but the inventory already reads zero in flight: pause, lines idle', () => {
  const card = downloadCard({
    events: [fetchEvent({ at: NOW_A - 2_000, mirror: AKAM, chunkIndex: 52, bytes: 579_089, result: 'fetched' })],
    latestInventory: incidentInventory({ inflight: 0, queued: 0, videoContiguousEnd: VIDEO_TOTAL }),
    nowMs: NOW_A,
    readouts: { waiting: false, currentTime: 91.5, duration: DURATION, forwardSeconds: 120 },
  });
  assert.equal(card.headline, '已下载够，暂停下载');
  assert.equal(card.subline, '整个视频已下载（全长 24:20）');
  assert.deepEqual(card.rows, [{ name: 'hz-mirrorakam', text: '空闲', tone: 'idle' }]);
});

test('paused downloads with failed rounds on the next missing chunk say the player will retry on demand', () => {
  const card = downloadCard({
    events: [0, 1, 2].map((i) => fetchEvent({
      at: NOW_A - 60_000 + i * 10_000,
      mirror: AKAM,
      chunkIndex: 3,
      bytes: 818_559,
      result: 'invalid_response',
    })),
    latestInventory: incidentInventory({ inflight: 0, queued: 0, videoContiguousEnd: 3 * MB }),
    nowMs: NOW_A,
    readouts: { waiting: false, currentTime: 45, duration: DURATION, forwardSeconds: 40 },
  });
  assert.equal(card.headline, '暂停下载，播放器要时再取');
  assert.equal(card.subline, '已提前下载到约 1:25（全长 24:20），之后的数据已重试 3 轮');
});

test('in flight or queued with nothing received in five seconds still reads as downloading', () => {
  const card = downloadCard({
    events: [fetchEvent({ at: NOW_A - 8_000, mirror: AKAM, chunkIndex: 0, result: 'fetched' })],
    latestInventory: incidentInventory({ inflight: 3, queued: 2, videoContiguousEnd: 3 * MB }),
    nowMs: NOW_A,
    readouts: { waiting: false, currentTime: 45, duration: DURATION, forwardSeconds: 40 },
  });
  assert.equal(card.headline, '正在下载，最近 5 秒没有收到数据');
  assert.deepEqual(card.rows, [{ name: 'hz-mirrorakam', text: '空闲', tone: 'idle' }]);
});

test('without an inventory snapshot the second line stays hidden', () => {
  const card = downloadCard({
    events: [fetchEvent({ at: NOW_A - 1_000, mirror: AKAM, chunkIndex: 0, result: 'fetched' })],
    latestInventory: undefined,
    nowMs: NOW_A,
    readouts: { waiting: false, currentTime: 10, duration: DURATION, forwardSeconds: 30 },
  });
  assert.equal(card.headline, '正在下载 · 合计 1.7 Mbps');
  assert.equal(card.subline, null);
});

test('live page with two lines: per-line speeds and the total, no second line', () => {
  const leg = (mirror, at) => fetchEvent({
    at,
    mirror,
    path: '/live/stream-1.m4s',
    chunkIndex: 0,
    bytes: 156_250,
    durationMs: 400,
    result: 'fetched',
  });
  const card = downloadCard({
    events: [
      leg('d1--ov-gotcha207.bilivideo.com', NOW_A - 1_000),
      leg('d1--ov-gotcha207.bilivideo.com', NOW_A - 2_000),
      leg('d1--ov-gotcha207b.bilivideo.com', NOW_A - 1_500),
      leg('d1--ov-gotcha207b.bilivideo.com', NOW_A - 2_500),
    ],
    latestInventory: undefined,
    nowMs: NOW_A,
    live: true,
  });
  assert.equal(card.headline, '正在下载 · 合计 1.0 Mbps');
  assert.equal(card.subline, null);
  assert.deepEqual(card.rows, [
    { name: 'ov-gotcha207', text: '下载中 · 0.5 Mbps', tone: 'ok' },
    { name: 'ov-gotcha207b', text: '下载中 · 0.5 Mbps', tone: 'ok' },
  ]);
});

test('live page with records outside every window: quiet headline and idle lines', () => {
  const card = downloadCard({
    events: [
      fetchEvent({ at: NOW_A - 20_000, mirror: 'd1--ov-gotcha207.bilivideo.com', path: '/live/stream-1.m4s', result: 'fetched' }),
      fetchEvent({ at: NOW_A - 20_000, mirror: 'd1--ov-gotcha207b.bilivideo.com', path: '/live/stream-1.m4s', bytes: 0, result: 'lost_race', slot: 1 }),
    ],
    latestInventory: undefined,
    nowMs: NOW_A,
    live: true,
  });
  assert.equal(card.headline, '最近 5 秒没有收到数据');
  assert.deepEqual(card.rows, [
    { name: 'ov-gotcha207', text: '空闲', tone: 'idle' },
    { name: 'ov-gotcha207b', text: '空闲', tone: 'idle' },
  ]);
});

test('live page when the last record on a line is a server error reports it in red', () => {
  const card = downloadCard({
    events: [
      fetchEvent({ at: NOW_A - 3_000, mirror: 'd1--ov-gotcha207.bilivideo.com', path: '/live/stream-1.m4s', bytes: 0, result: 'http_error' }),
      fetchEvent({ at: NOW_A - 2_800, mirror: 'd1--ov-gotcha207b.bilivideo.com', path: '/live/stream-1.m4s', bytes: 0, result: 'http_error' }),
    ],
    latestInventory: undefined,
    nowMs: NOW_A,
    live: true,
  });
  assert.equal(card.headline, '最近 5 秒没有收到数据');
  assert.deepEqual(card.rows, [
    { name: 'ov-gotcha207', text: '服务器返回错误', tone: 'bad' },
    { name: 'ov-gotcha207b', text: '服务器返回错误', tone: 'bad' },
  ]);
});

const LIVE_STREAM_DIR = '/live-bvc/791488/live_i9bl9s_SIPAZ9L_1b53ey_4000/';
const SWITCHED_FROM_DIR = '/live-bvc/791488/live_i9bl9s_SIPAZ9L_1b53ey_2500/';
const LIVE_PLAYER_HOST = 'd1--ov-gotcha207.bilivideo.com';
const LIVE_PAIR_HOST = 'd1--ov-gotcha105.bilivideo.com';
const LIVE_FLV_HOST = 'd1--cn-gotcha04.bilivideo.com';

function liveInventoryEvent({
  at,
  delivered = false,
  streamPath = LIVE_STREAM_DIR,
  inflight = [],
  playlistResponseAgeMs = null,
  playlistNewSegmentAgeMs = null,
  flvFrameAgeMs = null,
}) {
  return {
    wallTime: new Date(at).toISOString(),
    data: { streamPath, delivered, inflight, playlistResponseAgeMs, playlistNewSegmentAgeMs, flvFrameAgeMs },
  };
}

function inflightRequest({ ageMs, streamPath = LIVE_STREAM_DIR, legs }) {
  return { streamPath, ageMs, legs };
}

function inflightLeg(slot, mirror, bytes = 0) {
  return { slot, mirror, bytes, lastByteAgeMs: bytes === 0 ? null : 200 };
}

function liveCard(options) {
  return downloadCard({ events: [], latestInventory: undefined, nowMs: NOW_A, live: true, ...options });
}

// 直播页上一条刚结束的下载记录，让线路行与合计速度有内容可写。
function liveFetched(mirror, at, result = 'fetched', slot = 0) {
  return fetchEvent({
    at,
    mirror,
    path: `${LIVE_STREAM_DIR}423384050.m4s`,
    chunkIndex: 0,
    bytes: result === 'fetched' ? 156_250 : 0,
    durationMs: 400,
    slot,
    result,
  });
}

test('live snapshot row 1: a segment request waiting with every leg at zero bytes names the wait, before any leg has finished', () => {
  const card = liveCard({
    latestLiveInventory: liveInventoryEvent({
      at: NOW_A - 1_000,
      inflight: [inflightRequest({
        ageMs: 7_000,
        legs: [
          inflightLeg(0, LIVE_PLAYER_HOST),
          inflightLeg(1, LIVE_PAIR_HOST),
          inflightLeg(2, LIVE_FLV_HOST),
        ],
      })],
      playlistResponseAgeMs: 400,
      playlistNewSegmentAgeMs: 400,
    }),
  });
  assert.equal(card.headline, '在等一个分片，已 8 秒没收到数据');
  assert.equal(card.subline, null);
  assert.equal(card.message, null);
  assert.deepEqual(card.rows, [
    { name: 'cn-gotcha04', text: '等待中 8 秒', tone: 'warn' },
    { name: 'ov-gotcha105', text: '等待中 8 秒', tone: 'warn' },
    { name: 'ov-gotcha207', text: '等待中 8 秒', tone: 'warn' },
  ]);
});

test('live snapshot row 1 needs the request to have waited 2 seconds, counting the time since the snapshot was written', () => {
  const snapshot = (ageMs) => liveInventoryEvent({
    at: NOW_A - 100,
    inflight: [inflightRequest({ ageMs, legs: [inflightLeg(0, LIVE_PLAYER_HOST)] })],
  });
  const waiting = liveCard({ latestLiveInventory: snapshot(1_900) });
  assert.equal(waiting.headline, '在等一个分片，已 2 秒没收到数据');
  // 不满 2 秒时快照没有可说的话：还没有任何结束的腿，仍写「还没有下载数据」。
  const early = liveCard({ latestLiveInventory: snapshot(1_899) });
  assert.equal(early.headline, DOWNLOAD_CARD_TEXT.noRecords);
  assert.equal(early.rows.length, 0);
});

test('live snapshot row 2: bytes arriving slowly name the legs that received data and keep waiting on the rest', () => {
  const card = liveCard({
    latestLiveInventory: liveInventoryEvent({
      at: NOW_A - 1_000,
      inflight: [inflightRequest({
        ageMs: 5_000,
        legs: [inflightLeg(0, LIVE_PLAYER_HOST, 307_200), inflightLeg(1, LIVE_PAIR_HOST)],
      })],
    }),
  });
  assert.equal(card.headline, '分片下载中，已 6 秒，收到 300 KB');
  assert.deepEqual(card.rows, [
    { name: 'ov-gotcha105', text: '等待中 6 秒', tone: 'warn' },
    { name: 'ov-gotcha207', text: '下载中 · 已收到 300 KB', tone: 'ok' },
  ]);
});

test('live snapshot rows 1 and 2 keep the lines of finished legs next to the waiting ones', () => {
  const card = liveCard({
    events: [liveFetched(LIVE_PAIR_HOST, NOW_A - 3_000, 'http_error', 1)],
    latestLiveInventory: liveInventoryEvent({
      at: NOW_A - 500,
      inflight: [inflightRequest({ ageMs: 3_000, legs: [inflightLeg(0, LIVE_PLAYER_HOST)] })],
    }),
  });
  assert.equal(card.headline, '在等一个分片，已 3 秒没收到数据');
  assert.deepEqual(card.rows, [
    { name: 'ov-gotcha105', text: '服务器返回错误', tone: 'bad' },
    { name: 'ov-gotcha207', text: '等待中 3 秒', tone: 'warn' },
  ]);
});

test('live snapshot row 3: the playlist still refreshes but adds no segment, lines read idle, FLV silence is appended', () => {
  const events = [liveFetched(LIVE_PLAYER_HOST, NOW_A - 4_000)];
  const withFlv = (flvFrameAgeMs) => liveCard({
    events,
    latestLiveInventory: liveInventoryEvent({
      at: NOW_A - 1_000,
      playlistResponseAgeMs: 500,
      playlistNewSegmentAgeMs: 11_000,
      flvFrameAgeMs,
    }),
  });
  const quiet = withFlv(4_000);
  assert.equal(quiet.headline, '播放列表 12 秒没有新分片，FLV 后备也没有新画面');
  assert.deepEqual(quiet.rows, [{ name: 'ov-gotcha207', text: '空闲', tone: 'idle' }]);
  // FLV 连接 3 秒内还有画面，或没有 FLV 后备，都不接这一句。
  assert.equal(withFlv(1_000).headline, '播放列表 12 秒没有新分片');
  assert.equal(withFlv(null).headline, '播放列表 12 秒没有新分片');
  // 3 秒的门槛含边界：新分片年龄加上写出后的 1 秒刚好 3 秒就写。
  const edge = liveCard({
    latestLiveInventory: liveInventoryEvent({ at: NOW_A - 1_000, playlistResponseAgeMs: 0, playlistNewSegmentAgeMs: 2_000 }),
  });
  assert.equal(edge.headline, '播放列表 3 秒没有新分片');
  const below = liveCard({
    latestLiveInventory: liveInventoryEvent({ at: NOW_A - 1_000, playlistResponseAgeMs: 0, playlistNewSegmentAgeMs: 1_999 }),
  });
  assert.equal(below.headline, DOWNLOAD_CARD_TEXT.noRecords);
});

test('live snapshot row 4: the player stopped refreshing the playlist, lines read idle', () => {
  const card = liveCard({
    events: [liveFetched(LIVE_PLAYER_HOST, NOW_A - 4_000)],
    latestLiveInventory: liveInventoryEvent({
      at: NOW_A - 1_000,
      playlistResponseAgeMs: 11_000,
      playlistNewSegmentAgeMs: 11_000,
      flvFrameAgeMs: 11_000,
    }),
  });
  assert.equal(card.headline, '播放器 12 秒没有请求数据');
  assert.deepEqual(card.rows, [{ name: 'ov-gotcha207', text: '空闲', tone: 'idle' }]);
  // 播放列表上一份响应满 3 秒归第 4 行，不满 3 秒（仍在刷新）才轮得到第 3 行。
  const refreshing = liveCard({
    latestLiveInventory: liveInventoryEvent({ at: NOW_A - 1_000, playlistResponseAgeMs: 1_999, playlistNewSegmentAgeMs: 9_000 }),
  });
  assert.equal(refreshing.headline, '播放列表 10 秒没有新分片');
  const stopped = liveCard({
    latestLiveInventory: liveInventoryEvent({ at: NOW_A - 1_000, playlistResponseAgeMs: 2_000, playlistNewSegmentAgeMs: 9_000 }),
  });
  assert.equal(stopped.headline, '播放器 3 秒没有请求数据');
  // 这个流还没有播放列表响应时没有可说的话。
  const unknown = liveCard({
    latestLiveInventory: liveInventoryEvent({ at: NOW_A - 1_000 }),
  });
  assert.equal(unknown.headline, DOWNLOAD_CARD_TEXT.noRecords);
});

test('live snapshot rows 5 and 6 keep the download-record wording when no snapshot row holds', () => {
  const calm = (events) => liveCard({
    events,
    latestLiveInventory: liveInventoryEvent({
      at: NOW_A - 500,
      inflight: [inflightRequest({ ageMs: 300, legs: [inflightLeg(0, LIVE_PLAYER_HOST)] })],
      playlistResponseAgeMs: 200,
      playlistNewSegmentAgeMs: 200,
    }),
  });
  const downloading = calm([liveFetched(LIVE_PLAYER_HOST, NOW_A - 1_000), liveFetched(LIVE_PLAYER_HOST, NOW_A - 2_000)]);
  assert.equal(downloading.headline, '正在下载 · 合计 0.5 Mbps');
  assert.deepEqual(downloading.rows, [{ name: 'ov-gotcha207', text: '下载中 · 0.5 Mbps', tone: 'ok' }]);
  const quiet = calm([liveFetched(LIVE_PLAYER_HOST, NOW_A - 20_000)]);
  assert.equal(quiet.headline, '最近 5 秒没有收到数据');
  assert.deepEqual(quiet.rows, [{ name: 'ov-gotcha207', text: '空闲', tone: 'idle' }]);
});

test('a snapshot speaks only while valid: not after delivery, not 3 seconds after its write, not with the live switch off', () => {
  const stalled = (at, delivered = false) => liveInventoryEvent({
    at,
    delivered,
    inflight: [inflightRequest({ ageMs: 5_000, legs: [inflightLeg(0, LIVE_PLAYER_HOST)] })],
  });
  assert.equal(liveCard({ latestLiveInventory: stalled(NOW_A - 2_999) }).headline, '在等一个分片，已 7 秒没收到数据');
  assert.equal(liveCard({ latestLiveInventory: stalled(NOW_A - 3_000) }).headline, DOWNLOAD_CARD_TEXT.noRecords);
  assert.equal(liveCard({ latestLiveInventory: stalled(NOW_A - 100, true) }).headline, DOWNLOAD_CARD_TEXT.noRecords);
  const off = liveCard({ latestLiveInventory: stalled(NOW_A - 100), liveEnabled: false });
  assert.equal(off.headline, DOWNLOAD_CARD_TEXT.liveSwitchOff);
  // 视频页不读直播快照。
  const video = downloadCard({
    events: [],
    latestInventory: undefined,
    latestLiveInventory: stalled(NOW_A - 100),
    nowMs: NOW_A,
    live: false,
  });
  assert.equal(video.headline, DOWNLOAD_CARD_TEXT.noRecords);
});

test('validity follows the read time while the seconds keep counting up to the render time', () => {
  const snapshot = liveInventoryEvent({
    at: NOW_A - 2_900,
    inflight: [inflightRequest({ ageMs: 4_000, legs: [inflightLeg(0, LIVE_PLAYER_HOST)] })],
  });
  // 取数时快照写出 2.9 秒，弹窗到下一次取数前继续渲染：快照不会在两次取数之间过期，秒数照走。
  const atRead = liveCard({ latestLiveInventory: snapshot });
  assert.equal(atRead.headline, '在等一个分片，已 6 秒没收到数据');
  const later = liveCard({ latestLiveInventory: snapshot, renderNowMs: NOW_A + 1_500 });
  assert.equal(later.headline, '在等一个分片，已 8 秒没收到数据');
  assert.deepEqual(later.rows, [{ name: 'ov-gotcha207', text: '等待中 8 秒', tone: 'warn' }]);
});

test('at a quality switch only the request of the current stream names the wait', () => {
  const oldRequest = inflightRequest({
    ageMs: 9_000,
    streamPath: SWITCHED_FROM_DIR,
    legs: [inflightLeg(0, LIVE_PLAYER_HOST), inflightLeg(1, LIVE_PAIR_HOST)],
  });
  const newRequest = inflightRequest({
    ageMs: 2_500,
    legs: [inflightLeg(0, LIVE_PLAYER_HOST, 1_000)],
  });
  const card = liveCard({
    latestLiveInventory: liveInventoryEvent({
      at: NOW_A - 500,
      inflight: [oldRequest, newRequest],
      playlistResponseAgeMs: 100,
      playlistNewSegmentAgeMs: 100,
    }),
  });
  assert.equal(card.headline, '分片下载中，已 3 秒，收到 1000 B');
  assert.deepEqual(card.rows, [{ name: 'ov-gotcha207', text: '下载中 · 已收到 1000 B', tone: 'ok' }]);
  // 当前流没有在途请求时，旧流还没放手的请求不算播放器在等的分片：按播放列表的事实写。
  const idleCurrent = liveCard({
    latestLiveInventory: liveInventoryEvent({
      at: NOW_A - 1_000,
      inflight: [oldRequest],
      playlistResponseAgeMs: 11_000,
      playlistNewSegmentAgeMs: 11_000,
    }),
  });
  assert.equal(idleCurrent.headline, '播放器 12 秒没有请求数据');
});

test('the oldest request of the current stream names the wait when two are in flight', () => {
  const card = liveCard({
    latestLiveInventory: liveInventoryEvent({
      at: NOW_A,
      inflight: [
        inflightRequest({ ageMs: 2_000, legs: [inflightLeg(0, LIVE_PLAYER_HOST)] }),
        inflightRequest({ ageMs: 6_000, legs: [inflightLeg(0, LIVE_PLAYER_HOST), inflightLeg(1, LIVE_PAIR_HOST)] }),
      ],
    }),
  });
  assert.equal(card.headline, '在等一个分片，已 6 秒没收到数据');
  assert.equal(card.rows.length, 2);
});

test('live lines name a leg the player cancelled and an FLV leg that found no frames; the video page keeps them idle', () => {
  const events = [
    liveFetched(LIVE_PLAYER_HOST, NOW_A - 3_000, 'aborted'),
    liveFetched(LIVE_FLV_HOST, NOW_A - 2_500, 'frames_missing', 2),
  ];
  const live = liveCard({ events });
  assert.equal(live.headline, '最近 5 秒没有收到数据');
  assert.deepEqual(live.rows, [
    { name: 'cn-gotcha04', text: 'FLV 里没有这段画面', tone: 'warn' },
    { name: 'ov-gotcha207', text: '播放器已取消', tone: 'idle' },
  ]);
  const video = downloadCard({ events, latestInventory: undefined, nowMs: NOW_A, live: false });
  assert.deepEqual(video.rows.map((row) => row.text), ['空闲', '空闲']);
});

test('byte counts read as bytes, KB or MB', () => {
  assert.equal(bytesText(0), '0 B');
  assert.equal(bytesText(1_023), '1023 B');
  assert.equal(bytesText(1_024), '1 KB');
  assert.equal(bytesText(307_200), '300 KB');
  assert.equal(bytesText(1_048_576), '1.0 MB');
  assert.equal(bytesText(5_400_000), '5.1 MB');
});

test('download card view covers loading, failure, and no-session messages', () => {
  const document = popupDocument();
  const container = document.querySelector('[data-cdn-lines]');
  const args = { live: false, readouts: undefined, vodEnabled: true, liveEnabled: true };
  renderCdnLines(document, container, downloadLinesView({ ...args, response: undefined, error: undefined, inFlight: true }));
  assert.equal(container.querySelector('.cdn-empty').textContent, DOWNLOAD_CARD_TEXT.loading);
  renderCdnLines(document, container, downloadLinesView({ ...args, response: undefined, error: undefined, inFlight: false }));
  assert.equal(container.querySelector('.cdn-empty').textContent, DOWNLOAD_CARD_TEXT.noSession);
  renderCdnLines(document, container, downloadLinesView({ ...args, response: undefined, error: 'worker 挂了', inFlight: false }));
  assert.equal(container.querySelector('.cdn-empty').textContent, DOWNLOAD_CARD_TEXT.readFailed);
});

test('buffer renders seconds ahead against the 120-second target on a bar', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderBuffer(document, refs, { forwardSeconds: 80.4, targetSeconds: 120, stateText: '已生效', targetLabel: '已向播放器申请 120 秒缓存' });
  assert.equal(refs.seconds.textContent, '80 秒');
  assert.equal(refs.goal.textContent, '/ 目标 120 秒');
  assert.equal(refs.fill.style.width, '67%');
  assert.equal(refs.bar.classList.contains('reached'), false);
  assert.equal(refs.note.hidden, true);
  assert.equal(refs.targetValue.textContent, '已生效');
  assert.equal(refs.stateLine.hidden, false);
  assert.equal(refs.targetLabel.textContent, '已向播放器申请 120 秒缓存');
});

test('buffer bar fills fully and reports the reached state at or beyond the target', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderBuffer(document, refs, { forwardSeconds: 135.5, targetSeconds: 120, stateText: '已生效', targetLabel: 'x' });
  assert.equal(refs.seconds.textContent, '136 秒');
  assert.equal(refs.fill.style.width, '100%');
  assert.equal(refs.bar.classList.contains('reached'), true);
});

test('buffer without a playing video shows a plain note instead of numbers', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderBuffer(document, refs, { forwardSeconds: undefined, targetSeconds: 120, stateText: '', targetLabel: 'x' });
  assert.equal(refs.seconds.textContent, '—');
  assert.equal(refs.goal.textContent, '');
  assert.equal(refs.fill.style.width, '0%');
  assert.equal(refs.note.hidden, false);
  assert.equal(refs.note.textContent, '当前页面没有在播放的视频');
  assert.equal(refs.stateLine.hidden, true);
});

test('target state words cover applied, waiting, unsupported, failed, and toggle-off', () => {
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '已应用', enhancementEnabled: true }), '已生效');
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '等待', enhancementEnabled: true }), '等待生效');
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '不支持', enhancementEnabled: true }), '播放器不支持，未生效');
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '失败', enhancementEnabled: true }), '申请失败');
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '未提供', enhancementEnabled: false }), SWITCH_OFF_TEXT.videoOffValue);
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '未提供', enhancementEnabled: true }), '等待增强启动');
  assert.equal(targetStateText({ hasVideo: false, stateLabel: '失败', enhancementEnabled: true }), '');
});

test('video panel shows an error only when the page reported one', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderVideoPanel(document, refs, {
    forwardSeconds: 30,
    snapshot: { state: '已应用', error: '未提供' },
    enhancementEnabled: true,
    targetSeconds: 120,
  });
  assert.equal(refs.errorLine.hidden, true);
  renderVideoPanel(document, refs, {
    forwardSeconds: 30,
    snapshot: { state: '失败', error: '原生缓存提示调用失败' },
    enhancementEnabled: true,
    targetSeconds: 120,
  });
  assert.equal(refs.errorLine.hidden, false);
  assert.equal(refs.errorLine.textContent, '原生缓存提示调用失败');
});

test('video panel with the switch off states the switch instead of claiming a buffer request', () => {
  // 开关关闭时从未向播放器申请缓存目标：目标后缀与「已向播放器申请」措辞一起收起，
  // 缓冲数字仍是观测事实（播放器自己的缓冲），只去掉关于扩展行为的假陈述。
  const document = popupDocument();
  const refs = popupRefs(document);
  renderVideoPanel(document, refs, {
    forwardSeconds: 30,
    snapshot: { state: '未提供', error: '未提供' },
    enhancementEnabled: false,
    targetSeconds: 120,
  });
  assert.equal(refs.stateLine.hidden, false);
  assert.equal(refs.targetLabel.textContent, SWITCH_OFF_TEXT.videoLabel);
  assert.equal(refs.targetValue.textContent, SWITCH_OFF_TEXT.videoOffValue);
  assert.equal(refs.seconds.textContent, '30 秒');
  assert.equal(refs.goal.textContent, '');
});

test('video panel with the switch on keeps the request label and goal suffix', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderVideoPanel(document, refs, {
    forwardSeconds: 30,
    snapshot: { state: '已应用', error: '未提供' },
    enhancementEnabled: true,
    targetSeconds: 120,
  });
  assert.equal(refs.targetLabel.textContent, '已向播放器申请 120 秒缓存');
  assert.equal(refs.targetValue.textContent, '已生效');
  assert.equal(refs.goal.textContent, '/ 目标 120 秒');
});

test('surface error text ignores placeholders and empty messages', () => {
  assert.equal(surfaceErrorText({ error: '原生缓存提示调用失败' }), '原生缓存提示调用失败');
  assert.equal(surfaceErrorText({ error: '未提供' }), undefined);
  assert.equal(surfaceErrorText({ error: '' }), undefined);
  assert.equal(surfaceErrorText(undefined), undefined);
});

test('live facts fold serve events into the takeover state only', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: false } },
    { code: 'media.sample', data: { currentTime: 1 } },
    null,
    { code: 'bank.fetch.chunk', data: { result: 'fetched' } },
  ]);
  assert.equal(facts.serveCount, 1);
  assert.equal(facts.engagement, 'engaged');
  assert.equal(facts.pairedAddressAvailable, true);
});

test('serve classification separates engaged takeovers from passes', () => {
  assert.equal(liveServeClass('hit'), 'engaged');
  assert.equal(liveServeClass('failed'), 'failed');
  assert.equal(liveServeClass('pass'), 'pass');
  assert.equal(liveServeClass(undefined), 'pass');
});

test('a passed-through live stream never reads as a takeover', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'pass', reason: 'non_media_host' } },
    { code: 'bank.serve', data: { result: 'pass', reason: 'live_hls_playlist' } },
  ]);
  assert.equal(facts.serveCount, 2);
  assert.equal(facts.engagement, undefined);
  assert.equal(liveTakeoverText(facts), '未接管（未发现直播媒体流）');
});

test('an engaged takeover stays engaged even when other requests pass through', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'bank.serve', data: { result: 'pass', reason: 'non_media_host' } },
    { code: 'bank.serve', data: { result: 'pass', reason: 'live_hls_playlist' } },
  ]);
  assert.equal(liveTakeoverText(facts), '正在按两条线路竞速下载');
});

test('a prefix mismatch withdraws the racing claim down to single leg', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: true, phase: 'prefix' } },
  ]);
  assert.equal(liveTakeoverText(facts), '单路接管（无可用备用线路）');
  const cleanPair = emptyLiveFacts();
  foldLiveEvents(cleanPair, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: false, phase: 'prefix' } },
  ]);
  assert.equal(liveTakeoverText(cleanPair), '正在按两条线路竞速下载');
});

test('a stream that dies after engaging reports the failure instead of racing', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'bank.serve', data: { result: 'failed', reason: 'live_stream_failed' } },
  ]);
  assert.equal(liveTakeoverText(facts), '接管请求失败');
});

test('a retried takeover resets the state to the new takeover facts', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: true, phase: 'prefix' } },
    { code: 'bank.serve', data: { result: 'failed', reason: 'live_stream_failed' } },
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream' } },
    { code: 'bank.serve', data: { result: 'pass', reason: 'live_hls_playlist' } },
  ]);
  assert.equal(facts.pairedAddressAvailable, false);
  assert.equal(facts.pairRejected, false);
  assert.equal(liveTakeoverText(facts), '单路接管（无可用备用线路）');
});

test('live takeover wording covers racing, single line, failure, pass-through, and waiting', () => {
  assert.equal(liveTakeoverText({ serveCount: 2, engagement: 'engaged', pairedAddressAvailable: true }), '正在按两条线路竞速下载');
  assert.equal(liveTakeoverText({ serveCount: 2, engagement: 'engaged', pairedAddressAvailable: false }), '单路接管（无可用备用线路）');
  assert.equal(liveTakeoverText({ serveCount: 3, engagement: 'failed' }), '接管请求失败');
  assert.equal(liveTakeoverText({ serveCount: 3 }), '未接管（未发现直播媒体流）');
  assert.equal(liveTakeoverText(emptyLiveFacts()), '等待直播数据');
  assert.equal(liveTakeoverText(undefined), '等待直播数据');
});

test('live takeover with the switch off and no takeover facts states the switch instead of waiting', () => {
  // 开关关闭时接管按设计永不介入（README 下载层让路规则不产生 bank.serve）：
  // 再说「等待直播数据」就是让面板空等，直说开关已关闭。
  assert.equal(liveTakeoverText(emptyLiveFacts(), { liveEnabled: false }), SWITCH_OFF_TEXT.liveOff);
  assert.equal(liveTakeoverText(undefined, { liveEnabled: false }), SWITCH_OFF_TEXT.liveOff);
  assert.equal(liveTakeoverText(emptyLiveFacts(), { liveEnabled: true }), '等待直播数据');
});

test('live takeover facts win over a switch-off that has not been refreshed yet', () => {
  // 改动在刷新页面后生效：刷新前接管仍在运行，面板继续报接管事实，不抢戏报开关。
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
  ]);
  assert.equal(liveTakeoverText(facts, { liveEnabled: false }), '正在按两条线路竞速下载');
});

test('hls segment takeover folds through the same live facts as the flv stream', () => {
  const racing = emptyLiveFacts();
  foldLiveEvents(racing, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_hls_segment', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: false, phase: 'segment' } },
  ]);
  assert.equal(liveTakeoverText(racing), '正在按两条线路竞速下载');

  const mismatched = emptyLiveFacts();
  foldLiveEvents(mismatched, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_hls_segment', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { streamPath: '/live-bvc/791488/live_x/', bytesChecked: 4, mismatch: true, phase: 'segment' } },
  ]);
  assert.equal(mismatched.pairRejected, true);
  assert.equal(liveTakeoverText(mismatched), '单路接管（无可用备用线路）');

  const single = emptyLiveFacts();
  foldLiveEvents(single, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_hls_segment_unpaired', pairMiss: 'no_book_entry' } },
  ]);
  assert.equal(single.pairedAddressAvailable, false);
  assert.equal(liveTakeoverText(single), '单路接管（无可用备用线路）');

  const failed = emptyLiveFacts();
  foldLiveEvents(failed, [
    { code: 'bank.serve', data: { result: 'failed', reason: 'live_hls_segment_failed' } },
  ]);
  assert.equal(liveTakeoverText(failed), '接管请求失败');

  const playlistOnly = emptyLiveFacts();
  foldLiveEvents(playlistOnly, [
    { code: 'bank.serve', data: { result: 'pass', reason: 'live_hls_playlist' } },
  ]);
  assert.equal(playlistOnly.engagement, undefined);
  assert.equal(liveTakeoverText(playlistOnly), '未接管（未发现直播媒体流）');
});

test('live takeover renders the plain line and degrades on read errors', () => {
  const document = popupDocument();
  const refs = { takeover: document.querySelector('[data-live-takeover]') };
  renderLiveTakeover(refs, { facts: { serveCount: 1, engagement: 'engaged', pairedAddressAvailable: true } });
  assert.equal(refs.takeover.textContent, '正在按两条线路竞速下载');
  renderLiveTakeover(refs, { facts: emptyLiveFacts(), error: '日志分页没有向前推进' });
  assert.equal(refs.takeover.textContent, '直播状态读取失败');
  renderLiveTakeover(refs, { facts: emptyLiveFacts(), liveEnabled: false });
  assert.equal(refs.takeover.textContent, SWITCH_OFF_TEXT.liveOff);
});

test('pages without the content script collapse the cards down to one friendly line', () => {
  const document = popupDocument();
  applyPageAvailability(document, false);
  assert.equal(document.querySelector('main').classList.contains('no-page'), true);
  applyPageAvailability(document, true);
  assert.equal(document.querySelector('main').classList.contains('no-page'), false);
  assert.equal(NO_PAGE_MESSAGES.noReceiver.includes('Bilibili'), true);
  assert.equal(NO_PAGE_MESSAGES.noTab.includes('Bilibili'), true);
});

// ---- 完整 popup 装配（jsdom + 假 chrome）：活动标签页换页后的探测行为 ----
const RECEIVER_MISSING = 'Could not establish connection. Receiving end does not exist.';

function liveReadouts(sessionId = 'session-live-1') {
  return {
    version: 2,
    routeKind: 'live',
    forwardSeconds: undefined,
    diagnostics: { sessionId },
  };
}

function videoReadouts(sessionId = 'session-video-1') {
  return {
    version: 2,
    routeKind: 'video',
    forwardSeconds: 80,
    diagnostics: { sessionId },
  };
}

// chrome.tabs.query 的 url 过滤语义（match pattern 子集：scheme://host/path，path 末尾 *）。
// 面板扩展没有 tabs 权限：地址只参与 Chrome 内部过滤，不会出现在返回的标签页对象上。
function urlMatchesPattern(url, pattern) {
  const match = /^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)$/.exec(pattern);
  assert.ok(match !== null, `fixture 里遇到未支持的 match pattern: ${pattern}`);
  const [, scheme, host, pathPattern] = match;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return false;
  }
  if (scheme !== '*' && parsed.protocol !== `${scheme}:`) return false;
  const hostPattern = host.startsWith('*.') ? `*.${host.slice(2)}` : host;
  const hostMatches = hostPattern === '*'
    || parsed.hostname === host
    || (host.startsWith('*.') && parsed.hostname.endsWith(hostPattern.slice(1)));
  if (!hostMatches) return false;
  const escaped = pathPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*');
  return new RegExp(`^${escaped}$`).test(parsed.pathname);
}

// 假 Chrome 的窗口世界：windows 是 [{ id, tabs: [{ id, url, active }] }]。假
// chrome.tabs.query 复刻无 tabs 权限行为：url 过滤在 Chrome 内部判定，返回的标签页
// 不携带 url 字段。popupAttachedTab 需要的 windowId 字段始终可见，予以保留。
function popupChromeMock({ currentWindowId, lastFocusedWindowId, windows, tabBehaviors }) {
  const calls = { queries: [], tabMessages: [], runtimeMessages: [] };
  const tabsOfWindow = (windowId) => windows.find((w) => w.id === windowId)?.tabs ?? [];
  const stripUrl = (tab) => ({ id: tab.id, active: tab.active, windowId: tab.windowId });
  const windowed = (tab, windowId) => ({ ...tab, windowId });
  const allTabs = windows.flatMap((w) => w.tabs.map((tab) => windowed(tab, w.id)));
  const visibleTabs = (windowId) => tabsOfWindow(windowId).map((tab) => windowed(tab, windowId));
  const chrome = {
    windows: {
      getCurrent: async () => ({ id: currentWindowId }),
    },
    runtime: {
      lastError: undefined,
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
      sendMessage: async (message) => {
        calls.runtimeMessages.push(message);
        if (message.type === 'logs:live-summary') {
          return {
            ok: true,
            maxEventId: 10,
            sampleCount: 2,
            facts: { serveCount: 2, engagement: 'engaged', pairedAddressAvailable: true, pairRejected: false },
          };
        }
        if (message.type === 'logs:cdn-summary') {
          return {
            ok: true,
            maxEventId: 10,
            sampleCount: 1,
            summary: {
              totalChunks: 1,
              pairedChunks: 1,
              pairCoverage: 1,
              fetchedBytes: 16,
              wastedBytes: 0,
              wastedByteRatio: 0,
              byResult: { fetched: 1, lost_race: 0, stalled: 0, aborted: 0, superseded: 0, network_error: 0, http_error: 0, invalid_response: 0, gave_up: 0 },
              rows: [{ mirror: 'd1--ov-gotcha207.bilivideo.com', racesEntered: 1, wins: 1, winRate: 1, ttfbP50: 40, ttfbP90: 60, stalled: 0, failures: 0, bytesDelivered: 16 }],
            },
            downloadStatus: {
              hasRecords: true,
              anyLineBytesInWindow: true,
              totalBitsPerSecond: 320_000,
              lines: [{
                mirror: 'd1--ov-gotcha207.bilivideo.com',
                bitsPerSecond: 320_000,
                receivedInWindow: true,
                fetchedEndsInWindow: true,
                seenInActivityWindow: true,
                lastResultInWindow: 'fetched',
              }],
              inventory: undefined,
            },
          };
        }
        throw new Error(`意外的日志读取消息 ${message.type}`);
      },
    },
    storage: { local: { get: async () => ({}) } },
    tabs: {
      query: async (options) => {
        calls.queries.push(options);
        if (options.active === true && options.windowId !== undefined) {
          return visibleTabs(options.windowId).filter((tab) => tab.active === true).map(stripUrl);
        }
        if (options.active === true && options.lastFocusedWindow === true) {
          return visibleTabs(lastFocusedWindowId).filter((tab) => tab.active === true).map(stripUrl);
        }
        if (Array.isArray(options.url)) {
          const candidates = options.windowId !== undefined ? visibleTabs(options.windowId) : allTabs;
          return candidates
            .filter((tab) => options.url.some((pattern) => urlMatchesPattern(tab.url, pattern)))
            .map(stripUrl);
        }
        return allTabs.map(stripUrl);
      },
      sendMessage: async (tabId, message) => {
        calls.tabMessages.push({ tabId, type: message.type });
        const behavior = tabBehaviors.get(tabId);
        if (behavior === undefined) throw new Error(RECEIVER_MISSING);
        if (behavior === 'reject') throw new Error(RECEIVER_MISSING);
        return behavior(message);
      },
      create: async () => ({}),
    },
  };
  return { chrome, calls };
}

async function withPopupAssembly(chrome, run) {
  const dom = new JSDOM(popupHtml);
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousChrome = globalThis.chrome;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.chrome = chrome;
  try {
    await import(`../src/extension/popup.js?case=${Date.now()}-${Math.random()}`);
    await run(dom.window);
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.chrome = previousChrome;
  }
}

function settleMacrotasks(rounds = 4) {
  let remaining = rounds;
  return new Promise((resolve) => {
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else setImmediate(step);
    };
    setImmediate(step);
  });
}

test('popup reports the active tab of its own window, never the last-focused window\'s', async () => {
  // 回归锚（0e982f5 的缺陷，用户实测）：两个普通窗口时，弹窗开在视频页
  // 所在窗口，lastFocusedWindow 解析到另一窗口的直播房间；本装配下 lastFocusedWindow
  // 查询固定返回直播标签页（id 2），按旧取法面板会显示直播内容。
  const behaviors = new Map([
    [1, (message) => {
      if (message.type === 'readouts:get') return videoReadouts();
      if (message.type === 'status:get') return { version: 2, ok: true, state: '未提供' };
      if (message.type === 'diagnostics:session-id:get') return { version: 2, ok: true, sessionId: 'session-video-1' };
      throw new Error(`意外消息 ${message.type}`);
    }],
    [2, (message) => {
      if (message.type === 'readouts:get') return liveReadouts();
      throw new Error(`意外消息 ${message.type}`);
    }],
  ]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 20,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://www.bilibili.com/video/BV1', active: true }] },
      { id: 20, tabs: [{ id: 2, url: 'https://live.bilibili.com/6', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, 'true');
    assert.equal(document.querySelector('main').classList.contains('no-page'), false);
    assert.equal(document.querySelector('[data-notice]').textContent, '');
    // 本窗口是视频标签页：直播接管卡收起，缓冲卡保持可见，直播事实不得泄漏进来。
    assert.equal(document.querySelector('[data-live-panel]').hidden, true);
    assert.equal(document.querySelector('[aria-label="缓冲"]').hidden, false);
    // 只问本窗口的活动标签页；跨窗口的直播标签页一次都没有被询问过。
    assert.deepEqual(
      [...new Set(calls.tabMessages.filter((call) => call.type === 'readouts:get').map((call) => call.tabId))],
      [1],
    );
    assert.equal(calls.tabMessages.some((call) => call.tabId === 2), false, '不得询问另一个窗口的标签页');
    // 归属一律经 windowId：lastFocusedWindow 与全窗口扫描都不再出现。
    assert.equal(
      calls.queries.some((options) => options.lastFocusedWindow === true),
      false,
      '不得按 lastFocusedWindow 定位标签页',
    );
    assert.equal(
      calls.queries.every((options) => options.windowId !== undefined || Array.isArray(options.url)),
      true,
      '不得发起全窗口扫描查询',
    );
    // 打开日志按钮带的是本窗口视频标签页的 session。
    document.querySelector('[data-open-logs]').click();
    await settleMacrotasks();
    assert.deepEqual(
      calls.tabMessages.filter((call) => call.type === 'diagnostics:session-id:get').map((call) => call.tabId),
      [1],
    );
  });
});

test('popup never adopts another window\'s enhanced tab when its own active tab cannot answer', async () => {
  const behaviors = new Map([
    [1, 'reject'],
    [2, (message) => {
      if (message.type === 'readouts:get') return videoReadouts();
      if (message.type === 'status:get') return { version: 2, ok: true, state: '未提供' };
      throw new Error(`意外消息 ${message.type}`);
    }],
  ]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 20,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://example.com/', active: true }] },
      { id: 20, tabs: [{ id: 2, url: 'https://www.bilibili.com/video/BV1', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, undefined);
    assert.equal(document.querySelector('main').classList.contains('no-page'), true);
    assert.equal(document.querySelector('[data-notice]').textContent, NO_PAGE_MESSAGES.noReceiver);
    assert.equal(calls.runtimeMessages.some((message) => message.type === 'logs:live-summary'), false);
    assert.deepEqual(
      [...new Set(calls.tabMessages.map((call) => call.tabId))],
      [1],
      '另一个窗口仍在运行增强的标签页不得被询问或显示',
    );
  });
});

test('a pre-existing Bilibili page without the content script gets the truthful merged message', async () => {
  // 页面在扩展安装或更新前就已打开：旧文档没有内容脚本可答。弹窗没有 tabs 权限、
  // 看不到标签页地址，分不出这种情况与「非 Bilibili 页面」，统一的未运行提示对两种
  // 情况都成立：说明刷新后增强才会运行，不谎称页面不受支持。
  const behaviors = new Map([[1, 'reject']]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 10,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://www.bilibili.com/video/BV1', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, undefined);
    assert.equal(document.querySelector('main').classList.contains('no-page'), true);
    assert.equal(document.querySelector('[data-notice]').textContent, NO_PAGE_MESSAGES.noReceiver);
    assert.ok(NO_PAGE_MESSAGES.noReceiver.includes('刷新'), '提示必须给出刷新路径');
    assert.ok(NO_PAGE_MESSAGES.noReceiver.includes('视频或直播'), '提示不得谎称页面不受支持');
  });
});

test('a non-Bilibili active tab keeps the plain not-running message', async () => {
  const behaviors = new Map([[1, 'reject']]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 10,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://example.com/', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.querySelector('main').classList.contains('no-page'), true);
    assert.equal(document.querySelector('[data-notice]').textContent, NO_PAGE_MESSAGES.noReceiver);
    // 没必要且没有权限做的 url 过滤查询不得出现。
    assert.equal(calls.queries.some((options) => Array.isArray(options.url)), false);
  });
});

test('popup asks only its own window\'s active tab while that tab answers', async () => {
  const behaviors = new Map([
    [1, (message) => {
      if (message.type === 'readouts:get') return liveReadouts();
      if (message.type === 'status:get') return { version: 2, ok: true, state: '未提供' };
      throw new Error(`意外消息 ${message.type}`);
    }],
  ]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 10,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://live.bilibili.com/6', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, 'true');
    assert.equal(document.querySelector('[data-notice]').textContent, '');
    assert.equal(document.querySelector('[data-live-panel]').hidden, false);
    assert.equal(document.querySelector('[data-live-takeover]').textContent, '正在按两条线路竞速下载');
    assert.deepEqual(
      [...new Set(calls.tabMessages.filter((call) => call.type === 'readouts:get').map((call) => call.tabId))],
      [1],
    );
    // 直播状态走 worker 摘要，不再按全局 eventId 分页扫全库。
    assert.equal(calls.runtimeMessages.some((message) => message.type === 'logs:live-summary'), true);
    assert.equal(calls.runtimeMessages.some((message) => message.type === 'logs:events-page'), false);
  });
});

test('video popup feeds the status:get snapshot to the target-state line', async () => {
  // 回归锚：status:get 拿到的 snapshot 必须进入 video 面板的申请状态行
  // （一度在面板装配里取回但未接上，状态行永远停在「等待增强启动」）。
  const behaviors = new Map([
    [1, (message) => {
      if (message.type === 'readouts:get') return videoReadouts();
      if (message.type === 'status:get') return { version: 2, ok: true, state: '已应用', error: '未提供' };
      if (message.type === 'diagnostics:session-id:get') return { version: 2, ok: true, sessionId: 'session-video-1' };
      throw new Error(`意外消息 ${message.type}`);
    }],
  ]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 10,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://www.bilibili.com/video/BV1', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, 'true');
    assert.equal(document.querySelector('[data-target-value]').textContent, '已生效');
    assert.equal(document.querySelector('[data-status-field="state"]').hidden, false);
    assert.equal(document.querySelector('[data-status-field="error"]').hidden, true);
    assert.deepEqual(
      [...new Set(calls.tabMessages.filter((call) => call.type === 'status:get').map((call) => call.tabId))],
      [1],
    );
  });
});
