import { DIAGNOSTIC_MESSAGE_VERSION } from './catalog.js';
import { EVENT_INDEX, EVENT_STORE, SESSION_STORE, openLogDatabase } from './idb.js';
import { pruneExpiredLogs } from './prune.js';
import { normalizeEventForStorage } from './privacy.js';
import { sessionWithTabId, validateSession } from './session.js';
import { serializeError } from '../extension/bridge-contract.js';
import { aggregateCdnEvents } from './cdn.js';
import { emptyLiveFacts, foldLiveEvent } from '../extension/popup-live.js';

const BATCH_TYPE = 'diagnostic:events';
const READ_TYPES = new Set([
  'logs:max-event-id',
  'logs:sessions-page',
  'logs:events-page',
  'logs:session-events-page',
  'logs:cdn-summary',
  'logs:live-summary',
]);

function storageError(code, message, cause) {
  return Object.assign(new Error(message, { cause }), { code });
}

function stableValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(stableValue);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function withoutEventId(event) {
  const copy = { ...event };
  if (Object.prototype.hasOwnProperty.call(copy, 'eventId')) {
    throw storageError('EVENT_ID_FORBIDDEN', '页面不得自报 eventId');
  }
  return copy;
}

function comparableEvent(event) {
  const { eventId: _ignoredEventId, ...copy } = event;
  return copy;
}

function senderUrl(sender) {
  if (typeof sender?.url !== 'string' || sender.url.length === 0) {
    throw storageError('SENDER_URL_MISSING', '日志 sender URL 不可用');
  }
  return new URL(sender.url);
}

function assertSenderMatchesSession(session, sender) {
  const pageUrl = senderUrl(sender);
  if (pageUrl.origin !== session.origin) {
    throw storageError('SESSION_ROUTE_CONFLICT', 'sender URL 与 session origin 不一致');
  }
}

export function assertAppendSessionPolicy(existingSession, session, sender) {
  assertSenderMatchesSession(session, sender);
  if (existingSession !== undefined && stableStringify(existingSession) !== stableStringify(session)) {
    throw storageError('SESSION_CONFLICT', '相同 sessionId 的 session 身份不一致');
  }
}

function validateBatchMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw storageError('MESSAGE_INVALID', '日志消息必须是对象');
  }
  const keys = Object.keys(message).sort().join(',');
  if (keys !== 'events,session,type,version') {
    throw storageError('MESSAGE_INVALID', '日志消息字段未允许');
  }
  if (message.version !== DIAGNOSTIC_MESSAGE_VERSION || message.type !== BATCH_TYPE) {
    throw storageError('MESSAGE_INVALID', '日志消息版本或类型不支持');
  }
  if (!Array.isArray(message.events) || message.events.length === 0) {
    throw storageError('MESSAGE_INVALID', '日志批次不能为空');
  }
  return message;
}

