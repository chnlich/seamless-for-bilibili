import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { LOG_RETENTION } from '../src/constants.js';
import { pruneExpiredLogs } from '../src/diagnostics/prune.js';
import { writeEvents, writeSessions } from '../src/diagnostics/export.js';
import { appendBatch, handleMessage, readLogs } from '../src/diagnostics/worker.js';
import { FakeIDBKeyRange, FakeIndexedDB } from './fake-idb.mjs';

const originalKeyRange = globalThis.IDBKeyRange;
globalThis.IDBKeyRange = FakeIDBKeyRange;
after(() => {
  globalThis.IDBKeyRange = originalKeyRange;
});

function session(sessionId, pathname = '/100') {
  return {
    schemaVersion: 1,
    sessionId,
    startedAt: '2026-07-20T00:00:00.000Z',
    extensionVersion: '1.0.0',
    buildId: 'src-test',
    routeKind: 'video',
    origin: 'https://www.bilibili.com',
    pathname,
  };
}

function event(sessionId, sequence, code = 'route.session_started', data) {
  return {
    sessionId,
    sequence,
    wallTime: '2026-07-20T00:00:00.000Z',
    elapsedMs: sequence,
    code,
    ...(data === undefined ? {} : { data }),
  };
}

function message(identity, events) {
  return { type: 'diagnostic:events', version: 1, session: identity, events };
}

function sender(tabId, pathname = '/100') {
  return { tab: { id: tabId }, url: `https://www.bilibili.com${pathname}` };
}

async function readAllEvents(indexedDb, maxEventId) {
  return readLogs({
    type: 'logs:events-page',
    version: 1,
    limit: 250,
    afterEventId: 0,
    maxEventId,
  }, indexedDb);
}

test('append acknowledgement stays pending until the IndexedDB transaction commits', async () => {
  const indexedDb = new FakeIndexedDB();
  const identity = session('session-idb-commit');
  const releaseCommit = indexedDb.database.holdNextCommit();
  let settled = false;
  const pending = appendBatch(message(identity, [event(identity.sessionId, 1)]), sender(1), indexedDb)
    .then((result) => {
      settled = true;
      return result;
    });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(
    await readLogs({ type: 'logs:max-event-id', version: 1 }, indexedDb),
    { maxEventId: 0 },
  );

  releaseCommit();
  const persisted = await pending;
  assert.equal(persisted.status, 'PERSISTED');
  assert.deepEqual(
    await readLogs({ type: 'logs:max-event-id', version: 1 }, indexedDb),
    { maxEventId: 1 },
  );
});

