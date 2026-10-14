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

// 在等数据：没暂停、没播完，readyState < 3（手上没有能往下播的数据）。
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
