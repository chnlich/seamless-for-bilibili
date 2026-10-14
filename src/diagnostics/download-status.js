// 把一次播放会话的下载记录折算成弹窗「下载线路」卡片要读的下载状态。
// 纯函数：输入是 session 的 bank.fetch.chunk 记录序列（按存储顺序，含 wallTime）、
// 最新一条 bank.inventory 事件（可缺）与查询时刻；worker 在 logs:cdn-summary 里调用
// （src/diagnostics/worker.js 的 readCdnSummary），弹窗只把结果拼成人话。
// 速度口径：每条记录的字节平均摊在它的耗时里（结束时刻 wallTime 往前推 durationMs），
// 累加落在最近 SPEED_WINDOW_MS 的部分，乘 8 再除以窗口秒数得比特每秒。
// 竞速输的一路收到的字节也计入线路速度，合计速度是各线路之和。
// LINE_ACTIVITY_WINDOW_MS 是停滞判定 stallMs（10 秒）加 5 秒：
// 一次停滞的结果一定落在这个窗口里，线路行才不会刚停滞完就报「空闲」。
// 重试轮数：某文件缺的下一块（连续字节终点所在的块）在上次取到之后、本 session 内
// 线路自身失败的记录数，两条线路各数各的取较大者；竞速输与扩展自己放弃的
// （lost_race、superseded、aborted、gave_up）不算失败，直播地址签名过期也不算。
import { BANK_CONFIG } from '../constants.js';

export const SPEED_WINDOW_MS = 5000;
export const LINE_ACTIVITY_WINDOW_MS = 15000;

const RETRY_FAILURE_RESULTS = new Set(['stalled', 'invalid_response', 'network_error', 'http_error']);

function endMsOf(event) {
  const endMs = Date.parse(event.wallTime);
  if (!Number.isFinite(endMs)) throw new Error(`bank.fetch.chunk 记录缺少有效 wallTime: ${JSON.stringify(event.wallTime)}`);
  return endMs;
}

function pathnameOf(source) {
  return new URL(source).pathname;
}

function lineStatsFor(lines, mirror) {
  let stats = lines.get(mirror);
  if (stats === undefined) {
    stats = {
      mirror,
      windowedBytes: 0,
      fetchedEndsInWindow: false,
      seenInActivityWindow: false,
      lastEndInActivityWindow: -Infinity,
      lastResultInWindow: undefined,
    };
    lines.set(mirror, stats);
  }
  return stats;
}

function failedRoundsForResource(resource, chunkEvents) {
  if (!Number.isSafeInteger(resource.contiguousEnd) || !Number.isSafeInteger(resource.totalSize)) return 0;
  if (resource.contiguousEnd >= resource.totalSize) return 0;
  const nextChunk = Math.floor(resource.contiguousEnd / BANK_CONFIG.chunkBytes);
  const perMirror = new Map();
  for (const event of chunkEvents) {
    const data = event.data;
    if (data.chunkIndex !== nextChunk || pathnameOf(data.source) !== resource.pathname) continue;
    if (data.result === 'fetched') {
      // 取到之后重数：取到之前的失败属于已经解决的那一轮。
      perMirror.clear();
    } else if (RETRY_FAILURE_RESULTS.has(data.result)) {
      perMirror.set(data.mirror, (perMirror.get(data.mirror) || 0) + 1);
    }
  }
  return perMirror.size === 0 ? 0 : Math.max(...perMirror.values());
}

export function deriveDownloadStatus({ chunkEvents, latestInventory, nowMs }) {
  const lines = new Map();
  for (const event of chunkEvents) {
    const data = event.data;
    const endMs = endMsOf(event);
    if (endMs > nowMs) continue;
    const stats = lineStatsFor(lines, data.mirror);
    if (endMs >= nowMs - SPEED_WINDOW_MS) {
      const durationMs = Number.isFinite(data.durationMs) && data.durationMs > 0 ? data.durationMs : 0;
      stats.windowedBytes += durationMs === 0
        ? data.bytes
        : data.bytes * ((endMs - Math.max(endMs - durationMs, nowMs - SPEED_WINDOW_MS)) / durationMs);
      if (data.result === 'fetched') stats.fetchedEndsInWindow = true;
    }
    // 同一毫秒结束的多条记录里，靠后写入的那条才是「最后一条」。
    if (endMs >= nowMs - LINE_ACTIVITY_WINDOW_MS && endMs >= stats.lastEndInActivityWindow) {
      stats.seenInActivityWindow = true;
      stats.lastEndInActivityWindow = endMs;
      stats.lastResultInWindow = data.result;
    }
  }
  const lineRows = [...lines.values()]
    .sort((left, right) => String(left.mirror).localeCompare(String(right.mirror)))
    .map((stats) => ({
      mirror: stats.mirror,
      bitsPerSecond: (stats.windowedBytes * 8) / (SPEED_WINDOW_MS / 1000),
      receivedInWindow: stats.windowedBytes > 0,
      fetchedEndsInWindow: stats.fetchedEndsInWindow,
      seenInActivityWindow: stats.seenInActivityWindow,
      lastResultInWindow: stats.lastResultInWindow,
    }));
  const inventoryData = latestInventory?.data;
  const inventory = inventoryData === undefined
    ? undefined
    : {
      inflight: inventoryData.inflight,
      queued: inventoryData.queued,
      resources: Array.isArray(inventoryData.resources)
        ? inventoryData.resources.map((resource) => {
          const folded = {
            pathname: resource.pathname,
            kind: resource.kind,
            active: resource.active,
            totalSize: resource.totalSize,
            outstanding: resource.outstanding,
            failedRounds: failedRoundsForResource(resource, chunkEvents),
          };
          if (Number.isSafeInteger(resource.contiguousEnd)) folded.contiguousEnd = resource.contiguousEnd;
          return folded;
        })
        : [],
    };
  return {
    hasRecords: chunkEvents.length > 0,
    anyLineBytesInWindow: lineRows.some((line) => line.receivedInWindow),
    totalBitsPerSecond: lineRows.reduce((total, line) => total + line.bitsPerSecond, 0),
    lines: lineRows,
    inventory,
  };
}