test('realistic IDB transaction semantics preserve append-only isolation and restart-readable data', async () => {
  const indexedDb = new FakeIndexedDB();
  const firstSession = session('session-idb-first');
  const firstEvent = event(firstSession.sessionId, 1);
  const firstMessage = message(firstSession, [firstEvent]);
  const persisted = await appendBatch(firstMessage, sender(1), indexedDb);
  assert.equal(persisted.status, 'PERSISTED');
  assert.deepEqual(persisted.statuses, [{ sequence: 1, status: 'PERSISTED' }]);

  const duplicate = await appendBatch(firstMessage, sender(1), indexedDb);
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.deepEqual(duplicate.statuses, [{ sequence: 1, status: 'DUPLICATE' }]);

  const sameIdDifferentRoute = await handleMessage(
    message(session(firstSession.sessionId, '/different'), [event(firstSession.sessionId, 2)]),
    sender(1),
    indexedDb,
  );
  assert.equal(sameIdDifferentRoute.status, 'SESSION_CONFLICT');

  const conflictingBatch = message(firstSession, [
    event(firstSession.sessionId, 2, 'video.attached', { source: 'https://media.example/video' }),
    event(firstSession.sessionId, 4),
  ]);
  const conflict = await handleMessage(conflictingBatch, sender(1), indexedDb);
  assert.equal(conflict.status, 'SEQUENCE_CONFLICT');

  const maxEvent = await readLogs({ type: 'logs:max-event-id', version: 1 }, indexedDb);
  const firstEvents = await readAllEvents(indexedDb, maxEvent.maxEventId);
  assert.deepEqual(firstEvents.events.map(({ sequence }) => sequence), [1]);

  indexedDb.database.failNextEventAdd = true;
  const degraded = await handleMessage(
    message(firstSession, [event(firstSession.sessionId, 2)]),
    sender(1),
    indexedDb,
  );
  assert.equal(degraded.status, 'DEGRADED');
  const afterFailure = await readAllEvents(indexedDb, maxEvent.maxEventId + 1);
  assert.deepEqual(afterFailure.events.map(({ sequence }) => sequence), [1]);

  const concurrentSessions = Array.from({ length: 101 }, (_, index) => {
    const identity = session(`session-idb-${index}`, `/${index}`);
    return appendBatch(
      message(identity, [event(identity.sessionId, 1)]),
      sender(index + 10, `/${index}`),
      indexedDb,
    );
  });
  const concurrentResults = await Promise.all(concurrentSessions);
  assert.ok(concurrentResults.every((result) => result.status === 'PERSISTED'));

  const latestMaxEvent = await readLogs({ type: 'logs:max-event-id', version: 1 }, indexedDb);
  const sessionPage = await readLogs({
    type: 'logs:sessions-page',
    version: 1,
    limit: 250,
    maxEventId: latestMaxEvent.maxEventId,
  }, indexedDb);
  assert.equal(sessionPage.sessions.length, 102);
  assert.equal(sessionPage.hasMore, false);

  const restartedIndexedDb = indexedDb;
  const restartedEvents = await readAllEvents(restartedIndexedDb, latestMaxEvent.maxEventId);
  assert.equal(restartedEvents.events.length, 102);
  assert.equal(restartedEvents.events.some((stored) => stored.sessionId === firstSession.sessionId && stored.sequence === 2), false);
});

test('CDN summary scans one session through the composite index and reports an empty result', async () => {
  const indexedDb = new FakeIndexedDB();
  const first = session('session-cdn-first');
  const second = session('session-cdn-second', '/200');
  await appendBatch(message(first, [
    event(first.sessionId, 1),
    event(first.sessionId, 2, 'bank.fetch.chunk', {
      source: 'https://cdn-a.example/video/segment.m4s?signature=secret',
      mirror: 'cdn-a.example',
      chunkIndex: 0,
      start: 0,
      end: 15,
      bytes: 16,
      slot: 0,
      result: 'fetched',
    }),
  ]), sender(1), indexedDb);
  await appendBatch(message(second, [event(second.sessionId, 1)]), sender(2, '/200'), indexedDb);

  const summary = await readLogs({
    type: 'logs:cdn-summary',
    version: 1,
    sessionId: first.sessionId,
  }, indexedDb);
  assert.equal(summary.maxEventId, 2);
  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.summary.totalChunks, 1);
  assert.equal(summary.summary.byResult.fetched, 1);

  const empty = await readLogs({
    type: 'logs:cdn-summary',
    version: 1,
    sessionId: second.sessionId,
  }, indexedDb);
  assert.equal(empty.maxEventId, 3);
  assert.equal(empty.sampleCount, 0);
  assert.equal(empty.summary.totalChunks, 0);
  assert.deepEqual(empty.summary.byResult, {
    fetched: 0,
    lost_race: 0,
    stalled: 0,
    aborted: 0,
    superseded: 0,
    network_error: 0,
    http_error: 0,
    invalid_response: 0,
    gave_up: 0,
  });
});

function timedSession(sessionId, startedAtIso, pathname = '/100') {
  return {
    schemaVersion: 1,
    sessionId,
    startedAt: startedAtIso,
    extensionVersion: '1.0.0',
    buildId: 'src-test',
    routeKind: 'video',
    origin: 'https://www.bilibili.com',
    pathname,
  };
}

function timedEvent(sessionId, sequence, wallTimeIso, code = 'route.session_started') {
  return {
    sessionId,
    sequence,
    wallTime: wallTimeIso,
    elapsedMs: sequence,
    code,
  };
}

