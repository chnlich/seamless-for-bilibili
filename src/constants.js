export const VERSION = '1.0.0';

export const EXTENSION_MANIFEST = Object.freeze({
  manifestVersion: 3,
  minimumChromeVersion: '120',
  matches: Object.freeze([
    'https://www.bilibili.com/*',
    'https://live.bilibili.com/*',
  ]),
  hostPermissions: Object.freeze([]),
});

export const EXTENSION_PREFERENCES = Object.freeze({
  vodEnabled: 'vodEnabled',
  liveEnabled: 'liveEnabled',
});

export const VOD_CONFIG = Object.freeze({
  stableBufferSeconds: 120,
});

// 开发诊断日志只保留最近 3 天（72 小时）：超期记录按其自身时间删除；
// pruneIntervalMs 是两次清理之间的最小间隔（不新增任何 manifest 权限）。
export const LOG_RETENTION = Object.freeze({
  retentionMs: 72 * 60 * 60 * 1000,
  pruneIntervalMs: 60 * 60 * 1000,
});

export const BANK_CONFIG = Object.freeze({
  chunkBytes: 1024 ** 2,
  maxBankBytes: 512 * 1024 ** 2,
  stallMs: 10000,
  lookAheadChunks: 48,
  maxChunkAttempts: 3,
  raceLegs: 2,
  pairFreshnessMs: 3600000,
});

export const DIAGNOSTIC_MESSAGE_VERSION = 1;