async function appendBatch(message, sender, indexedDbObject) {
  validateBatchMessage(message);
  const pageSession = validateSession(message.session, { requireTabId: false });
  if (Object.prototype.hasOwnProperty.call(pageSession, 'tabId')) {
    throw storageError('TAB_ID_FORBIDDEN', 'content page 不得自报 tabId');
  }
  const session = sessionWithTabId(pageSession, sender?.tab?.id);
  const normalizedEvents = message.events.map((event) => {
    const normalized = normalizeEventForStorage(withoutEventId(event));
    if (normalized.sessionId !== session.sessionId) {
      throw storageError('SESSION_EVENT_CONFLICT', 'event sessionId 与批次不一致');
    }
    return normalized;
  });
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([SESSION_STORE, EVENT_STORE], 'readwrite');
    const sessions = transaction.objectStore(SESSION_STORE);
    const events = transaction.objectStore(EVENT_STORE);
    const sessionRequest = sessions.get(session.sessionId);
    const eventStatuses = [];
    let transactionFailure;
    let settled = false;
    const abortWith = (error) => {
      transactionFailure = error;
      if (!settled) transaction.abort();
    };
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(error);
    };
    const finishResolve = (value) => {
      if (settled) return;
      settled = true;
      database.close();
      resolve(value);
    };
    sessionRequest.onerror = () => {
      abortWith(storageError('IDB_SESSION_READ_FAILED', '读取日志 session 失败', sessionRequest.error));
    };
    sessionRequest.onsuccess = () => {
      try {
        const existingSession = sessionRequest.result;
        assertAppendSessionPolicy(existingSession, session, sender);
        if (existingSession === undefined) {
          sessions.add(session);
        }
        const index = events.index(EVENT_INDEX);
        const maxRequest = index.openCursor(
          IDBKeyRange.bound([session.sessionId, 0], [session.sessionId, Number.MAX_SAFE_INTEGER]),
          'prev',
        );
        maxRequest.onerror = () => abortWith(storageError('IDB_EVENT_READ_FAILED', '读取日志 sequence 失败', maxRequest.error));
        maxRequest.onsuccess = () => {
          const existingMax = maxRequest.result?.value?.sequence || 0;
          let expectedNext = existingMax + 1;
          const processEvent = (eventIndex) => {
            if (eventIndex >= normalizedEvents.length) return;
            const event = normalizedEvents[eventIndex];
            const request = index.get([event.sessionId, event.sequence]);
            request.onerror = () => abortWith(storageError('IDB_EVENT_READ_FAILED', '读取日志 event 失败', request.error));
            request.onsuccess = () => {
              try {
                const existing = request.result;
                if (existing !== undefined) {
                  if (stableStringify(comparableEvent(existing)) !== stableStringify(event)) {
                    throw storageError('SEQUENCE_CONFLICT', `sequence ${event.sequence} 内容冲突`);
                  }
                  eventStatuses.push({ sequence: event.sequence, status: 'DUPLICATE' });
                  processEvent(eventIndex + 1);
                  return;
                }
                if (event.sequence !== expectedNext) {
                  throw storageError('SEQUENCE_CONFLICT', `sequence ${event.sequence} 不连续，期望 ${expectedNext}`);
                }
                const addRequest = events.add(event);
                addRequest.onerror = () => abortWith(storageError('IDB_EVENT_WRITE_FAILED', '写入日志 event 失败', addRequest.error));
                addRequest.onsuccess = () => {
                  eventStatuses.push({ sequence: event.sequence, status: 'PERSISTED' });
                  expectedNext += 1;
                  processEvent(eventIndex + 1);
                };
              } catch (error) {
                abortWith(error);
              }
            };
          };
          processEvent(0);
        };
      } catch (error) {
        abortWith(error);
      }
    };
    transaction.oncomplete = () => {
      const hasNew = eventStatuses.some((status) => status.status === 'PERSISTED');
      finishResolve({
        status: hasNew ? 'PERSISTED' : 'DUPLICATE',
        statuses: eventStatuses,
        eventCount: normalizedEvents.length,
      });
    };
    transaction.onabort = () => {
      finishReject(transactionFailure || storageError('IDB_TRANSACTION_FAILED', '日志事务未提交', transaction.error));
    };
    transaction.onerror = () => {
      transactionFailure = transaction.error || storageError('IDB_TRANSACTION_FAILED', '日志事务失败');
    };
  });
}

function validateReadMessage(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    throw storageError('MESSAGE_INVALID', '日志读取消息必须是对象');
  }
  if (message.version !== DIAGNOSTIC_MESSAGE_VERSION || !READ_TYPES.has(message.type)) {
    throw storageError('MESSAGE_INVALID', '日志读取消息版本或类型不支持');
  }
  const allowed = {
    'logs:max-event-id': ['type', 'version', 'sessionId'],
    'logs:sessions-page': ['type', 'version', 'limit', 'afterSessionId', 'maxEventId', 'sessionId'],
    'logs:events-page': ['type', 'version', 'limit', 'afterEventId', 'maxEventId', 'sessionId'],
    'logs:session-events-page': ['type', 'version', 'limit', 'afterSequence', 'maxEventId', 'sessionId'],
    'logs:cdn-summary': ['type', 'version', 'sessionId'],
    'logs:live-summary': ['type', 'version', 'sessionId'],
  }[message.type];
  if (Object.keys(message).some((field) => !allowed.includes(field))) {
    throw storageError('MESSAGE_INVALID', '日志读取消息包含未允许字段');
  }
  for (const field of ['sessionId', 'afterSessionId']) {
    if (message[field] !== undefined && (typeof message[field] !== 'string' || message[field].length === 0)) {
      throw storageError('MESSAGE_INVALID', `${field} 无效`);
    }
  }
  if ((message.type === 'logs:cdn-summary' || message.type === 'logs:live-summary')
    && (typeof message.sessionId !== 'string' || message.sessionId.length === 0)) {
    throw storageError('MESSAGE_INVALID', 'sessionId 无效');
  }
  if (message.type === 'logs:session-events-page') {
    if (typeof message.sessionId !== 'string' || message.sessionId.length === 0) {
      throw storageError('MESSAGE_INVALID', 'sessionId 无效');
    }
    if (!Number.isInteger(message.afterSequence) || message.afterSequence < 0) {
      throw storageError('AFTER_SEQUENCE_INVALID', 'afterSequence 无效');
    }
  }
  return message;
}