function throttleRecorder() {
  const store = new Map();
  return {
    writes: [],
    async get(key) {
      return store.has(key) ? { [key]: store.get(key) } : {};
    },
    async set(value) {
      for (const [key, item] of Object.entries(value)) {
        this.writes.push({ key, value: item });
        store.set(key, item);
      }
    },
  };
}

async function persistedBatch(indexedDb, identity, events, tabId = 1) {
  const result = await appendBatch(
    { type: 'diagnostic:events', version: 1, session: identity, events },
    { tab: { id: tabId }, url: `${identity.origin}${identity.pathname}` },
    indexedDb,
  );
  assert.equal(result.status, 'PERSISTED');
}

function storedEventIds(indexedDb) {
  return [...indexedDb.database.state.events.keys()].sort((left, right) => left - right);
}

test('pruning deletes expired events and finished sessions by their own time and keeps everything newer', async () => {
  const indexedDb = new FakeIndexedDB();
  const now = Date.parse('2026-07-23T00:00:00.000Z');
  const cutoffIso = new Date(now - LOG_RETENTION.retentionMs).toISOString();

  // session-old：全部事件过期，事件删完后 session 本身也删除。
  const oldIdentity = timedSession('session-old', '2026-07-19T00:00:00.000Z');
  await persistedBatch(indexedDb, oldIdentity, [
    timedEvent(oldIdentity.sessionId, 1, '2026-07-19T01:00:00.000Z'),
    timedEvent(oldIdentity.sessionId, 2, new Date(now - LOG_RETENTION.retentionMs - 1).toISOString()),
  ]);

  // session-long：早期事件过期，最近事件仍在；session 记录保留。
  const longIdentity = timedSession('session-long', '2026-07-19T00:00:00.000Z');
  await persistedBatch(indexedDb, longIdentity, [
    timedEvent(longIdentity.sessionId, 1, '2026-07-19T02:00:00.000Z'),
  ]);
  await persistedBatch(indexedDb, longIdentity, [
    timedEvent(longIdentity.sessionId, 2, '2026-07-22T23:00:00.000Z'),
  ]);

  // session-new：全在保留窗口内。
  const newIdentity = timedSession('session-new', '2026-07-22T12:00:00.000Z');
  await persistedBatch(indexedDb, newIdentity, [
    timedEvent(newIdentity.sessionId, 1, '2026-07-22T12:30:00.000Z'),
  ]);

  const throttle = throttleRecorder();
  const result = await pruneExpiredLogs({ indexedDbObject: indexedDb, throttleStore: throttle, now: new Date(now) });
  assert.deepEqual(result, { deletedEvents: 3, deletedSessions: 1 });

  // session-long 只剩最近事件（早期事件已过期删除），记录本身保留。
  const remaining = [...indexedDb.database.state.events.values()];
  assert.deepEqual(remaining.map((event) => event.sessionId).sort(), ['session-long', 'session-new']);
  assert.deepEqual(remaining.map((event) => event.sequence).sort((a, b) => a - b), [1, 2]);
  assert.deepEqual([...indexedDb.database.state.sessions.keys()].sort(), ['session-long', 'session-new']);
});

test('the 72-hour boundary is exact: exactly 72-hour-old records stay, one millisecond older goes', async () => {
  const indexedDb = new FakeIndexedDB();
  const now = Date.parse('2026-07-23T00:00:00.000Z');
  const cutoffIso = new Date(now - LOG_RETENTION.retentionMs).toISOString();
  const olderIso = new Date(now - LOG_RETENTION.retentionMs - 1).toISOString();

  const identity = timedSession('session-boundary', '2026-07-18T00:00:00.000Z');
  await persistedBatch(indexedDb, identity, [
    timedEvent(identity.sessionId, 1, olderIso),
    timedEvent(identity.sessionId, 2, cutoffIso),
  ]);

  const result = await pruneExpiredLogs({ indexedDbObject: indexedDb, throttleStore: throttleRecorder(), now: new Date(now) });
  assert.deepEqual(result, { deletedEvents: 1, deletedSessions: 0 });
  const remaining = [...indexedDb.database.state.events.values()];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].wallTime, cutoffIso);
  assert.deepEqual([...indexedDb.database.state.sessions.keys()], ['session-boundary']);
});

