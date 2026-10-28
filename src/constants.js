export const VERSION = '1.2.2';

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

// 直播在途快照（live.inventory）与弹窗据它写出的“在等什么”。
// 页面侧：卡顿迹象 = 有分片请求在途满 stallSignMs，或距上一次交付满 stallSignMs；迹象成立
// 期间每 snapshotIntervalMs 写一份。分片约每秒交付一次时迹象不成立，一份也不写；个别直播间
// 的分片间隔偶尔满 stallSignMs，那一刻会写一两份。卡顿的头 stallSignMs 里播放器还有约 3 秒
// 缓冲，弹窗仍用旧写法不误导。tickMs 是检查周期：
// 迹象出现后最多晚 tickMs 写第一份，后续快照的间隔最多比 snapshotIntervalMs 多 tickMs，
// 弹窗每次取数时最新一份快照因此始终在 validMs 之内。
// 弹窗侧：noticeMs 是播放列表停更、播放器不再请求才写出文字的门槛，与播放器约 3 秒的直播
// 缓冲一致，画面一卡文字就出现；再低则正常的播放列表刷新间隔也会偶尔触发。validMs 是
// 一份快照可据以判断的时限，之后快照不再代表此刻。
export const LIVE_INVENTORY_CONFIG = Object.freeze({
  stallSignMs: 2000,
  snapshotIntervalMs: 2000,
  tickMs: 250,
  noticeMs: 3000,
  validMs: 3000,
});

export const DIAGNOSTIC_MESSAGE_VERSION = 1;