function positiveLimit(value) {
  if (!Number.isInteger(value) || value <= 0 || value > 250) {
    throw storageError('READ_LIMIT_INVALID', '日志分页 limit 必须是 1 到 250');
  }
  return value;
}

function validMaxEventId(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw storageError('MAX_EVENT_ID_INVALID', 'maxEventId 无效');
  }
  return value;
}

async function readMaxEventId(message, indexedDbObject) {
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, 'readonly');
    const store = transaction.objectStore(EVENT_STORE);
    const request = store.openCursor(null, 'prev');
    request.onerror = () => reject(request.error || new Error('读取最大 eventId 失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve({ maxEventId: 0 });
        return;
      }
      if (message.sessionId === undefined || cursor.value.sessionId === message.sessionId) {
        resolve({ maxEventId: cursor.key });
        return;
      }
      cursor.continue();
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error('读取最大 eventId 事务失败'));
  });
}

async function readSessionsPage(message, indexedDbObject) {
  const limit = positiveLimit(message.limit);
  const maxEventId = message.maxEventId === undefined ? undefined : validMaxEventId(message.maxEventId);
  const after = message.afterSessionId === undefined ? undefined : String(message.afterSessionId);
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(
      maxEventId === undefined ? SESSION_STORE : [SESSION_STORE, EVENT_STORE],
      'readonly',
    );
    const store = transaction.objectStore(SESSION_STORE);
    const eventIndex = maxEventId === undefined
      ? undefined
      : transaction.objectStore(EVENT_STORE).index(EVENT_INDEX);
    const request = message.sessionId !== undefined
      ? store.get(message.sessionId)
      : store.openCursor(after === undefined ? null : IDBKeyRange.lowerBound(after, true));
    const sessions = [];
    let lastScannedSessionId = after;
    let scanned = 0;

    const includeIfWithinSnapshot = (session, done) => {
      if (eventIndex === undefined) {
        sessions.push(session);
        done();
        return;
      }
      const firstEventRequest = eventIndex.get([session.sessionId, 1]);
      firstEventRequest.onerror = () => {
        reject(firstEventRequest.error || new Error('读取 session 首条 event 失败'));
      };
      firstEventRequest.onsuccess = () => {
        if (isSessionWithinEventCutoff(firstEventRequest.result, maxEventId)) sessions.push(session);
        done();
      };
    };

    request.onerror = () => reject(request.error || new Error('读取 session 分页失败'));
    request.onsuccess = () => {
      if (message.sessionId !== undefined) {
        if (request.result === undefined) {
          resolve({ sessions, hasMore: false });
          return;
        }
        includeIfWithinSnapshot(request.result, () => resolve({ sessions, hasMore: false }));
        return;
      }
      const cursor = request.result;
      if (cursor === null) {
        resolve({ sessions, hasMore: false, nextAfterSessionId: lastScannedSessionId });
        return;
      }
      if (scanned >= limit) {
        resolve({ sessions, hasMore: true, nextAfterSessionId: lastScannedSessionId });
        return;
      }
      scanned += 1;
      lastScannedSessionId = String(cursor.key);
      includeIfWithinSnapshot(cursor.value, () => cursor.continue());
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error('读取 session 分页事务失败'));
  });
}