test('an expired event flushed behind a young one survives this pass and goes in a later pass', async () => {
  const indexedDb = new FakeIndexedDB();
  const firstPruneNow = Date.parse('2026-07-23T00:00:00.000Z');
  const identity = timedSession('session-late', '2026-07-19T00:00:00.000Z');
  // 写入顺序与自身时间相反：年轻事件先入库，过期事件晚写入。
  await persistedBatch(indexedDb, identity, [
    timedEvent(identity.sessionId, 1, '2026-07-22T23:00:00.000Z'),
    timedEvent(identity.sessionId, 2, '2026-07-19T01:00:00.000Z'),
  ]);

  const first = await pruneExpiredLogs({
    indexedDbObject: indexedDb,
    throttleStore: throttleRecorder(),
    now: new Date(firstPruneNow),
  });
  assert.equal(first.deletedEvents, 0, '走访停在第一条年轻事件，不误删也不越界');
  assert.equal(storedEventIds(indexedDb).length, 2);

  // 挡在前面的年轻事件过期后，后到的过期记录随后被清理，不会永久滞留。
  const second = await pruneExpiredLogs({
    indexedDbObject: indexedDb,
    throttleStore: throttleRecorder(),
    now: new Date(firstPruneNow + LOG_RETENTION.retentionMs),
  });
  assert.equal(second.deletedEvents, 2);
  assert.deepEqual(storedEventIds(indexedDb), []);
});

test('pruning scans in bounded transactions and still clears a large expired backlog', async () => {
  const indexedDb = new FakeIndexedDB();
  const now = Date.parse('2026-07-23T00:00:00.000Z');
  const identity = timedSession('session-backlog', '2026-07-18T00:00:00.000Z');
  const events = [];
  for (let sequence = 1; sequence <= 2050; sequence += 1) {
    events.push(timedEvent(identity.sessionId, sequence, '2026-07-19T03:00:00.000Z'));
  }
  await persistedBatch(indexedDb, identity, events);

  const result = await pruneExpiredLogs({ indexedDbObject: indexedDb, throttleStore: throttleRecorder(), now: new Date(now) });
  assert.equal(result.deletedEvents, 2050);
  assert.deepEqual(storedEventIds(indexedDb), []);
  assert.deepEqual([...indexedDb.database.state.sessions.keys()], [], '事件清空后 session 一并删除');
});

test('pruning is throttled to once per interval and the throttle timestamp is claimed before running', async () => {
  const indexedDb = new FakeIndexedDB();
  const now = Date.parse('2026-07-23T00:00:00.000Z');
  const identity = timedSession('session-throttle', '2026-07-22T00:00:00.000Z');
  await persistedBatch(indexedDb, identity, [
    timedEvent(identity.sessionId, 1, '2026-07-22T00:30:00.000Z'),
  ]);

  const throttle = throttleRecorder();
  const first = await pruneExpiredLogs({ indexedDbObject: indexedDb, throttleStore: throttle, now: new Date(now) });
  assert.deepEqual(first, { deletedEvents: 0, deletedSessions: 0 });

  const second = await pruneExpiredLogs({
    indexedDbObject: indexedDb,
    throttleStore: throttle,
    now: new Date(now + LOG_RETENTION.pruneIntervalMs - 1),
  });
  assert.deepEqual(second, { skipped: true });

  const third = await pruneExpiredLogs({
    indexedDbObject: indexedDb,
    throttleStore: throttle,
    now: new Date(now + LOG_RETENTION.pruneIntervalMs),
  });
  assert.deepEqual(third, { deletedEvents: 0, deletedSessions: 0 });
  assert.equal(throttle.writes.length, 2, '每次真正清理各认领一次时间戳');
});

