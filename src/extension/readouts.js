import { computeForwardInventory } from '../vod/buffer.js';
import { readMediaFacts } from '../diagnostics/media.js';
import { UNKNOWN_VALUE } from '../diagnostics/privacy.js';

export const READOUTS_VERSION = 3;

// 连续可播放缓存：从播放头向前、音视频轨连续覆盖的秒数。
function forwardSeconds(facts) {
  if (facts === UNKNOWN_VALUE) return UNKNOWN_VALUE;
  const { currentTime, bufferedRanges } = facts;
  if (!Number.isFinite(currentTime) || !Array.isArray(bufferedRanges)) return UNKNOWN_VALUE;
  return computeForwardInventory(currentTime, [bufferedRanges]);
}

export function buildReadouts({
  surfaceId,
  video,
  diagnostics,
}) {
  return {
    version: READOUTS_VERSION,
    surfaceId,
    forwardSeconds: forwardSeconds(readMediaFacts(video, 'readout')),
    // 内容侧自报路由：popup 没有 tabs 权限，看不到标签页地址。
    routeKind: diagnostics?.routeKind || UNKNOWN_VALUE,
    diagnostics: {
      sessionId: diagnostics?.sessionId || UNKNOWN_VALUE,
    },
  };
}