export function isSessionWithinEventCutoff(firstEvent, maxEventId) {
  return firstEvent?.sequence === 1
    && Number.isInteger(firstEvent.eventId)
    && firstEvent.eventId > 0
    && firstEvent.eventId <= maxEventId;
}

async function readEventsPage(message, indexedDbObject) {
  const limit = positiveLimit(message.limit);
  const maxEventId = validMaxEventId(message.maxEventId);
  if (!Number.isInteger(message.afterEventId) || message.afterEventId < 0) {
    throw storageError('AFTER_EVENT_ID_INVALID', 'afterEventId 无效');
  }
  if (maxEventId <= message.afterEventId) {
    return { events: [], hasMore: false, nextAfterEventId: message.afterEventId };
  }
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, 'readonly');
    const range = IDBKeyRange.bound(message.afterEventId + 1, maxEventId);
    const request = transaction.objectStore(EVENT_STORE).openCursor(range);
    const events = [];
    let lastScannedEventId = message.afterEventId;
    request.onerror = () => reject(request.error || new Error('读取 event 分页失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null || events.length >= limit) {
        resolve({ events, hasMore: cursor !== null, nextAfterEventId: lastScannedEventId });
        return;
      }
      lastScannedEventId = cursor.key;
      if (message.sessionId === undefined || cursor.value.sessionId === message.sessionId) {
        events.push(cursor.value);
      }
      if (events.length >= limit) {
        resolve({ events, hasMore: true, nextAfterEventId: lastScannedEventId });
        return;
      }
      cursor.continue();
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error('读取 event 分页事务失败'));
  });
}

async function readCdnSummary(message, indexedDbObject) {
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, 'readonly');
    const index = transaction.objectStore(EVENT_STORE).index(EVENT_INDEX);
    const request = index.openCursor(
      IDBKeyRange.bound([message.sessionId, 0], [message.sessionId, Number.MAX_SAFE_INTEGER]),
    );
    const events = [];
    let maxEventId = 0;
    request.onerror = () => reject(request.error || new Error('读取 CDN summary 事件失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        const summary = aggregateCdnEvents(events);
        resolve({ maxEventId, sampleCount: events.length, summary });
        return;
      }
      const event = cursor.value;
      const eventId = cursor.primaryKey ?? event.eventId;
      if (Number.isInteger(eventId) && eventId > maxEventId) maxEventId = eventId;
      if (event.code === 'bank.fetch.chunk') events.push(event);
      cursor.continue();
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error('读取 CDN summary 事务失败'));
  });
}

// 单个 session 的事件分页走 [sessionId, sequence] 索引：代价只随该 session 自身的
// 事件数增长，与库里其他 session 的记录量无关（logs:events-page 按全局 eventId 扫
// 全库，只为过滤出单个 session 时会把别的 session 的记录也反复反序列化）。
// 同一 session 内 sequence 与 eventId 同随写入递增，因此快照截断沿用 eventId 比较；
// 日志清理删掉的记录由游标自然跳过，快照之外的新增记录不进入本次读取。
async function readSessionEventsPage(message, indexedDbObject) {
  const limit = positiveLimit(message.limit);
  const maxEventId = validMaxEventId(message.maxEventId);
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, 'readonly');
    const index = transaction.objectStore(EVENT_STORE).index(EVENT_INDEX);
    const request = index.openCursor(
      IDBKeyRange.bound([message.sessionId, message.afterSequence + 1], [message.sessionId, Number.MAX_SAFE_INTEGER]),
    );
    const events = [];
    let nextAfterSequence = message.afterSequence;
    request.onerror = () => reject(request.error || new Error('读取 session 事件分页失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve({ events, hasMore: false, nextAfterSequence });
        return;
      }
      const event = cursor.value;
      const eventId = cursor.primaryKey ?? event.eventId;
      if (Number.isInteger(eventId) && eventId > maxEventId) {
        // 同 session 内 eventId 随 sequence 递增，越过快照后不再有范围内的记录。
        resolve({ events, hasMore: false, nextAfterSequence });
        return;
      }
      events.push(event);
      nextAfterSequence = event.sequence;
      if (events.length >= limit) {
        resolve({ events, hasMore: true, nextAfterSequence });
        return;
      }
      cursor.continue();
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error('读取 session 事件分页事务失败'));
  });
}