test('records without a readable own time are kept, and prune failures surface instead of resolving', async () => {
  const indexedDb = new FakeIndexedDB();
  const now = Date.parse('2026-07-23T00:00:00.000Z');
  const identity = timedSession('session-unreadable', '2026-07-19T00:00:00.000Z');
  await persistedBatch(indexedDb, identity, [
    timedEvent(identity.sessionId, 1, 'not-a-timestamp'),
    timedEvent(identity.sessionId, 2, '2026-07-19T01:00:00.000Z'),
  ]);

  const result = await pruneExpiredLogs({ indexedDbObject: indexedDb, throttleStore: throttleRecorder(), now: new Date(now) });
  assert.equal(result.deletedEvents, 1, '时间可读且过期的删除，读不出时间的保留');
  const remaining = [...indexedDb.database.state.events.values()];
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].sequence, 1);

  await assert.rejects(
    pruneExpiredLogs({ indexedDbObject: indexedDb, throttleStore: undefined, now: new Date(now) }),
    /日志清理节流存储不可用/,
  );
});

test('an export already in progress keeps its snapshot range and tolerates rows pruned mid-export', async () => {
  const indexedDb = new FakeIndexedDB();
  const now = Date.parse('2026-07-23T00:00:00.000Z');
  const oldIdentity = timedSession('session-export-old', '2026-07-19T00:00:00.000Z');
  const newIdentity = timedSession('session-export-new', '2026-07-22T00:00:00.000Z');
  // 300 条旧事件占满两页；随后把 eventId 200 到 260 之间按时间过期处理。
  const events = [];
  for (let sequence = 1; sequence <= 300; sequence += 1) {
    // 1 到 260 过期且位于存储前部，清理会在分页之间删掉 251 到 260。
    const expired = sequence <= 260;
    events.push(timedEvent(
      oldIdentity.sessionId,
      sequence,
      expired ? '2026-07-19T01:00:00.000Z' : '2026-07-22T01:00:00.000Z',
    ));
  }
  await persistedBatch(indexedDb, oldIdentity, events);
  await persistedBatch(indexedDb, newIdentity, [
    timedEvent(newIdentity.sessionId, 1, '2026-07-22T01:30:00.000Z'),
  ]);

  const snapshot = await readLogs({ type: 'logs:max-event-id', version: 1 }, indexedDb);
  assert.equal(snapshot.maxEventId, 301);

  const lines = [];
  const writer = {
    async write(chunk) {
      for (const line of chunk.split('\n')) if (line !== '') lines.push(JSON.parse(line));
    },
  };
  const send = async (message) => readLogs({ version: 1, ...message }, indexedDb);

  // 第一页读完后触发清理：eventId 200 到 260 从库中消失。
  let pageReads = 0;
  const instrumentedSend = async (message) => {
    const response = await send(message);
    if (message.type === 'logs:events-page') {
      pageReads += 1;
      if (pageReads === 1) {
        await pruneExpiredLogs({ indexedDbObject: indexedDb, throttleStore: throttleRecorder(), now: new Date(now) });
      }
    }
    return response;
  };

  await writeSessions(instrumentedSend, writer, undefined, snapshot.maxEventId);
  await writeEvents(instrumentedSend, writer, undefined, snapshot.maxEventId);

  const exportedEventIds = lines
    .filter((line) => line.recordType === 'event')
    .map((line) => line.eventId);
  const expected = [
    ...Array.from({ length: 250 }, (_v, index) => index + 1),
    ...Array.from({ length: 40 }, (_v, index) => index + 261),
    301,
  ];
  assert.deepEqual(exportedEventIds, expected);
  const exportedSessions = lines
    .filter((line) => line.recordType === 'session')
    .map((line) => line.sessionId);
  assert.deepEqual(exportedSessions.sort(), ['session-export-new', 'session-export-old']);
  assert.equal(pageReads, 2, '被清空的范围内没有多余分页');
});

