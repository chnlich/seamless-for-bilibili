import { LOG_RETENTION } from '../constants.js';
import { EVENT_INDEX, EVENT_STORE, SESSION_STORE, openLogDatabase } from './idb.js';

// 一次 readwrite 事务最多走访这么多条 event，然后提交换下一个事务：
// 清理永远不长时间占住 events 存储，页面日志批次照常写入。
const PRUNE_CHUNK_RECORDS = 2000;
const SESSION_KEY_CEILING = Number.MAX_SAFE_INTEGER;

function parseTimeMs(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

// 只按记录自身的时间判断过期：wallTime 或 startedAt 缺失、读不出时间的记录一律保留。
function expired(timeMs, cutoffMs) {
  return timeMs !== undefined && timeMs < cutoffMs;
}

// event 按 eventId（写入顺序）升序走访，逐条核对自身 wallTime，不按条数或容量删除。
// 事件几乎总是按自身时间先后写入（页面 flush 只延迟数毫秒），所以遇到第一条读得出
// 时间且未过期的 event 即结束本轮：本轮绝不删除任何未过期记录；被晚写入冲到前面
// 的过期记录留给下一轮，至多等它前面的年轻记录过期后再删。读不出时间的记录跳过
// 不删（无法证明过期），也不让它们堵住后面的走访。
function pruneChunk(database, cutoffMs) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([EVENT_STORE], 'readwrite');
    // walkOver：走访结束。complete 表示本轮真的走完了（存储尾部或遇到未过期记录），
    // false 表示只是达到单事务条数上限，外层要换事务继续。
    let walkOver = false;
    let complete = false;
    let deleted = 0;
    transaction.oncomplete = () => resolve({ complete, deleted });
    transaction.onabort = () => reject(transaction.error || new Error('日志清理事务中止'));
    transaction.onerror = () => reject(transaction.error || new Error('日志清理事务失败'));
    const request = transaction.objectStore(EVENT_STORE).openCursor();
    let visited = 0;
    request.onerror = () => reject(request.error || new Error('走访日志 event 失败'));
    request.onsuccess = () => {
      if (walkOver) return;
      const cursor = request.result;
      if (cursor === null) {
        walkOver = true;
        complete = true;
        return;
      }
      visited += 1;
      const timeMs = parseTimeMs(cursor.value?.wallTime);
      if (timeMs === undefined) {
        cursor.continue();
        return;
      }
      if (!expired(timeMs, cutoffMs)) {
        walkOver = true;
        complete = true;
        return;
      }
      const deleteRequest = cursor.delete();
      deleteRequest.onerror = () => reject(deleteRequest.error || new Error('删除过期日志 event 失败'));
      deleteRequest.onsuccess = () => {
        deleted += 1;
        if (!walkOver && visited >= PRUNE_CHUNK_RECORDS) walkOver = true;
        if (!walkOver) cursor.continue();
      };
    };
  });
}

// 本轮事务走访到第一条未过期 event 或存储尾部即完成；按条数上限收尾时换一个事务
// 从存储开头继续（已删除的记录不再出现，天然续扫），直到本轮真正结束。
async function pruneExpiredEvents(database, cutoffMs) {
  let deleted = 0;
  for (;;) {
    const chunk = await pruneChunk(database, cutoffMs);
    deleted += chunk.deleted;
    if (chunk.complete) return deleted;
  }
}

// session 只在自身 startedAt 过期且名下已无任何 event 时删除。剩余 event 检查与
// 删除同处一个 readwrite 事务，页面的批次写入与它串行化，不会删掉一个刚有新
// event 写入的 session。
function pruneExpiredSessions(database, cutoffMs) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction([SESSION_STORE, EVENT_STORE], 'readwrite');
    let deleted = 0;
    transaction.oncomplete = () => resolve(deleted);
    transaction.onabort = () => reject(transaction.error || new Error('日志清理事务中止'));
    transaction.onerror = () => reject(transaction.error || new Error('日志清理事务失败'));
    const request = transaction.objectStore(SESSION_STORE).openCursor();
    request.onerror = () => reject(request.error || new Error('走访日志 session 失败'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor === null) return;
      const session = cursor.value;
      if (!expired(parseTimeMs(session?.startedAt), cutoffMs)) {
        cursor.continue();
        return;
      }
      const remainingRequest = transaction.objectStore(EVENT_STORE).index(EVENT_INDEX).openCursor(
        IDBKeyRange.bound([session.sessionId, 0], [session.sessionId, SESSION_KEY_CEILING]),
      );
      remainingRequest.onerror = () => reject(remainingRequest.error || new Error('检查 session 剩余 event 失败'));
      remainingRequest.onsuccess = () => {
        if (remainingRequest.result !== null) {
          cursor.continue();
          return;
        }
        const deleteRequest = cursor.delete();
        deleteRequest.onerror = () => reject(deleteRequest.error || new Error('删除过期日志 session 失败'));
        deleteRequest.onsuccess = () => {
          deleted += 1;
          cursor.continue();
        };
      };
    };
  });
}

// 节流存在 chrome.storage.session：后台 service worker 每次启动以及日志批次写入后
// 都会触发检查，但至多每 LOG_RETENTION.pruneIntervalMs（1 小时）真正清理一次；
// 不使用 alarms，不新增任何 manifest 权限。先认领时间戳再清理，并发触发只跑一个。
export async function pruneExpiredLogs({
  indexedDbObject = globalThis.indexedDB,
  throttleStore,
  now = new Date(),
} = {}) {
  if (throttleStore?.get === undefined || throttleStore?.set === undefined) {
    throw new Error('日志清理节流存储不可用');
  }
  const stored = await throttleStore.get('lastPruneAtMs');
  const lastPruneAtMs = Number(stored?.lastPruneAtMs);
  if (Number.isFinite(lastPruneAtMs)
    && now.getTime() - lastPruneAtMs < LOG_RETENTION.pruneIntervalMs) {
    return { skipped: true };
  }
  await throttleStore.set({ lastPruneAtMs: now.getTime() });
  const database = await openLogDatabase(indexedDbObject);
  try {
    const cutoffMs = now.getTime() - LOG_RETENTION.retentionMs;
    const deletedEvents = await pruneExpiredEvents(database, cutoffMs);
    const deletedSessions = await pruneExpiredSessions(database, cutoffMs);
    return { deletedEvents, deletedSessions };
  } finally {
    database.close();
  }
}