// 直播接管状态摘要：与 logs:cdn-summary 同形，按 [sessionId, sequence] 索引只读该
// session 自己的事件并折叠出 popup 直播卡需要的只读事实，避免按全局 eventId 全库
// 扫描（大库上那会让直播状态长时间停在「等待直播数据」）。
async function readLiveSummary(message, indexedDbObject) {
  const database = await openLogDatabase(indexedDbObject);
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(EVENT_STORE, 'readonly');
    const index = transaction.objectStore(EVENT_STORE).index(EVENT_INDEX);
    const request = index.openCursor(
      IDBKeyRange.bound([message.sessionId, 0], [message.sessionId, Number.MAX_SAFE_INTEGER]),
    );
    const facts = emptyLiveFacts();
    let maxEventId = 0;
    let sampleCount = 0;
    request.onerror = () => reject(request.error || new Error('读取直播状态事件失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve({ maxEventId, sampleCount, facts });
        return;
      }
      const event = cursor.value;
      const eventId = cursor.primaryKey ?? event.eventId;
      if (Number.isInteger(eventId) && eventId > maxEventId) maxEventId = eventId;
      if (event.code === 'bank.serve' || event.code === 'live.stream.stitch' || event.code === 'live.flv.backup') {
        sampleCount += 1;
        foldLiveEvent(facts, event);
      }
      cursor.continue();
    };
    transaction.oncomplete = () => database.close();
    transaction.onerror = () => reject(transaction.error || new Error('读取直播状态事务失败'));
  });
}

async function readLogs(message, indexedDbObject) {
  validateReadMessage(message);
  if (message.type === 'logs:max-event-id') return readMaxEventId(message, indexedDbObject);
  if (message.type === 'logs:sessions-page') return readSessionsPage(message, indexedDbObject);
  if (message.type === 'logs:cdn-summary') return readCdnSummary(message, indexedDbObject);
  if (message.type === 'logs:live-summary') return readLiveSummary(message, indexedDbObject);
  if (message.type === 'logs:session-events-page') return readSessionEventsPage(message, indexedDbObject);
  return readEventsPage(message, indexedDbObject);
}

// 日志只保留最近 3 天：批次写入成功后与 service worker 启动时各触发一次检查；
// pruneExpiredLogs 内部用 chrome.storage.session 节流，至多每小时真正清理一次，
// 且绝不阻塞本条消息的应答。失败走 console.error 全量上报，不吞掉。
function schedulePrune() {
  const throttleStore = globalThis.chrome?.storage?.session;
  // 模块也会在单测环境导入：那里没有 chrome.storage.session，也就没有要清理的库。
  if (throttleStore === undefined) return;
  void pruneExpiredLogs({ throttleStore }).catch((error) => {
    console.error('[BilibiliBuffer] 日志清理失败', error);
  });
}

async function handleMessage(message, sender, indexedDbObject = globalThis.indexedDB) {
  if (message?.type === BATCH_TYPE) {
    try {
      const result = await appendBatch(message, sender, indexedDbObject);
      if (result.status === 'PERSISTED') schedulePrune();
      return result;
    } catch (error) {
      const status = ['SESSION_CONFLICT', 'SEQUENCE_CONFLICT', 'SESSION_EVENT_CONFLICT'].includes(error?.code)
        ? error.code
        : 'DEGRADED';
      return { status, error: serializeError(error), eventCount: message.events?.length || 0 };
    }
  }
  if (READ_TYPES.has(message?.type)) {
    return readLogs(message, indexedDbObject);
  }
  throw storageError('MESSAGE_OPERATION_DENIED', '日志消息操作未允许');
}

export { appendBatch, handleMessage, readLogs };

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage?.addListener) {
  schedulePrune();
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message?.namespace === 'string' && message.namespace.startsWith('bilibili-buffer:segment-bank-')) {
      return false;
    }
    void handleMessage(message, sender)
      .then((response) => sendResponse({ version: DIAGNOSTIC_MESSAGE_VERSION, ok: true, ...response }))
      .catch((error) => sendResponse({
        version: DIAGNOSTIC_MESSAGE_VERSION,
        ok: false,
        error: serializeError(error),
      }));
    return true;
  });
}