test('live summary folds a recent session takeover facts in a store holding many other sessions', async () => {
  const indexedDb = new FakeIndexedDB();
  // 先塞 30 个别的 session、每个 250 条事件，模拟真实大库：目标 session 的记录
  // 位于这些记录之后，摘要读取不得依赖对它们的扫描结果。
  for (let noiseIndex = 0; noiseIndex < 30; noiseIndex += 1) {
    const noise = session(`session-live-noise-${noiseIndex}`, `/noise-${noiseIndex}`);
    await appendBatch(
      message(noise, Array.from({ length: 250 }, (_v, index) => event(noise.sessionId, index + 1))),
      sender(100 + noiseIndex, `/noise-${noiseIndex}`),
      indexedDb,
    );
  }
  const target = session('session-live-target', '/live');
  await appendBatch(message(target, [
    event(target.sessionId, 1),
    event(target.sessionId, 2, 'bank.serve', {
      source: 'https://d1--ov-gotcha207.bilivideo.com/live-bvc/1/x.m4s',
      mirror: 'd1--ov-gotcha207.bilivideo.com',
      result: 'hit',
      reason: 'live_hls_segment',
      pairedAddressAvailable: true,
    }),
    event(target.sessionId, 3, 'bank.serve', {
      source: 'https://d1--ov-gotcha207.bilivideo.com/live-bvc/1/index.m3u8',
      mirror: 'd1--ov-gotcha207.bilivideo.com',
      result: 'pass',
      reason: 'live_hls_playlist',
    }),
    event(target.sessionId, 4, 'live.stream.stitch', {
      streamPath: '/live-bvc/1/x.m4s',
      bytesChecked: 4,
      mismatch: true,
      phase: 'segment',
    }),
    event(target.sessionId, 5, 'bank.serve', {
      source: 'https://d1--ov-gotcha207.bilivideo.com/live-bvc/1/x.m4s',
      mirror: 'd1--ov-gotcha207.bilivideo.com',
      result: 'failed',
      reason: 'live_hls_segment_failed',
      errorName: 'BankNetworkError',
    }),
    event(target.sessionId, 6, 'bank.serve', {
      source: 'https://d1--ov-gotcha207.bilivideo.com/live-bvc/1/x.m4s',
      mirror: 'd1--ov-gotcha207.bilivideo.com',
      result: 'hit',
      reason: 'live_hls_segment',
      pairedAddressAvailable: true,
    }),
    event(target.sessionId, 7, 'live.stream.stitch', {
      streamPath: '/live-bvc/1/x.m4s',
      bytesChecked: 8,
      mismatch: true,
      phase: 'stream',
    }),
    event(target.sessionId, 8, 'live.flv.backup', {
      state: 'calibrated',
      streamPath: '/live-bvc/1/x.flv',
      mirror: 'd1--cn-gotcha04.bilivideo.com',
    }),
  ]), sender(200, '/live'), indexedDb);

  const summary = await readLogs({
    type: 'logs:live-summary',
    version: 1,
    sessionId: target.sessionId,
  }, indexedDb);
  assert.deepEqual(summary.facts, {
    serveCount: 4,
    engagement: 'engaged',
    pairedAddressAvailable: true,
    pairRejected: true,
    flvBackup: 'calibrated',
  });
  assert.equal(summary.sampleCount, 7, 'sampleCount 只统计 bank.serve、live.stream.stitch 与 live.flv.backup');
  assert.equal(Number.isInteger(summary.maxEventId) && summary.maxEventId > 0, true);

  // 空 session 返回零值事实，不抛错。
  const quiet = session('session-live-quiet', '/quiet');
  await appendBatch(message(quiet, [event(quiet.sessionId, 1)]), sender(201, '/quiet'), indexedDb);
  const empty = await readLogs({
    type: 'logs:live-summary',
    version: 1,
    sessionId: quiet.sessionId,
  }, indexedDb);
  assert.deepEqual(empty.facts, {
    serveCount: 0,
    engagement: undefined,
    pairedAddressAvailable: false,
    pairRejected: false,
    flvBackup: undefined,
  });
  assert.equal(empty.sampleCount, 0);
});

test('live summary rejects a message without a sessionId', async () => {
  const indexedDb = new FakeIndexedDB();
  await assert.rejects(
    readLogs({ type: 'logs:live-summary', version: 1 }, indexedDb),
    /sessionId 无效/,
  );
});

