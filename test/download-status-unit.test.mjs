import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LINE_ACTIVITY_WINDOW_MS,
  SPEED_WINDOW_MS,
  deriveDownloadStatus,
} from '../src/diagnostics/download-status.js';

const MB = 1_048_576;
const AKAM = 'upos-hz-mirrorakam.akamaized.net';
const COS = 'upos-sz-mirrorcosov.bilivideo.com';
const VIDEO_PATH = '/video/track.m4s';
const NOW = 1_000_000;

function chunkEvent({
  at,
  mirror,
  path = VIDEO_PATH,
  chunkIndex = 0,
  start,
  end,
  bytes = MB,
  durationMs = 500,
  slot = 0,
  result = 'fetched',
}) {
  const rangeStart = start ?? chunkIndex * MB;
  return {
    code: 'bank.fetch.chunk',
    wallTime: new Date(at).toISOString(),
    data: {
      source: `https://${mirror}${path}`,
      mirror,
      chunkIndex,
      start: rangeStart,
      end: end ?? rangeStart + MB - 1,
      bytes,
      durationMs,
      slot,
      result,
    },
  };
}

function inventoryEvent({ inflight, queued, resources }) {
  return { code: 'bank.inventory', data: { inflight, queued, resources } };
}

function resourceEntry({ pathname, kind = 'video', totalSize, contiguousEnd, outstanding = 0 }) {
  const resource = {
    pathname,
    kind,
    active: true,
    totalSize,
    outstanding,
  };
  if (contiguousEnd !== undefined) resource.contiguousEnd = contiguousEnd;
  return resource;
}

test('a record spreads its bytes evenly over its own duration', () => {
  // 10 秒里收到 1,000,000 字节、结束时刻恰好在查询点：一半落在最近 5 秒窗口里，
  // 500,000 × 8 ÷ 5 = 800,000 bps。
  const status = deriveDownloadStatus({
    chunkEvents: [chunkEvent({ at: NOW, durationMs: 10_000, bytes: 1_000_000 })],
    latestInventory: undefined,
    nowMs: NOW,
  });
  assert.equal(status.lines.length, 1);
  assert.equal(status.lines[0].bitsPerSecond, 800_000);
  assert.equal(status.totalBitsPerSecond, 800_000);
  assert.equal(status.anyLineBytesInWindow, true);
});

test('a leg that lost the race still counts the bytes it received, without counting as fetched', () => {
  const status = deriveDownloadStatus({
    chunkEvents: [
      chunkEvent({ at: NOW - 1000, mirror: AKAM, bytes: MB, result: 'fetched' }),
      chunkEvent({ at: NOW - 1000, mirror: COS, bytes: 200_000, durationMs: 1000, result: 'lost_race' }),
    ],
    latestInventory: undefined,
    nowMs: NOW,
  });
  const [akam, cos] = status.lines;
  assert.equal(akam.mirror, AKAM);
  assert.equal(akam.fetchedEndsInWindow, true);
  assert.equal(cos.mirror, COS);
  assert.equal(cos.bitsPerSecond, 320_000);
  assert.equal(cos.receivedInWindow, true);
  assert.equal(cos.fetchedEndsInWindow, false);
  assert.equal(status.totalBitsPerSecond, akam.bitsPerSecond + cos.bitsPerSecond);
});

test('the speed window and the activity window are measured separately', () => {
  const status = deriveDownloadStatus({
    chunkEvents: [
      chunkEvent({ at: NOW - SPEED_WINDOW_MS - 1, mirror: AKAM, bytes: MB }),
      chunkEvent({ at: NOW - LINE_ACTIVITY_WINDOW_MS - 1, mirror: COS, bytes: MB, result: 'http_error' }),
    ],
    latestInventory: undefined,
    nowMs: NOW,
  });
  const [akam, cos] = status.lines;
  // 5 秒速度窗口外、15 秒活动窗口内：不算收数，但还算这条线路最近的活动。
  assert.equal(akam.bitsPerSecond, 0);
  assert.equal(akam.receivedInWindow, false);
  assert.equal(akam.fetchedEndsInWindow, false);
  assert.equal(akam.seenInActivityWindow, true);
  assert.equal(akam.lastResultInWindow, 'fetched');
  // 15 秒活动窗口外：两个窗口都不沾边。
  assert.equal(cos.seenInActivityWindow, false);
  assert.equal(cos.lastResultInWindow, undefined);
  assert.equal(status.hasRecords, true);
  assert.equal(status.anyLineBytesInWindow, false);
});

test('the last record inside the activity window wins, including same-millisecond ties', () => {
  const status = deriveDownloadStatus({
    chunkEvents: [
      chunkEvent({ at: NOW - 2000, mirror: AKAM, result: 'lost_race', bytes: 0 }),
      chunkEvent({ at: NOW - 2000, mirror: AKAM, result: 'invalid_response', bytes: 0 }),
      chunkEvent({ at: NOW - 20_000, mirror: AKAM, result: 'stalled' }),
    ],
    latestInventory: undefined,
    nowMs: NOW,
  });
  assert.equal(status.lines[0].lastResultInWindow, 'invalid_response');
});

test('records that end in the future are ignored', () => {
  const status = deriveDownloadStatus({
    chunkEvents: [chunkEvent({ at: NOW + 60_000, mirror: AKAM })],
    latestInventory: undefined,
    nowMs: NOW,
  });
  assert.equal(status.hasRecords, true);
  assert.equal(status.lines.length, 0);
});

