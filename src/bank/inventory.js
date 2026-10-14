import { UNKNOWN_VALUE } from '../diagnostics/privacy.js';
import { anchorChunkIndex } from './logic.js';

// Five seconds is long enough to survive a delayed diagnostic batch and short enough to
// make a stopped download layer visible in the popup.
export const INVENTORY_HEARTBEAT_FLOOR_MS = 5000;

function nonnegativeIntegerOrUnknown(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : UNKNOWN_VALUE;
}

function stringOrUnknown(value) {
  return typeof value === 'string' && value.length > 0 ? value : UNKNOWN_VALUE;
}

function resourceKeyFromCacheKey(value) {
  const separator = value.lastIndexOf('#');
  if (separator <= 0) throw new Error(`库存 cacheKey 无效: ${value}`);
  return value.slice(0, separator);
}

// 连续存好的字节终点（不含）：从预取窗口的起点块（anchorChunkIndex，见 logic.js）
// 往后数没有空洞的已存块，第一个缺块的开头就是终点；一路数到文件末尾时等于
// totalSize，这样「整个视频已下载」可以从这个值直接判出。起点或总长未知时
// 返回 undefined，调用方不写这个字段，不拿缺块硬凑一个数。
function contiguousEndForResource({ indices, state, chunkBytes }) {
  const anchor = anchorChunkIndex(state, chunkBytes);
  if (anchor === undefined || !Number.isSafeInteger(state.totalSize)) return undefined;
  let index = anchor;
  while (indices.has(index)) index += 1;
  const chunkCount = Math.ceil(state.totalSize / chunkBytes);
  return index >= chunkCount ? state.totalSize : index * chunkBytes;
}

function representationFor(addressBook, resourceKey) {
  const entry = addressBook.get(resourceKey);
  if (entry === undefined) return {};
  return entry.representation || {};
}

function labelFor(addressBook, resourceKey, representation) {
  const entry = addressBook.get(resourceKey);
  if (typeof entry?.label === 'string' && entry.label.length > 0) return entry.label;
  const parts = [];
  if (Number.isSafeInteger(representation.height) && representation.height > 0) {
    parts.push(`${representation.height}P`);
  }
  const frameRate = representation.frameRate ?? representation.frame_rate;
  if (frameRate !== undefined && frameRate !== null && String(frameRate).length > 0) {
    parts.push(`${frameRate}fps`);
  }
  if (typeof representation.codecs === 'string' && representation.codecs.length > 0) {
    parts.push(representation.codecs);
  }
  if (parts.length === 0 && Number.isSafeInteger(representation.bandwidth) && representation.bandwidth > 0) {
    parts.push(`${representation.bandwidth}bps`);
  }
  return parts.length === 0 ? UNKNOWN_VALUE : parts.join(' · ');
}

function resourceFrom({ resourceKey, stored, state, addressBook, recentResourceKeys, chunkBytes }) {
  const representation = representationFor(addressBook, resourceKey);
  const contiguousEnd = state === undefined
    ? undefined
    : contiguousEndForResource({ indices: stored.indices, state, chunkBytes });
  const resource = {
    pathname: resourceKey,
    kind: typeof representation.mimeType === 'string' && representation.mimeType.startsWith('video/')
      ? 'video'
      : typeof representation.mimeType === 'string' && representation.mimeType.startsWith('audio/')
        ? 'audio'
        : UNKNOWN_VALUE,
    label: labelFor(addressBook, resourceKey, representation),
    height: nonnegativeIntegerOrUnknown(representation.height),
    codecs: stringOrUnknown(representation.codecs),
    bandwidth: nonnegativeIntegerOrUnknown(representation.bandwidth),
    storedBytes: stored.bytes,
    storedChunks: stored.chunks,
    totalSize: state === undefined ? UNKNOWN_VALUE : nonnegativeIntegerOrUnknown(state.totalSize),
    lastForegroundEnd: state === undefined
      ? UNKNOWN_VALUE
      : nonnegativeIntegerOrUnknown(state.lastForegroundEnd),
    outstanding: state?.outstanding === undefined ? 0 : state.outstanding.size,
    retrying: state?.chunkAttempts === undefined
      ? 0
      : [...state.chunkAttempts.values()].filter((attempts) => attempts > 0).length,
    active: recentResourceKeys.includes(resourceKey),
  };
  if (contiguousEnd !== undefined) resource.contiguousEnd = contiguousEnd;
  return resource;
}

function storedByResource(chunks) {
  const stored = new Map();
  for (const [cacheKey, record] of chunks) {
    if (!(record?.bytes instanceof ArrayBuffer)) {
      throw new Error(`库存分片缺少 ArrayBuffer: ${cacheKey}`);
    }
    const resourceKey = resourceKeyFromCacheKey(cacheKey);
    const current = stored.get(resourceKey) || { bytes: 0, chunks: 0, indices: new Set() };
    current.bytes += record.bytes.byteLength;
    current.chunks += 1;
    current.indices.add(Number(cacheKey.slice(cacheKey.lastIndexOf('#') + 1)));
    stored.set(resourceKey, current);
  }
  return stored;
}

export function deriveBankInventory({
  chunks,
  chunkBytes,
  resourceState,
  addressBook,
  recentResourceKeys,
  maxBankBytes,
  maxPrefetchConcurrency,
  queueLength,
  inflightCount,
  disabled,
  routeActive,
  isPairedAddressAvailable,
  sessionGeneration,
}) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes <= 0) throw new Error('库存推导缺少分片大小');
  const storedByKey = storedByResource(chunks);
  const resourceKeys = new Set([
    ...resourceState.keys(),
    ...storedByKey.keys(),
  ]);
  const sortedResourceKeys = [...resourceKeys].sort((left, right) => left.localeCompare(right));
  const resources = sortedResourceKeys.map((resourceKey) => resourceFrom({
    resourceKey,
    stored: storedByKey.get(resourceKey) || { bytes: 0, chunks: 0, indices: new Set() },
    state: resourceState.get(resourceKey),
    addressBook,
    recentResourceKeys,
    chunkBytes,
  }));
  const activeResourceKeys = recentResourceKeys.filter((resourceKey) => resourceKeys.has(resourceKey));
  const pairedAddressAvailable = activeResourceKeys.some((resourceKey) => {
    const state = resourceState.get(resourceKey);
    return state?.latestUrl !== undefined && isPairedAddressAvailable(state.latestUrl) === true;
  });
  return {
    sessionGeneration: nonnegativeIntegerOrUnknown(sessionGeneration),
    storedBytes: resources.reduce((total, resource) => total + resource.storedBytes, 0),
    storedChunks: resources.reduce((total, resource) => total + resource.storedChunks, 0),
    maxBankBytes: nonnegativeIntegerOrUnknown(maxBankBytes),
    queued: nonnegativeIntegerOrUnknown(queueLength),
    inflight: nonnegativeIntegerOrUnknown(inflightCount),
    prefetchConcurrency: nonnegativeIntegerOrUnknown(maxPrefetchConcurrency),
    disabled: disabled === true || disabled === false ? disabled : UNKNOWN_VALUE,
    routeActive: routeActive === true || routeActive === false ? routeActive : UNKNOWN_VALUE,
    pairedAddressAvailable,
    resources,
  };
}

export function sameInventoryPayload(left, right) {
  return left !== undefined && right !== undefined && JSON.stringify(left) === JSON.stringify(right);
}