test('session events page reads one session through the index with snapshot cutoff and deletion tolerance', async () => {
  const indexedDb = new FakeIndexedDB();
  const older = session('session-page-older', '/older');
  await appendBatch(
    message(older, Array.from({ length: 300 }, (_v, index) => event(older.sessionId, index + 1))),
    sender(1, '/older'),
    indexedDb,
  );
  const target = session('session-page-target', '/target');
  await appendBatch(
    message(target, Array.from({ length: 40 }, (_v, index) => event(target.sessionId, index + 1, 'media.sample', {
      eventType: 'progress',
      currentTime: index,
    }))),
    sender(2, '/target'),
    indexedDb,
  );

  const snapshot = await readLogs({ type: 'logs:max-event-id', version: 1 }, indexedDb);
  // 快照固定在目标 session 第 20 条之后：先查它的 eventId。
  const targetEvents = await readLogs({
    type: 'logs:session-events-page',
    version: 1,
    limit: 250,
    afterSequence: 0,
    maxEventId: snapshot.maxEventId,
    sessionId: target.sessionId,
  }, indexedDb);
  const cutoffEventId = targetEvents.events[19].eventId;

  // 分页只返回该 session 自己的事件，按 sequence 顺序，别的 session 不混入。
  const collected = [];
  let afterSequence = 0;
  for (;;) {
    const page = await readLogs({
      type: 'logs:session-events-page',
      version: 1,
      limit: 7,
      afterSequence,
      maxEventId: snapshot.maxEventId,
      sessionId: target.sessionId,
    }, indexedDb);
    collected.push(...page.events);
    if (!page.hasMore) break;
    assert.equal(Number.isInteger(page.nextAfterSequence) && page.nextAfterSequence > afterSequence, true);
    afterSequence = page.nextAfterSequence;
  }
  assert.equal(collected.length, 40);
  assert.deepEqual(collected.map((stored) => stored.sequence), Array.from({ length: 40 }, (_v, index) => index + 1));
  assert.equal(collected.every((stored) => stored.sessionId === target.sessionId), true);

  // 快照截断：maxEventId 固定在第 20 条时，只返回前 20 条。
  const cutoffPage = await readLogs({
    type: 'logs:session-events-page',
    version: 1,
    limit: 250,
    afterSequence: 0,
    maxEventId: cutoffEventId,
    sessionId: target.sessionId,
  }, indexedDb);
  assert.deepEqual(cutoffPage.events.map((stored) => stored.sequence), Array.from({ length: 20 }, (_v, index) => index + 1));
  assert.equal(cutoffPage.hasMore, false);

  // 日志清理删除范围内的记录时分页原样跳过（走 fake IDB 的底层连接）。
  const doomed = collected.filter((stored) => stored.sequence === 5 || stored.sequence === 6);
  await new Promise((resolve, reject) => {
    const transaction = indexedDb.database.transaction('events', 'readwrite');
    const store = transaction.objectStore('events');
    for (const stored of doomed) store.delete(stored.eventId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });

  const afterDelete = [];
  afterSequence = 0;
  for (;;) {
    const page = await readLogs({
      type: 'logs:session-events-page',
      version: 1,
      limit: 7,
      afterSequence,
      maxEventId: snapshot.maxEventId,
      sessionId: target.sessionId,
    }, indexedDb);
    afterDelete.push(...page.events);
    if (!page.hasMore) break;
    afterSequence = page.nextAfterSequence;
  }
  assert.deepEqual(
    afterDelete.map((stored) => stored.sequence),
    Array.from({ length: 40 }, (_v, index) => index + 1).filter((sequence) => sequence !== 5 && sequence !== 6),
  );
});

test('session events page rejects missing sessionId or invalid afterSequence', async () => {
  const indexedDb = new FakeIndexedDB();
  await assert.rejects(
    readLogs({
      type: 'logs:session-events-page', version: 1, limit: 10, afterSequence: 0, maxEventId: 5,
    }, indexedDb),
    /sessionId 无效/,
  );
  await assert.rejects(
    readLogs({
      type: 'logs:session-events-page', version: 1, limit: 10, afterSequence: -1, maxEventId: 5, sessionId: 's',
    }, indexedDb),
    /afterSequence 无效/,
  );
});