test('the latest inventory snapshot is folded in with per-resource failed rounds', () => {
  const events = [
    chunkEvent({ at: NOW - 4_000, mirror: AKAM, chunkIndex: 3, bytes: 818_559, result: 'invalid_response' }),
    chunkEvent({ at: NOW - 3_000, mirror: COS, chunkIndex: 3, bytes: 0, durationMs: 10_000, result: 'stalled' }),
    chunkEvent({ at: NOW - 2_000, mirror: AKAM, chunkIndex: 3, bytes: 818_559, result: 'invalid_response' }),
    chunkEvent({ at: NOW - 1_000, mirror: COS, chunkIndex: 3, bytes: 0, durationMs: 10_000, result: 'stalled' }),
  ];
  const status = deriveDownloadStatus({
    chunkEvents: events,
    latestInventory: inventoryEvent({
      inflight: 2,
      queued: 20,
      resources: [resourceEntry({ pathname: VIDEO_PATH, totalSize: 55_105_041, contiguousEnd: 3 * MB, outstanding: 1 })],
    }),
    nowMs: NOW,
  });
  assert.equal(status.inventory.inflight, 2);
  assert.equal(status.inventory.queued, 20);
  assert.equal(status.inventory.resources[0].contiguousEnd, 3 * MB);
  assert.equal(status.inventory.resources[0].failedRounds, 2);
});

test('a fetched record on the missing chunk resets the rounds counted after it', () => {
  const events = [
    chunkEvent({ at: NOW - 9_000, mirror: AKAM, chunkIndex: 3, result: 'invalid_response' }),
    chunkEvent({ at: NOW - 8_000, mirror: AKAM, chunkIndex: 3, result: 'invalid_response' }),
    chunkEvent({ at: NOW - 7_000, mirror: COS, chunkIndex: 3, result: 'stalled' }),
    chunkEvent({ at: NOW - 6_000, mirror: AKAM, chunkIndex: 3, result: 'fetched' }),
    chunkEvent({ at: NOW - 5_000, mirror: COS, chunkIndex: 3, result: 'network_error' }),
  ];
  const status = deriveDownloadStatus({
    chunkEvents: events,
    latestInventory: inventoryEvent({
      inflight: 1,
      queued: 3,
      resources: [resourceEntry({ pathname: VIDEO_PATH, totalSize: 55_105_041, contiguousEnd: 3 * MB })],
    }),
    nowMs: NOW,
  });
  // 取到之后的失败只有 cos 的一次：两条线路各数各的，取较大的那个。
  assert.equal(status.inventory.resources[0].failedRounds, 1);
});

test('a completed resource and a resource without contiguous end report zero rounds', () => {
  const events = [
    chunkEvent({ at: NOW - 1_000, mirror: AKAM, chunkIndex: 3, result: 'invalid_response' }),
  ];
  const status = deriveDownloadStatus({
    chunkEvents: events,
    latestInventory: inventoryEvent({
      inflight: 0,
      queued: 0,
      resources: [
        resourceEntry({ pathname: VIDEO_PATH, totalSize: 4 * MB, contiguousEnd: 4 * MB }),
        resourceEntry({ pathname: '/video/unknown-total.m4s', totalSize: '未提供' }),
      ],
    }),
    nowMs: NOW,
  });
  assert.equal(status.inventory.resources[0].failedRounds, 0);
  assert.equal(status.inventory.resources[1].failedRounds, 0);
});

test('with no inventory snapshot the inventory field stays absent', () => {
  const status = deriveDownloadStatus({
    chunkEvents: [chunkEvent({ at: NOW - 1_000, mirror: AKAM })],
    latestInventory: undefined,
    nowMs: NOW,
  });
  assert.equal(status.inventory, undefined);
});

function liveInventoryEvent({ at, data }) {
  return { code: 'live.inventory', wallTime: new Date(at).toISOString(), data };
}

test('the latest live inventory snapshot folds in with its age at read time and null ages kept', () => {
  const status = deriveDownloadStatus({
    chunkEvents: [],
    latestLiveInventory: liveInventoryEvent({
      at: NOW - 1_200,
      data: {
        streamPath: '/live-bvc/1/stream/',
        delivered: false,
        inflight: [{
          streamPath: '/live-bvc/1/stream/',
          ageMs: 4_000,
          legs: [{ slot: 0, mirror: COS, bytes: 0, lastByteAgeMs: null }],
        }],
        playlistResponseAgeMs: 900,
        playlistNewSegmentAgeMs: '未提供',
        flvFrameAgeMs: null,
      },
    }),
    nowMs: NOW,
  });
  assert.deepEqual(status.liveInventory, {
    wallTimeMs: NOW - 1_200,
    readAgeMs: 1_200,
    delivered: false,
    streamPath: '/live-bvc/1/stream/',
    inflight: [{
      streamPath: '/live-bvc/1/stream/',
      ageMs: 4_000,
      legs: [{ slot: 0, mirror: COS, bytes: 0, lastByteAgeMs: null }],
    }],
    playlistResponseAgeMs: 900,
    playlistNewSegmentAgeMs: null,
    flvFrameAgeMs: null,
  });
  const closing = deriveDownloadStatus({
    chunkEvents: [],
    latestLiveInventory: liveInventoryEvent({ at: NOW - 10, data: { streamPath: '/s/', delivered: true, inflight: [] } }),
    nowMs: NOW,
  });
  assert.equal(closing.liveInventory.delivered, true);
  assert.deepEqual(closing.liveInventory.inflight, []);
});

test('with no live inventory snapshot the field stays absent and a snapshot without a valid wallTime fails loudly', () => {
  assert.equal(deriveDownloadStatus({ chunkEvents: [], nowMs: NOW }).liveInventory, undefined);
  assert.throws(() => deriveDownloadStatus({
    chunkEvents: [],
    latestLiveInventory: { code: 'live.inventory', wallTime: 'not a time', data: { delivered: false, inflight: [] } },
    nowMs: NOW,
  }), /live\.inventory/);
});
