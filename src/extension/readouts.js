import { computeForwardInventory } from '../vod/buffer.js';
import { readMediaFacts } from '../diagnostics/media.js';
import { UNKNOWN_VALUE } from '../diagnostics/privacy.js';

export const READOUTS_VERSION = 4;

// 连续可播放缓存：从播放头向前、音视频轨连续覆盖的秒数。
function forwardSeconds(facts) {
  if (facts === UNKNOWN_VALUE) return UNKNOWN_VALUE;
  const { currentTime, bufferedRanges } = facts;
  if (!Number.isFinite(currentTime) || !Array.isArray(bufferedRanges)) return UNKNOWN_VALUE;
  return computeForwardInventory(currentTime, [bufferedRanges]);
}

// 在等数据：没暂停、没播完，readyState < 3。readyState 小于 3 有两个原因：播放位置
// 的数据还没到（网络供不上），或者数据已在缓冲里、解码器没按时交出下一帧（解码
// 供不上）。Chromium 对两种原因都降 readyState 并发 waiting 事件
// （https://github.com/whatwg/html/issues/6359），只看这个标志分不出是哪一种；
// 弹窗按同一次读数里的前向缓冲秒数分开（popup-view.js 的
// DECODER_STALL_FORWARD_SECONDS）。
// 三个前提有一个读不到就如实报未提供，弹窗只在拿到真值时才改口到等待行。
function waitingFrom(facts) {
  if (facts === UNKNOWN_VALUE) return UNKNOWN_VALUE;
  if (typeof facts.paused !== 'boolean' || typeof facts.ended !== 'boolean' || !Number.isFinite(facts.readyState)) {
    return UNKNOWN_VALUE;
  }
  return facts.paused === false && facts.ended === false && facts.readyState < 3;
}

export function buildReadouts({
  surfaceId,
  video,
  diagnostics,
}) {
  const facts = readMediaFacts(video, 'readout');
  return {
    version: READOUTS_VERSION,
    surfaceId,
    forwardSeconds: forwardSeconds(facts),
    currentTime: facts === UNKNOWN_VALUE ? UNKNOWN_VALUE : facts.currentTime,
    duration: facts === UNKNOWN_VALUE ? UNKNOWN_VALUE : facts.duration,
    waiting: waitingFrom(facts),
    // 内容侧自报路由：popup 没有 tabs 权限，看不到标签页地址。
    routeKind: diagnostics?.routeKind || UNKNOWN_VALUE,
    diagnostics: {
      sessionId: diagnostics?.sessionId || UNKNOWN_VALUE,
    },
  };
}
