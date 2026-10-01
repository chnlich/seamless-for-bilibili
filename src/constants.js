export const VERSION = '1.1.0';

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

// 直播 FLV 后备：帧窗口 30 秒（覆盖 20 秒量级的分片卡顿）；断线连续重连最多 3 次，
// 每次间隔 1 秒；网络分片连续 10 次校准不上即判这条流不可用。无字节停滞沿用 stallMs。
export const LIVE_FLV_BACKUP_CONFIG = Object.freeze({
  windowMs: 30000,
  maxReconnects: 3,
  reconnectDelayMs: 1000,
  maxCalibrationAttempts: 10,
});

export const DIAGNOSTIC_MESSAGE_VERSION = 1;
