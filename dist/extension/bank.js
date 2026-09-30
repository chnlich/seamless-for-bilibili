(() => {
  // src/constants.js
  var EXTENSION_MANIFEST = Object.freeze({
    manifestVersion: 3,
    minimumChromeVersion: "120",
    matches: Object.freeze([
      "https://www.bilibili.com/*",
      "https://live.bilibili.com/*"
    ]),
    hostPermissions: Object.freeze([])
  });
  var EXTENSION_PREFERENCES = Object.freeze({
    vodEnabled: "vodEnabled",
    liveEnabled: "liveEnabled"
  });
  var VOD_CONFIG = Object.freeze({
    stableBufferSeconds: 120
  });
  var LOG_RETENTION = Object.freeze({
    retentionMs: 72 * 60 * 60 * 1e3,
    pruneIntervalMs: 60 * 60 * 1e3
  });
  var BANK_CONFIG = Object.freeze({
    chunkBytes: 1024 ** 2,
    maxBankBytes: 512 * 1024 ** 2,
    stallMs: 1e4,
    lookAheadChunks: 48,
    maxChunkAttempts: 3,
    raceLegs: 2,
    pairFreshnessMs: 36e5
  });
  var LIVE_FLV_BACKUP_CONFIG = Object.freeze({
    windowMs: 3e4,
    maxReconnects: 3,
    reconnectDelayMs: 1e3,
    maxCalibrationAttempts: 10
  });

  // src/diagnostics/catalog.js
  var MEDIA_EVENT_NAMES = Object.freeze([
    "loadstart",
    "loadedmetadata",
    "loadeddata",
    "canplay",
    "canplaythrough",
    "play",
    "playing",
    "pause",
    "waiting",
    "stalled",
    "progress",
    "seeking",
    "seeked",
    "ratechange",
    "volumechange",
    "durationchange",
    "resize",
    "suspend",
    "emptied",
    "abort",
    "error",
    "ended"
  ]);
  var EVENT_CODES = Object.freeze([
    "route.session_started",
    "route.changed",
    "route.unsupported",
    "route.no_video",
    "preference.read",
    "preference.changed",
    "preference.disabled",
    "video.attached",
    "video.replaced",
    "video.destroyed",
    "video.source_replaced",
    "video.visibility_changed",
    "video.core_replaced",
    "media.sample",
    "media.append",
    ...MEDIA_EVENT_NAMES.map((name) => `media.${name}`),
    "video.buffer_hint.attempt",
    "video.buffer_hint.applied",
    "video.buffer_hint.unsupported",
    "video.buffer_hint.failed",
    "video.buffer_observed",
    "bridge.error",
    "bank.fetch.chunk",
    "bank.serve",
    "bank.evict",
    "bank.store",
    "bank.disabled",
    "bank.inventory",
    "live.stream.stitch",
    "live.playurl_observed",
    "live.flv.backup",
    "extension.started",
    "extension.boot_error",
    "extension.observer_error",
    "extension.destroyed",
    "log.persist.degraded",
    "log.error"
  ]);
  var EXACT_CODES = new Set(EVENT_CODES);
  var DATA_ALLOWLIST = Object.freeze({
    route: Object.freeze([
      "routeKind",
      "origin",
      "pathname",
      "reason",
      "bvid",
      "part",
      "watchLaterItem"
    ]),
    preference: Object.freeze(["name", "enabled"]),
    video: Object.freeze([
      "videoInstance",
      "sourceInstance",
      "coreInstance",
      "source",
      "previousSource",
      "state",
      "previousState",
      "targetSeconds",
      "actualSeconds",
      "peakSeconds",
      "sampledSeconds",
      "samples",
      "reason"
    ]),
    media: Object.freeze([
      "eventType",
      "bufferedRanges",
      "seekableRanges",
      "currentTime",
      "duration",
      "paused",
      "ended",
      "readyState",
      "networkState",
      "resolution",
      "playbackRate",
      "source",
      "videoQuality",
      "sourceBufferRanges",
      "mediaSourceState",
      "appendErrors",
      "removeStats",
      "presented",
      "frameTiming",
      "mediaSourceInstance",
      "sourceBufferInstance",
      "appendSequence",
      "track",
      "bytes",
      "bufferedBefore",
      "bufferedAfter",
      "durationMs",
      "result",
      "errorName"
    ]),
    resource: Object.freeze([
      "name",
      "initiatorType",
      "startTime",
      "duration",
      "responseStart",
      "responseEnd",
      "transferSize",
      "encodedBodySize",
      "decodedBodySize"
    ]),
    bridge: Object.freeze(["operation", "direction", "status"]),
    bank: Object.freeze([
      "source",
      "mirror",
      "operation",
      "chunkIndex",
      "start",
      "end",
      "bytes",
      "durationMs",
      "slot",
      "ttfbMs",
      "httpStatus",
      "priority",
      "result",
      "reason",
      "errorName",
      "pairMiss",
      "sessionGeneration",
      "storedBytes",
      "storedChunks",
      "maxBankBytes",
      "queued",
      "inflight",
      "prefetchConcurrency",
      "disabled",
      "routeActive",
      "pairedAddressAvailable",
      "resources",
      "winner"
    ]),
    live: Object.freeze([
      "streamPath",
      "bytesChecked",
      "mismatch",
      "phase",
      "channel",
      "groupCount",
      "flvGroupCount",
      "errorName",
      "state",
      "mirror",
      "reason"
    ]),
    extension: Object.freeze(["action", "reason", "status"]),
    persist: Object.freeze(["status", "batchSize", "eventCount", "message", "code"]),
    log: Object.freeze(["errorName", "message", "code"])
  });

  // src/diagnostics/privacy.js
  var UNKNOWN_VALUE = "未提供";
  function scrubUrl(value) {
    if (typeof value !== "string" || value.length === 0) {
      return UNKNOWN_VALUE;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch (error) {
      return UNKNOWN_VALUE;
    }
    return `${parsed.origin}${parsed.pathname}`;
  }
  var PREFERENCE_NAMES = new Set(Object.values(EXTENSION_PREFERENCES));

  // src/bank/errors.js
  var BankFallbackError = class extends Error {
    constructor(message, cause) {
      super(message, { cause });
      this.name = "BankFallbackError";
      this.code = "BANK_FALLBACK";
    }
  };
  var BankNetworkError = class extends Error {
    constructor(message, cause) {
      super(message, { cause });
      this.name = "BankNetworkError";
      this.code = "BANK_NETWORK_FAILED";
    }
  };

  // src/route.js
  function routeIdentity(locationObject) {
    const pathname = locationObject.pathname || "/";
    const part = new URLSearchParams(locationObject.search || "").get("p") || void 0;
    if (locationObject.hostname === "www.bilibili.com" && pathname.startsWith("/video/")) {
      return { routeKind: "video", bvid: pathname.split("/")[2] || void 0, part };
    }
    if (locationObject.hostname === "www.bilibili.com" && pathname.startsWith("/list/watchlater")) {
      return { routeKind: "video", watchLaterItem: pathname.split("/")[3] || void 0, part };
    }
    if (locationObject.hostname === "live.bilibili.com") {
      return { routeKind: "live", part };
    }
    return { routeKind: "other", part };
  }

  // src/bank/inventory.js
  var INVENTORY_HEARTBEAT_FLOOR_MS = 5e3;
  function nonnegativeIntegerOrUnknown(value) {
    return Number.isSafeInteger(value) && value >= 0 ? value : UNKNOWN_VALUE;
  }
  function stringOrUnknown(value) {
    return typeof value === "string" && value.length > 0 ? value : UNKNOWN_VALUE;
  }
  function resourceKeyFromCacheKey(value) {
    const separator = value.lastIndexOf("#");
    if (separator <= 0) throw new Error(`库存 cacheKey 无效: ${value}`);
    return value.slice(0, separator);
  }
  function representationFor(addressBook, resourceKey) {
    const entry = addressBook.get(resourceKey);
    if (entry === void 0) return {};
    return entry.representation || {};
  }
  function labelFor(addressBook, resourceKey, representation) {
    const entry = addressBook.get(resourceKey);
    if (typeof entry?.label === "string" && entry.label.length > 0) return entry.label;
    const parts = [];
    if (Number.isSafeInteger(representation.height) && representation.height > 0) {
      parts.push(`${representation.height}P`);
    }
    const frameRate = representation.frameRate ?? representation.frame_rate;
    if (frameRate !== void 0 && frameRate !== null && String(frameRate).length > 0) {
      parts.push(`${frameRate}fps`);
    }
    if (typeof representation.codecs === "string" && representation.codecs.length > 0) {
      parts.push(representation.codecs);
    }
    if (parts.length === 0 && Number.isSafeInteger(representation.bandwidth) && representation.bandwidth > 0) {
      parts.push(`${representation.bandwidth}bps`);
    }
    return parts.length === 0 ? UNKNOWN_VALUE : parts.join(" · ");
  }
  function resourceFrom({ resourceKey, stored, state, addressBook, recentResourceKeys }) {
    const representation = representationFor(addressBook, resourceKey);
    return {
      pathname: resourceKey,
      kind: typeof representation.mimeType === "string" && representation.mimeType.startsWith("video/") ? "video" : typeof representation.mimeType === "string" && representation.mimeType.startsWith("audio/") ? "audio" : UNKNOWN_VALUE,
      label: labelFor(addressBook, resourceKey, representation),
      height: nonnegativeIntegerOrUnknown(representation.height),
      codecs: stringOrUnknown(representation.codecs),
      bandwidth: nonnegativeIntegerOrUnknown(representation.bandwidth),
      storedBytes: stored.bytes,
      storedChunks: stored.chunks,
      totalSize: state === void 0 ? UNKNOWN_VALUE : nonnegativeIntegerOrUnknown(state.totalSize),
      lastForegroundEnd: state === void 0 ? UNKNOWN_VALUE : nonnegativeIntegerOrUnknown(state.lastForegroundEnd),
      outstanding: state?.outstanding === void 0 ? 0 : state.outstanding.size,
      retrying: state?.chunkAttempts === void 0 ? 0 : [...state.chunkAttempts.values()].filter((attempts) => attempts > 0).length,
      active: recentResourceKeys.includes(resourceKey)
    };
  }
  function storedByResource(chunks) {
    const stored = /* @__PURE__ */ new Map();
    for (const [cacheKey2, record] of chunks) {
      if (!(record?.bytes instanceof ArrayBuffer)) {
        throw new Error(`库存分片缺少 ArrayBuffer: ${cacheKey2}`);
      }
      const resourceKey = resourceKeyFromCacheKey(cacheKey2);
      const current = stored.get(resourceKey) || { bytes: 0, chunks: 0 };
      current.bytes += record.bytes.byteLength;
      current.chunks += 1;
      stored.set(resourceKey, current);
    }
    return stored;
  }
  function deriveBankInventory({
    chunks,
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
    sessionGeneration
  }) {
    const storedByKey = storedByResource(chunks);
    const resourceKeys = /* @__PURE__ */ new Set([
      ...resourceState.keys(),
      ...storedByKey.keys()
    ]);
    const sortedResourceKeys = [...resourceKeys].sort((left, right) => left.localeCompare(right));
    const resources = sortedResourceKeys.map((resourceKey) => resourceFrom({
      resourceKey,
      stored: storedByKey.get(resourceKey) || { bytes: 0, chunks: 0 },
      state: resourceState.get(resourceKey),
      addressBook,
      recentResourceKeys
    }));
    const activeResourceKeys = recentResourceKeys.filter((resourceKey) => resourceKeys.has(resourceKey));
    const pairedAddressAvailable = activeResourceKeys.some((resourceKey) => {
      const state = resourceState.get(resourceKey);
      return state?.latestUrl !== void 0 && isPairedAddressAvailable(state.latestUrl) === true;
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
      resources
    };
  }
  function sameInventoryPayload(left, right) {
    return left !== void 0 && right !== void 0 && JSON.stringify(left) === JSON.stringify(right);
  }

  // src/bank/contract.js
  var BANK_ENABLED_ATTRIBUTE = "data-bilibili-buffer-bank-enabled";
  var BANK_MESSAGE_NAMESPACE = "bilibili-buffer:segment-bank-v1";
  var BANK_DIAGNOSTIC_MESSAGE_TYPE = "diagnostic";

  // src/bank/logic.js
  function requireNonNegativeInteger(value, field) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`${field} 必须是非负整数`);
    }
    return value;
  }
  function isVideoLocation(locationObject) {
    return locationObject.hostname === "www.bilibili.com" && (locationObject.pathname.startsWith("/video/") || locationObject.pathname === "/list/watchlater" || locationObject.pathname.startsWith("/list/watchlater/"));
  }
  function bankKey(url) {
    return new URL(url).pathname;
  }
  function chunkIndex(byteOffset, chunkBytes = BANK_CONFIG.chunkBytes) {
    requireNonNegativeInteger(byteOffset, "字节偏移");
    requireNonNegativeInteger(chunkBytes, "分片大小");
    if (chunkBytes === 0) throw new Error("分片大小不能为零");
    return Math.floor(byteOffset / chunkBytes);
  }
  function cacheKey(bankKeyValue, index) {
    if (typeof bankKeyValue !== "string" || bankKeyValue.length === 0) {
      throw new Error("bankKey 必须是非空字符串");
    }
    requireNonNegativeInteger(index, "分片索引");
    return `${bankKeyValue}#${index}`;
  }
  function headerValue(headers, name) {
    if (headers !== null && typeof headers?.get === "function") return headers.get(name);
    if (Array.isArray(headers)) {
      const wanted = name.toLowerCase();
      for (const entry of headers) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        if (String(entry[0]).toLowerCase() === wanted) return String(entry[1]);
      }
    }
    if (headers !== null && typeof headers === "object") {
      const wanted = name.toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === wanted) return String(value);
      }
    }
    return null;
  }
  function parseRangeHeader(value) {
    if (typeof value !== "string") return void 0;
    const match = /^bytes=(\d+)-(\d+)$/.exec(value);
    if (match === null) return void 0;
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return void 0;
    return { start, end };
  }
  function isMediaHost(hostname) {
    return hostname.endsWith(".bilivideo.com") || hostname.endsWith(".akamaized.net");
  }
  function classifyRequest({ url, headers, enabled = true, locationObject }) {
    if (enabled !== true) return { intercepted: false };
    if (locationObject !== void 0 && !isVideoLocation(locationObject)) {
      return { intercepted: false, reason: "not_video_route" };
    }
    const parsed = new URL(url, locationObject?.href);
    if (!isMediaHost(parsed.hostname)) return { intercepted: false, reason: "non_media_host" };
    const rawRange = headerValue(headers, "Range");
    const range = parseRangeHeader(rawRange);
    if (range === void 0) {
      return { intercepted: false, reason: rawRange === null ? "range_missing" : "range_not_closed" };
    }
    return { intercepted: true, url: parsed.href, range };
  }
  function rangeLength(range) {
    const length = range.end - range.start + 1;
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Range 长度无效");
    return length;
  }
  function parseContentRange(value) {
    if (typeof value !== "string") return void 0;
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(value);
    if (match === null) return void 0;
    const start = Number(match[1]);
    const end = Number(match[2]);
    const totalSize = Number(match[3]);
    if (![start, end, totalSize].every(Number.isSafeInteger) || start > end || end >= totalSize) return void 0;
    return { start, end, totalSize };
  }
  function partialResponseHeaders(start, end, totalSize) {
    const range = { start, end };
    const length = rangeLength(range);
    if (!Number.isSafeInteger(totalSize) || totalSize <= end) throw new Error("媒体总长度无效");
    return {
      "Accept-Ranges": "bytes",
      "Content-Length": String(length),
      "Content-Range": `bytes ${start}-${end}/${totalSize}`,
      "Content-Type": "video/mp4"
    };
  }
  function planFetchRanges(start, end, {
    chunkBytes = BANK_CONFIG.chunkBytes,
    totalSize,
    bankKeyValue = "resource"
  } = {}) {
    const request = { start, end };
    rangeLength(request);
    const result = [];
    let current = Math.floor(start / chunkBytes) * chunkBytes;
    while (current <= end) {
      const chunkEnd = totalSize === void 0 ? current + chunkBytes - 1 : Math.min(current + chunkBytes - 1, totalSize - 1);
      if (chunkEnd >= current) {
        const index = chunkIndex(current, chunkBytes);
        result.push({
          start: current,
          end: chunkEnd,
          chunkIndex: index,
          cacheKey: cacheKey(bankKeyValue, index)
        });
      }
      current += chunkBytes;
    }
    return result;
  }
  function entryBytes(entry) {
    if (Number.isSafeInteger(entry.byteLength) && entry.byteLength >= 0) return entry.byteLength;
    if (entry.bytes instanceof ArrayBuffer) return entry.bytes.byteLength;
    throw new Error("淘汰条目缺少字节数");
  }
  function evictionRank(entry, currentByte) {
    const played = Number.isFinite(currentByte) && Number.isFinite(entry.end) && entry.end < currentByte;
    if (played) return [0, 0, entry.storedAt || 0];
    const distance = Number.isFinite(currentByte) && Number.isFinite(entry.start) ? Math.max(0, entry.start - currentByte) : Number.MAX_SAFE_INTEGER;
    return [1, -distance, entry.storedAt || 0];
  }
  function currentByteForEntry(entry, currentByteByBank) {
    return currentByteByBank[entry.bankKey];
  }
  function compareEvictionEntries(left, right, currentByteByBank) {
    const leftRank = evictionRank(left, currentByteForEntry(left, currentByteByBank));
    const rightRank = evictionRank(right, currentByteForEntry(right, currentByteByBank));
    for (let index = 0; index < leftRank.length; index += 1) {
      if (leftRank[index] !== rightRank[index]) return leftRank[index] - rightRank[index];
    }
    return left.cacheKey.localeCompare(right.cacheKey);
  }
  function selectEvictions({
    entries,
    maxBankBytes,
    currentByteByBank = {}
  }) {
    if (!Array.isArray(entries)) throw new Error("淘汰条目必须是数组");
    const total = entries.reduce((sum, entry) => sum + entryBytes(entry), 0);
    const selected = [];
    const remaining = [...entries];
    let currentTotal = total;
    while (currentTotal > maxBankBytes) {
      const candidates = remaining;
      if (candidates.length === 0) throw new Error("存储超限但没有可淘汰分片");
      candidates.sort((left, right) => compareEvictionEntries(left, right, currentByteByBank));
      const victim = candidates[0];
      selected.push(victim);
      remaining.splice(remaining.indexOf(victim), 1);
      const bytes = entryBytes(victim);
      currentTotal -= bytes;
    }
    return { entries: selected, bytes: selected.reduce((sum, entry) => sum + entryBytes(entry), 0) };
  }

  // src/bank/storage.js
  function requireArrayBuffer(value) {
    if (!(value instanceof ArrayBuffer)) throw new Error("分片字节必须是 ArrayBuffer");
    return value;
  }
  function requireRange(start, end) {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
      throw new Error("分片区间无效");
    }
    return { start, end };
  }
  function requireChunks(chunks) {
    if (!(chunks instanceof Map)) throw new Error("媒体分片表必须是 Map");
    return chunks;
  }
  function requireStoredRecord(record, chunkBytes, cacheKeyValue) {
    if (record === void 0 || record === null || typeof record !== "object") {
      throw new Error(`媒体分片记录 ${cacheKeyValue} 无效`);
    }
    requireArrayBuffer(record.bytes);
    if (record.bytes.byteLength <= 0 || record.bytes.byteLength > chunkBytes) {
      throw new Error(`媒体分片记录 ${cacheKeyValue} 长度无效`);
    }
    if (!Number.isSafeInteger(record.totalSize) || record.totalSize < record.bytes.byteLength) {
      throw new Error(`媒体分片记录 ${cacheKeyValue} 总长度无效`);
    }
    if (!Number.isFinite(record.storedAt)) throw new Error(`媒体分片记录 ${cacheKeyValue} 时间无效`);
    return record;
  }
  function requireCompleteRecord(record, chunkBytes, chunkStart, cacheKeyValue) {
    requireStoredRecord(record, chunkBytes, cacheKeyValue);
    const expectedLength = Math.min(chunkBytes, record.totalSize - chunkStart);
    if (expectedLength <= 0 || record.bytes.byteLength !== expectedLength) {
      throw new Error(`媒体分片记录 ${cacheKeyValue} 不是完整分片`);
    }
    return record;
  }
  function cacheKeyParts(cacheKeyValue) {
    const separator = cacheKeyValue.lastIndexOf("#");
    if (separator <= 0) throw new Error(`媒体分片 cacheKey 无效: ${cacheKeyValue}`);
    const bankKeyValue = cacheKeyValue.slice(0, separator);
    const index = Number(cacheKeyValue.slice(separator + 1));
    chunkIndex(index);
    return { bankKey: bankKeyValue, chunkIndex: index };
  }
  function entriesFor(chunks, chunkBytes) {
    requireChunks(chunks);
    const entries = [];
    for (const [cacheKeyValue, record] of chunks) {
      const { bankKey: bankKeyValue, chunkIndex: index } = cacheKeyParts(cacheKeyValue);
      const start = index * chunkBytes;
      const stored = requireCompleteRecord(record, chunkBytes, start, cacheKeyValue);
      const end = start + stored.bytes.byteLength - 1;
      if (stored.totalSize <= end) throw new Error(`媒体分片记录 ${cacheKeyValue} 超出总长度`);
      entries.push({
        cacheKey: cacheKeyValue,
        bankKey: bankKeyValue,
        chunkIndex: index,
        start,
        end,
        byteLength: stored.bytes.byteLength,
        storedAt: stored.storedAt
      });
    }
    return entries;
  }
  function readMemoryRange(chunks, bankKeyValue, start, end, chunkBytes = BANK_CONFIG.chunkBytes) {
    requireChunks(chunks);
    requireRange(start, end);
    const bytes = new Uint8Array(rangeLength({ start, end }));
    let cursor = start;
    let totalSize;
    const firstIndex = chunkIndex(start, chunkBytes);
    const lastIndex = chunkIndex(end, chunkBytes);
    for (let index = firstIndex; index <= lastIndex; index += 1) {
      const key = cacheKey(bankKeyValue, index);
      const record = chunks.get(key);
      if (record === void 0) return { hit: false, totalSize };
      const chunkStart = index * chunkBytes;
      requireCompleteRecord(record, chunkBytes, chunkStart, key);
      const chunkEnd = chunkStart + record.bytes.byteLength - 1;
      if (chunkStart > cursor || chunkEnd < cursor) return { hit: false, totalSize: record.totalSize };
      const copyStart = Math.max(cursor, chunkStart);
      const copyEnd = Math.min(end, chunkEnd);
      bytes.set(
        new Uint8Array(record.bytes).subarray(copyStart - chunkStart, copyEnd - chunkStart + 1),
        copyStart - start
      );
      cursor = copyEnd + 1;
      totalSize = record.totalSize;
    }
    if (cursor <= end) return { hit: false, totalSize };
    return { hit: true, bytes: bytes.buffer, totalSize };
  }
  function writeMemoryChunk({
    chunks,
    bankKey: bankKeyValue,
    start,
    end,
    totalSize,
    bytes,
    chunkBytes = BANK_CONFIG.chunkBytes,
    storedAt = Date.now()
  }) {
    requireChunks(chunks);
    requireRange(start, end);
    requireArrayBuffer(bytes);
    if (bytes.byteLength !== end - start + 1) throw new Error("媒体分片字节长度与区间不符");
    if (!Number.isSafeInteger(totalSize) || totalSize <= end) throw new Error("媒体分片总长度无效");
    const index = chunkIndex(start, chunkBytes);
    const expectedEnd = Math.min(totalSize - 1, (index + 1) * chunkBytes - 1);
    if (start !== index * chunkBytes || end !== expectedEnd) {
      throw new Error("媒体分片写入区间未按分片边界对齐");
    }
    const key = cacheKey(bankKeyValue, index);
    const previous = chunks.get(key);
    const storedBytes = bytes.slice(0);
    const record = { bytes: storedBytes, totalSize, storedAt };
    requireCompleteRecord(record, chunkBytes, index * chunkBytes, key);
    chunks.set(key, record);
    return {
      cacheKey: key,
      bankKey: bankKeyValue,
      chunkIndex: index,
      bytes: storedBytes.byteLength,
      storedAt,
      previous
    };
  }
  function enforceMemoryLimit({
    chunks,
    maxBankBytes = BANK_CONFIG.maxBankBytes,
    chunkBytes = BANK_CONFIG.chunkBytes,
    currentByteByBank = {}
  }) {
    requireChunks(chunks);
    if (!Number.isSafeInteger(maxBankBytes) || maxBankBytes < 0) throw new Error("内存上限无效");
    const candidates = entriesFor(chunks, chunkBytes);
    const selected = selectEvictions({
      entries: candidates,
      maxBankBytes,
      currentByteByBank
    });
    for (const entry of selected.entries) {
      if (!chunks.delete(entry.cacheKey)) throw new Error(`媒体分片淘汰失败: ${entry.cacheKey}`);
    }
    return {
      entries: selected.entries,
      bytes: selected.bytes,
      reason: selected.entries.length === 0 ? void 0 : "limit"
    };
  }
  function clearMemory(chunks) {
    requireChunks(chunks);
    chunks.clear();
  }

  // src/bank/flv-rebuild.js
  var SEGMENT_TICKS = 9e4;
  var FRAGMENT_TICKS = 22500;
  var VIDEO_TICKS_PER_MS = 90;
  var AUDIO_TICKS_PER_MS = 48;
  var HALF_FRAME_TICKS = 1500;
  var TFHD_BASE_DATA_OFFSET = 1;
  var TFHD_SAMPLE_DESCRIPTION_INDEX = 2;
  var TFHD_DEFAULT_DURATION = 8;
  var TFHD_DEFAULT_SIZE = 16;
  var TFHD_DEFAULT_FLAGS = 32;
  var TFHD_DEFAULT_BASE_IS_MOOF = 131072;
  var TRUN_DATA_OFFSET = 1;
  var TRUN_FIRST_SAMPLE_FLAGS = 4;
  var TRUN_SAMPLE_DURATION = 256;
  var TRUN_SAMPLE_SIZE = 512;
  var TRUN_SAMPLE_FLAGS = 1024;
  var TRUN_SAMPLE_CTS = 2048;
  var SYNC_SAMPLE_FLAGS = 33554432;
  var CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
      table[index] = value >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let crc = 4294967295;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      crc = CRC_TABLE[(crc ^ bytes[index]) & 255] ^ crc >>> 8;
    }
    return (crc ^ 4294967295) >>> 0;
  }
  function hexValue(text, label) {
    if (!/^[0-9a-fA-F]+$/.test(text)) throw new Error(`播放列表 ${label} 不是十六进制: ${text}`);
    return Number.parseInt(text, 16);
  }
  function parseBiliPlaylist(text) {
    const lines = text.split(/\r?\n/);
    let mediaSequence;
    let mapUri;
    let pendingAux;
    let pendingDuration;
    let index = 0;
    const entries = [];
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
        mediaSequence = Number(line.slice("#EXT-X-MEDIA-SEQUENCE:".length));
        if (!Number.isSafeInteger(mediaSequence)) throw new Error(`播放列表媒体序号无效: ${line}`);
        continue;
      }
      if (line.startsWith("#EXT-X-MAP:")) {
        const match = /URI="([^"]+)"/.exec(line);
        if (match === null) throw new Error(`播放列表 EXT-X-MAP 缺少 URI: ${line}`);
        mapUri = match[1].split("?", 1)[0];
        continue;
      }
      if (line.startsWith("#EXT-BILI-AUX:")) {
        const fields = line.slice("#EXT-BILI-AUX:".length).split("|");
        if (fields.length < 4 || fields[1] !== "K" && fields[1] !== "N") {
          throw new Error(`播放列表 EXT-BILI-AUX 格式无效: ${line}`);
        }
        pendingAux = {
          ptsMs: hexValue(fields[0], "显示时间"),
          key: fields[1] === "K",
          size: hexValue(fields[2], "字节数"),
          crc: hexValue(fields[3], "CRC32")
        };
        continue;
      }
      if (line.startsWith("#EXTINF:")) {
        pendingDuration = Number.parseFloat(line.slice("#EXTINF:".length));
        continue;
      }
      if (line.startsWith("#")) continue;
      if (mediaSequence === void 0) throw new Error("播放列表分片出现在 EXT-X-MEDIA-SEQUENCE 之前");
      const name = line.split("?", 1)[0].split("/").at(-1);
      if (pendingAux !== void 0) {
        entries.push({ name, msn: mediaSequence + index, duration: pendingDuration, ...pendingAux });
      }
      index += 1;
      pendingAux = void 0;
      pendingDuration = void 0;
    }
    return { mediaSequence, mapUri, entries };
  }
  var FlvUnsupportedError = class extends Error {
    constructor(message, reason = "flv_codec_unsupported") {
      super(message);
      this.name = "FlvUnsupportedError";
      this.reason = reason;
    }
  };
  var FlvTagReader = class {
    constructor() {
      this.pending = new Uint8Array(0);
      this.headerDone = false;
      this.order = 0;
    }
    push(chunk) {
      const buffer = new Uint8Array(this.pending.byteLength + chunk.byteLength);
      buffer.set(this.pending, 0);
      buffer.set(chunk, this.pending.byteLength);
      let offset = 0;
      const frames = [];
      if (!this.headerDone) {
        if (buffer.byteLength < 9) {
          this.pending = buffer;
          return frames;
        }
        if (buffer[0] !== 70 || buffer[1] !== 76 || buffer[2] !== 86) throw new Error("FLV 头签名无效");
        if ((buffer[4] & 1) === 0) throw new FlvUnsupportedError("FLV 流不含视频", "flv_no_video");
        const headerSize = (buffer[5] << 24 | buffer[6] << 16 | buffer[7] << 8 | buffer[8]) >>> 0;
        if (buffer.byteLength < headerSize + 4) {
          this.pending = buffer;
          return frames;
        }
        offset = headerSize + 4;
        this.headerDone = true;
      }
      while (buffer.byteLength - offset >= 11) {
        const type = buffer[offset];
        const size = buffer[offset + 1] << 16 | buffer[offset + 2] << 8 | buffer[offset + 3];
        if (buffer.byteLength - offset < 11 + size + 4) break;
        const ts = (buffer[offset + 7] << 24 | buffer[offset + 4] << 16 | buffer[offset + 5] << 8 | buffer[offset + 6]) >>> 0;
        const data = buffer.subarray(offset + 11, offset + 11 + size);
        const order = this.order;
        this.order += 1;
        const frame = type === 9 ? videoFrameOf(data, ts, order) : type === 8 ? audioFrameOf(data, ts, order) : void 0;
        if (frame !== void 0) frames.push(frame);
        offset += 11 + size + 4;
      }
      this.pending = buffer.slice(offset);
      return frames;
    }
  };
  function videoFrameOf(data, ts, order) {
    if (data.byteLength < 5) return void 0;
    if ((data[0] & 128) !== 0) throw new FlvUnsupportedError("FLV 扩展视频头不受支持");
    const frameType = data[0] >> 4;
    const codecId = data[0] & 15;
    if (frameType === 5) return void 0;
    if (codecId !== 7 && codecId !== 12) throw new FlvUnsupportedError(`FLV 视频编码不受支持: ${codecId}`);
    if (data[1] !== 1) return void 0;
    const cts = (data[2] << 16 | data[3] << 8 | data[4]) << 8 >> 8;
    return { kind: "video", ts, cts, key: frameType === 1, data: data.slice(5), order };
  }
  function audioFrameOf(data, ts, order) {
    if (data.byteLength < 2) return void 0;
    if (data[0] >> 4 !== 10) throw new FlvUnsupportedError(`FLV 音频编码不受支持: ${data[0] >> 4}`);
    if (data[1] !== 1) return void 0;
    return { kind: "audio", ts, data: data.slice(2), order };
  }
  function readUint32(bytes, offset) {
    return (bytes[offset] << 24 | bytes[offset + 1] << 16 | bytes[offset + 2] << 8 | bytes[offset + 3]) >>> 0;
  }
  function readInt32(bytes, offset) {
    return readUint32(bytes, offset) | 0;
  }
  function readUint64(bytes, offset) {
    return readUint32(bytes, offset) * 2 ** 32 + readUint32(bytes, offset + 4);
  }
  function boxesOf(bytes, start, end) {
    const boxes = [];
    let offset = start;
    while (offset < end) {
      if (end - offset < 8) throw new Error("fMP4 盒子头被截断");
      const size = readUint32(bytes, offset);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      if (size < 8 || offset + size > end) throw new Error(`fMP4 盒子长度无效: ${type} ${size}`);
      boxes.push({ type, start: offset, payload: offset + 8, end: offset + size });
      offset += size;
    }
    return boxes;
  }
  function parseTraf(bytes, traf, moofStart) {
    const result = { trun: void 0 };
    for (const child of boxesOf(bytes, traf.payload, traf.end)) {
      const body = child.payload;
      if (child.type === "tfhd") {
        const flags = readUint32(bytes, body) & 16777215;
        let cursor = body + 8;
        result.trackId = readUint32(bytes, body + 4);
        result.tfhdFlags = flags;
        if (flags & TFHD_BASE_DATA_OFFSET) throw new Error("fMP4 tfhd base-data-offset 不受支持");
        if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) {
          result.sampleDescriptionIndex = readUint32(bytes, cursor);
          cursor += 4;
        }
        if (flags & TFHD_DEFAULT_DURATION) {
          result.defaultDuration = readUint32(bytes, cursor);
          cursor += 4;
        }
        if (flags & TFHD_DEFAULT_SIZE) {
          result.defaultSize = readUint32(bytes, cursor);
          cursor += 4;
        }
        if (flags & TFHD_DEFAULT_FLAGS) {
          result.defaultFlags = readUint32(bytes, cursor);
          cursor += 4;
        }
      } else if (child.type === "tfdt") {
        result.tfdtVersion = bytes[body];
        result.baseTime = bytes[body] === 1 ? readUint64(bytes, body + 4) : readUint32(bytes, body + 4);
      } else if (child.type === "trun") {
        if (result.trun !== void 0) throw new Error("fMP4 traf 含多个 trun，不受支持");
        const version = bytes[body];
        const flags = readUint32(bytes, body) & 16777215;
        const count = readUint32(bytes, body + 4);
        let cursor = body + 8;
        const trun = { version, flags, entries: [] };
        if (flags & TRUN_DATA_OFFSET) {
          trun.dataOffset = readInt32(bytes, cursor);
          cursor += 4;
        }
        if (flags & TRUN_FIRST_SAMPLE_FLAGS) {
          trun.firstSampleFlags = readUint32(bytes, cursor);
          cursor += 4;
        }
        for (let index = 0; index < count; index += 1) {
          const entry = {};
          if (flags & TRUN_SAMPLE_DURATION) {
            entry.duration = readUint32(bytes, cursor);
            cursor += 4;
          }
          if (flags & TRUN_SAMPLE_SIZE) {
            entry.size = readUint32(bytes, cursor);
            cursor += 4;
          }
          if (flags & TRUN_SAMPLE_FLAGS) {
            entry.flags = readUint32(bytes, cursor);
            cursor += 4;
          }
          if (flags & TRUN_SAMPLE_CTS) {
            entry.cts = version === 1 ? readInt32(bytes, cursor) : readUint32(bytes, cursor);
            cursor += 4;
          }
          trun.entries.push(entry);
        }
        result.trun = trun;
      } else {
        throw new Error(`fMP4 traf 子盒子不受支持: ${child.type}`);
      }
    }
    if (result.trackId === void 0 || result.baseTime === void 0 || result.trun === void 0) {
      throw new Error("fMP4 traf 缺少 tfhd/tfdt/trun");
    }
    if (!(result.tfhdFlags & TFHD_DEFAULT_BASE_IS_MOOF) || result.trun.dataOffset === void 0) {
      throw new Error("fMP4 traf 数据偏移不是相对 moof");
    }
    let dataCursor = moofStart + result.trun.dataOffset;
    let time = result.baseTime;
    result.samples = result.trun.entries.map((entry) => {
      const size = entry.size ?? result.defaultSize;
      const duration = entry.duration ?? result.defaultDuration;
      if (!Number.isSafeInteger(size) || !Number.isSafeInteger(duration)) throw new Error("fMP4 样本缺少长度或时长");
      const sample = { data: bytes.subarray(dataCursor, dataCursor + size), time, duration, cts: entry.cts ?? 0 };
      if (dataCursor + size > bytes.byteLength) throw new Error("fMP4 样本越过分片末尾");
      dataCursor += size;
      time += duration;
      return sample;
    });
    return result;
  }
  function parseMediaSegment(bytes) {
    const fragments = [];
    for (const box of boxesOf(bytes, 0, bytes.byteLength)) {
      if (box.type === "moof") {
        const fragment = { seq: void 0, trafs: [], hasMdat: false };
        for (const child of boxesOf(bytes, box.payload, box.end)) {
          if (child.type === "mfhd") fragment.seq = readUint32(bytes, child.payload + 4);
          else if (child.type === "traf") fragment.trafs.push(parseTraf(bytes, child, box.start));
          else throw new Error(`fMP4 moof 子盒子不受支持: ${child.type}`);
        }
        if (fragment.seq === void 0) throw new Error("fMP4 moof 缺少 mfhd");
        fragments.push(fragment);
      } else if (box.type === "mdat") {
        if (fragments.length === 0 || fragments.at(-1).hasMdat) throw new Error("fMP4 mdat 前没有对应的 moof");
        fragments.at(-1).hasMdat = true;
      } else {
        throw new Error(`fMP4 顶层盒子不受支持: ${box.type}`);
      }
    }
    if (fragments.length === 0 || !fragments.every((fragment) => fragment.hasMdat)) {
      throw new Error("fMP4 分片没有完整的 moof+mdat");
    }
    return fragments;
  }
  function bytesEqual(left, right) {
    if (left.byteLength !== right.byteLength) return false;
    for (let index = 0; index < left.byteLength; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
  function matchFrameRun(frames, samples) {
    if (samples.length === 0) return -1;
    for (let start = 0; start + samples.length <= frames.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < samples.length; offset += 1) {
        if (!bytesEqual(frames[start + offset].data, samples[offset].data)) {
          matched = false;
          break;
        }
      }
      if (matched) return start;
    }
    return -1;
  }
  function gcd(left, right) {
    let a = Math.abs(left);
    let b = Math.abs(right);
    while (b !== 0) [a, b] = [b, a % b];
    return a;
  }
  function snap(base, delta, grid) {
    return base + grid * Math.round(delta / grid);
  }
  function videoDecodeTime(timing, frame) {
    return snap(timing.video.base, (frame.ts - timing.video.flvTs) * VIDEO_TICKS_PER_MS, timing.video.grid);
  }
  function videoPresentationTime(timing, frame) {
    return snap(
      timing.video.ptsBase,
      (frame.ts + frame.cts - timing.video.flvPts) * VIDEO_TICKS_PER_MS,
      timing.video.grid
    );
  }
  function audioTime(timing, frame, grid) {
    return snap(timing.audio.base, (frame.ts - timing.audio.flvTs) * AUDIO_TICKS_PER_MS, grid);
  }
  function trafTemplate(traf, kind) {
    const trun = traf.trun;
    if (trun.flags & TRUN_SAMPLE_FLAGS) return { error: "template_unsupported" };
    if (!(trun.flags & TRUN_SAMPLE_SIZE)) return { error: "template_unsupported" };
    if (kind === "audio" && trun.flags & (TRUN_SAMPLE_DURATION | TRUN_SAMPLE_CTS)) {
      return { error: "template_unsupported" };
    }
    return {
      kind,
      trackId: traf.trackId,
      tfhdFlags: traf.tfhdFlags,
      sampleDescriptionIndex: traf.sampleDescriptionIndex,
      defaultDuration: traf.defaultDuration,
      defaultSize: traf.defaultSize,
      defaultFlags: traf.defaultFlags,
      tfdtVersion: traf.tfdtVersion,
      trunVersion: trun.version,
      trunFlags: trun.flags,
      firstSampleFlags: trun.firstSampleFlags
    };
  }
  function sameTrafShape(left, right) {
    return left.trackId === right.trackId && left.tfhdFlags === right.tfhdFlags && left.sampleDescriptionIndex === right.sampleDescriptionIndex && left.defaultDuration === right.defaultDuration && left.defaultSize === right.defaultSize && left.defaultFlags === right.defaultFlags && left.tfdtVersion === right.tfdtVersion && left.trun.version === right.trun.version && left.trun.flags === right.trun.flags;
  }
  function calibrateFromSegment(segmentBytes, frameWindow) {
    const fragments = parseMediaSegment(segmentBytes);
    if (fragments.some((fragment) => fragment.trafs.length < 2)) return { ok: false, reason: "track_missing" };
    const first = fragments[0];
    for (const fragment of fragments) {
      if (fragment.trafs.length !== 2) return { ok: false, reason: "template_unsupported" };
      for (let index = 0; index < 2; index += 1) {
        if (!sameTrafShape(first.trafs[index], fragment.trafs[index])) return { ok: false, reason: "template_unsupported" };
      }
    }
    const kinds = first.trafs.map((traf) => {
      if (matchFrameRun(frameWindow.video, traf.samples) !== -1) return "video";
      if (matchFrameRun(frameWindow.audio, traf.samples) !== -1) return "audio";
      return void 0;
    });
    if (kinds.includes(void 0)) return { ok: false, reason: "frames_not_found" };
    if (!kinds.includes("video") || !kinds.includes("audio")) return { ok: false, reason: "template_unsupported" };
    const videoIndex = kinds.indexOf("video");
    const audioIndex = kinds.indexOf("audio");
    const videoSamples = fragments.flatMap((fragment) => fragment.trafs[videoIndex].samples);
    const audioTrafs = fragments.map((fragment) => fragment.trafs[audioIndex]);
    const audioSamples = audioTrafs.flatMap((traf) => traf.samples);
    const videoStart = matchFrameRun(frameWindow.video, videoSamples);
    const audioStart = matchFrameRun(frameWindow.audio, audioSamples);
    if (videoStart === -1 || audioStart === -1) return { ok: false, reason: "frames_not_found" };
    const template = [];
    for (const [index, kind] of kinds.entries()) {
      const shape = trafTemplate(first.trafs[index], kind);
      if (shape.error !== void 0) return { ok: false, reason: shape.error };
      template.push(shape);
    }
    const videoTemplate = template[videoIndex];
    const keyFlags = { key: SYNC_SAMPLE_FLAGS, nonKey: videoTemplate.defaultFlags };
    let frameCursor = videoStart;
    for (const fragment of fragments) {
      const traf = fragment.trafs[videoIndex];
      if (traf.trun.firstSampleFlags !== void 0) {
        if (frameWindow.video[frameCursor].key) keyFlags.key = traf.trun.firstSampleFlags;
        else keyFlags.nonKey = traf.trun.firstSampleFlags;
      }
      frameCursor += traf.samples.length;
    }
    videoTemplate.keyFlags = keyFlags;
    let grid = HALF_FRAME_TICKS;
    for (const sample of videoSamples) grid = gcd(gcd(grid, sample.duration), sample.cts);
    const anchor = frameWindow.video[videoStart];
    const timing = {
      video: {
        base: videoSamples[0].time,
        flvTs: anchor.ts,
        ptsBase: videoSamples[0].time + videoSamples[0].cts,
        flvPts: anchor.ts + anchor.cts,
        grid
      },
      audio: { base: audioTrafs[0].baseTime, flvTs: frameWindow.audio[audioStart].ts, grids: [] }
    };
    for (const [offset, sample] of videoSamples.entries()) {
      const frame = frameWindow.video[videoStart + offset];
      if (videoDecodeTime(timing, frame) !== sample.time || videoPresentationTime(timing, frame) !== sample.time + sample.cts) {
        return { ok: false, reason: "timing_mismatch" };
      }
    }
    let audioCursor = audioStart;
    const audioStarts = audioTrafs.map((traf) => {
      const frame = frameWindow.audio[audioCursor];
      audioCursor += traf.samples.length;
      return { frame, time: traf.baseTime };
    });
    for (const candidate of [AUDIO_TICKS_PER_MS, template[audioIndex].defaultDuration]) {
      if (audioStarts.every(({ frame, time }) => audioTime(timing, frame, candidate) === time)) {
        timing.audio.grids.push(candidate);
      }
    }
    if (timing.audio.grids.length === 0) return { ok: false, reason: "timing_mismatch" };
    return {
      ok: true,
      calibration: { template, timing },
      segment: {
        seq: first.seq,
        fragmentCount: fragments.length,
        startTs: anchor.ts
      }
    };
  }
  function planSegment(video, startIndex, timing) {
    const segmentStart = videoDecodeTime(timing, video[startIndex]);
    const fragmentStarts = [startIndex];
    let fragmentStart = segmentStart;
    for (let index = startIndex + 1; index < video.length; index += 1) {
      const decodeTime = videoDecodeTime(timing, video[index]);
      if (video[index].key || decodeTime - segmentStart >= SEGMENT_TICKS) return { endIndex: index, fragmentStarts };
      if (decodeTime - fragmentStart >= FRAGMENT_TICKS) {
        fragmentStarts.push(index);
        fragmentStart = decodeTime;
      }
    }
    return void 0;
  }
  function audioBefore(timing, audioFrame, audioGrid, videoFrame) {
    const audioScaled = audioTime(timing, audioFrame, audioGrid) * VIDEO_TICKS_PER_MS;
    const videoScaled = videoDecodeTime(timing, videoFrame) * AUDIO_TICKS_PER_MS;
    if (audioScaled !== videoScaled) return audioScaled < videoScaled;
    return audioFrame.order < videoFrame.order;
  }
  function locateSegmentStart(video, timing, aux) {
    for (let index = 0; index < video.length; index += 1) {
      const frame = video[index];
      if (frame.key !== aux.key) continue;
      if (Math.abs(videoPresentationTime(timing, frame) / VIDEO_TICKS_PER_MS - aux.ptsMs) <= 1) return index;
    }
    return -1;
  }
  var ByteWriter = class {
    constructor(size) {
      this.bytes = new Uint8Array(size);
      this.view = new DataView(this.bytes.buffer);
      this.offset = 0;
    }
    u8(value) {
      this.view.setUint8(this.offset, value);
      this.offset += 1;
    }
    u24(value) {
      this.u8(value >>> 16 & 255);
      this.u8(value >>> 8 & 255);
      this.u8(value & 255);
    }
    u32(value) {
      this.view.setUint32(this.offset, value >>> 0);
      this.offset += 4;
    }
    i32(value) {
      this.view.setInt32(this.offset, value);
      this.offset += 4;
    }
    u64(value) {
      this.u32(Math.floor(value / 2 ** 32));
      this.u32(value % 2 ** 32);
    }
    type(name) {
      for (const char of name) this.u8(char.charCodeAt(0));
    }
    raw(bytes) {
      this.bytes.set(bytes, this.offset);
      this.offset += bytes.byteLength;
    }
  };
  function trafSize(shape, sampleCount) {
    let tfhd = 16;
    for (const flag of [TFHD_SAMPLE_DESCRIPTION_INDEX, TFHD_DEFAULT_DURATION, TFHD_DEFAULT_SIZE, TFHD_DEFAULT_FLAGS]) {
      if (shape.tfhdFlags & flag) tfhd += 4;
    }
    const tfdt = shape.tfdtVersion === 1 ? 20 : 16;
    let entry = 0;
    for (const flag of [TRUN_SAMPLE_DURATION, TRUN_SAMPLE_SIZE, TRUN_SAMPLE_CTS]) {
      if (shape.trunFlags & flag) entry += 4;
    }
    let trunHead = 20;
    if (shape.trunFlags & TRUN_FIRST_SAMPLE_FLAGS) trunHead += 4;
    return 8 + tfhd + tfdt + trunHead + entry * sampleCount;
  }
  function writeFullBoxHeader(writer, size, type, version, flags) {
    writer.u32(size);
    writer.type(type);
    writer.u8(version);
    writer.u24(flags);
  }
  function writeTraf(writer, shape, track, dataOffset) {
    const start = writer.offset;
    const size = trafSize(shape, track.samples.length);
    writer.u32(size);
    writer.type("traf");
    let tfhdSize = 16;
    for (const flag of [TFHD_SAMPLE_DESCRIPTION_INDEX, TFHD_DEFAULT_DURATION, TFHD_DEFAULT_SIZE, TFHD_DEFAULT_FLAGS]) {
      if (shape.tfhdFlags & flag) tfhdSize += 4;
    }
    writeFullBoxHeader(writer, tfhdSize, "tfhd", 0, shape.tfhdFlags);
    writer.u32(shape.trackId);
    if (shape.tfhdFlags & TFHD_SAMPLE_DESCRIPTION_INDEX) writer.u32(shape.sampleDescriptionIndex);
    if (shape.tfhdFlags & TFHD_DEFAULT_DURATION) writer.u32(shape.defaultDuration);
    if (shape.tfhdFlags & TFHD_DEFAULT_SIZE) writer.u32(shape.defaultSize);
    if (shape.tfhdFlags & TFHD_DEFAULT_FLAGS) writer.u32(shape.defaultFlags);
    writeFullBoxHeader(writer, shape.tfdtVersion === 1 ? 20 : 16, "tfdt", shape.tfdtVersion, 0);
    if (shape.tfdtVersion === 1) writer.u64(track.baseTime);
    else writer.u32(track.baseTime);
    writeFullBoxHeader(writer, start + size - writer.offset, "trun", shape.trunVersion, shape.trunFlags);
    writer.u32(track.samples.length);
    writer.i32(dataOffset);
    if (shape.trunFlags & TRUN_FIRST_SAMPLE_FLAGS) writer.u32(track.firstSampleFlags);
    for (const sample of track.samples) {
      if (shape.trunFlags & TRUN_SAMPLE_DURATION) writer.u32(sample.duration);
      if (shape.trunFlags & TRUN_SAMPLE_SIZE) writer.u32(sample.data.byteLength);
      if (shape.trunFlags & TRUN_SAMPLE_CTS) writer.i32(sample.cts);
    }
  }
  function buildFragment(template, seq, tracks) {
    const moofSize = 8 + 16 + template.reduce((sum, shape, index) => sum + trafSize(shape, tracks[index].samples.length), 0);
    const payloadSizes = tracks.map((track) => track.samples.reduce((sum, sample) => sum + sample.data.byteLength, 0));
    const mdatSize = 8 + payloadSizes.reduce((sum, size) => sum + size, 0);
    const writer = new ByteWriter(moofSize + mdatSize);
    writer.u32(moofSize);
    writer.type("moof");
    writeFullBoxHeader(writer, 16, "mfhd", 0, 0);
    writer.u32(seq);
    let dataOffset = moofSize + 8;
    for (const [index, shape] of template.entries()) {
      writeTraf(writer, shape, tracks[index], dataOffset);
      dataOffset += payloadSizes[index];
    }
    writer.u32(mdatSize);
    writer.type("mdat");
    for (const track of tracks) for (const sample of track.samples) writer.raw(sample.data);
    return writer.bytes;
  }
  function buildSegment({ frameWindow, calibration, startIndex, plan, seq, audioGrid }) {
    const { template, timing } = calibration;
    const { video, audio } = frameWindow;
    const bounds = [...plan.fragmentStarts, plan.endIndex];
    let audioCursor = 0;
    while (audioCursor < audio.length && audioBefore(timing, audio[audioCursor], audioGrid, video[bounds[0]])) {
      audioCursor += 1;
    }
    const pieces = [];
    for (let fragmentIndex = 0; fragmentIndex < plan.fragmentStarts.length; fragmentIndex += 1) {
      const videoFrames = video.slice(bounds[fragmentIndex], bounds[fragmentIndex + 1]);
      const audioFrames = [];
      while (audioCursor < audio.length && audioBefore(timing, audio[audioCursor], audioGrid, video[bounds[fragmentIndex + 1]])) {
        audioFrames.push(audio[audioCursor]);
        audioCursor += 1;
      }
      if (audioFrames.length === 0) return void 0;
      const decodeTimes = [...videoFrames, video[bounds[fragmentIndex + 1]]].map((frame) => videoDecodeTime(timing, frame));
      const tracks = template.map((shape) => {
        if (shape.kind === "video") {
          return {
            baseTime: decodeTimes[0],
            firstSampleFlags: videoFrames[0].key ? shape.keyFlags.key : shape.keyFlags.nonKey,
            samples: videoFrames.map((frame, index) => ({
              data: frame.data,
              duration: decodeTimes[index + 1] - decodeTimes[index],
              cts: videoPresentationTime(timing, frame) - decodeTimes[index]
            }))
          };
        }
        return {
          baseTime: audioTime(timing, audioFrames[0], audioGrid),
          firstSampleFlags: shape.firstSampleFlags,
          samples: audioFrames.map((frame) => ({ data: frame.data }))
        };
      });
      pieces.push(buildFragment(template, seq + fragmentIndex, tracks));
    }
    const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const piece of pieces) {
      bytes.set(piece, offset);
      offset += piece.byteLength;
    }
    return bytes;
  }
  function rebuildSegment({ frameWindow, calibration, aux, seq, startIndex }) {
    const { timing } = calibration;
    const { video, audio } = frameWindow;
    const plan = planSegment(video, startIndex, timing);
    if (plan === void 0) return { status: "waiting" };
    const boundary = video[plan.endIndex];
    const grids = timing.audio.grids;
    const lastAudio = audio.at(-1);
    if (lastAudio === void 0 || grids.some((grid) => audioBefore(timing, lastAudio, grid, boundary))) {
      return { status: "waiting" };
    }
    let mismatchBytes = 0;
    for (const grid of grids) {
      const bytes = buildSegment({ frameWindow, calibration, startIndex, plan, seq, audioGrid: grid });
      if (bytes === void 0) continue;
      if (bytes.byteLength === aux.size && crc32(bytes) === aux.crc) {
        return { status: "verified", bytes, fragmentCount: plan.fragmentStarts.length, audioGrid: grid };
      }
      mismatchBytes = bytes.byteLength;
    }
    return { status: "mismatch", bytes: mismatchBytes };
  }
  function segmentStartState(video, timing, aux) {
    const index = locateSegmentStart(video, timing, aux);
    if (index !== -1) return { state: "found", index };
    if (video.length === 0) return { state: "waiting" };
    const oldestMs = videoDecodeTime(timing, video[0]) / VIDEO_TICKS_PER_MS;
    const newestMs = videoDecodeTime(timing, video.at(-1)) / VIDEO_TICKS_PER_MS;
    if (aux.ptsMs < oldestMs || newestMs > aux.ptsMs + SEGMENT_TICKS / VIDEO_TICKS_PER_MS) return { state: "missing" };
    return { state: "waiting" };
  }
  var FlvSegmentRebuilder = class {
    constructor({ windowMs }) {
      this.windowMs = windowMs;
      this.video = [];
      this.audio = [];
      this.calibration = void 0;
      this.chain = /* @__PURE__ */ new Map();
    }
    get frameWindow() {
      return { video: this.video, audio: this.audio };
    }
    get calibrated() {
      return this.calibration !== void 0;
    }
    reset() {
      this.video = [];
      this.audio = [];
      this.calibration = void 0;
      this.chain.clear();
    }
    resetCalibration() {
      this.calibration = void 0;
      this.chain.clear();
    }
    appendFrames(frames) {
      for (const frame of frames) (frame.kind === "video" ? this.video : this.audio).push(frame);
      const newest = Math.max(this.video.at(-1)?.ts ?? 0, this.audio.at(-1)?.ts ?? 0);
      const cutoff = newest - this.windowMs;
      let videoDrop = 0;
      while (videoDrop < this.video.length && this.video[videoDrop].ts < cutoff) videoDrop += 1;
      if (videoDrop > 0) this.video.splice(0, videoDrop);
      let audioDrop = 0;
      while (audioDrop < this.audio.length && this.audio[audioDrop].ts < cutoff) audioDrop += 1;
      if (audioDrop > 0) this.audio.splice(0, audioDrop);
    }
    recordSegment(msn, record) {
      this.chain.set(msn, record);
      for (const known of this.chain.keys()) {
        if (known < msn - 128) this.chain.delete(known);
      }
    }
    // 网络送达的真分片：未校准时拿它校准，已校准时记入分片链。
    noteRealSegment(aux, bytes) {
      if (this.calibration === void 0) {
        const result = calibrateFromSegment(bytes, this.frameWindow);
        if (!result.ok) return { calibrated: false, reason: result.reason };
        this.calibration = result.calibration;
        this.recordSegment(aux.msn, result.segment);
        return { calibrated: true };
      }
      const fragments = parseMediaSegment(bytes);
      const startIndex = locateSegmentStart(this.video, this.calibration.timing, aux);
      this.recordSegment(aux.msn, {
        seq: fragments[0].seq,
        fragmentCount: fragments.length,
        startTs: startIndex === -1 ? void 0 : this.video[startIndex].ts
      });
      return { calibrated: false };
    }
    seqFor(msn) {
      const previous = this.chain.get(msn - 1);
      if (previous !== void 0) return previous.seq + previous.fragmentCount;
      let anchorMsn;
      for (const [known, record] of this.chain) {
        if (known < msn && record.startTs !== void 0 && (anchorMsn === void 0 || known > anchorMsn)) anchorMsn = known;
      }
      if (anchorMsn === void 0) return void 0;
      const anchor = this.chain.get(anchorMsn);
      let index = this.video.findIndex((frame) => frame.ts === anchor.startTs);
      if (index === -1) return void 0;
      let seq = anchor.seq;
      for (let current = anchorMsn; current < msn; current += 1) {
        const plan = planSegment(this.video, index, this.calibration.timing);
        if (plan === void 0) return void 0;
        seq += plan.fragmentStarts.length;
        index = plan.endIndex;
      }
      return seq;
    }
    // 一次拼接尝试：waiting / frames_missing / verified（bytes）/ mismatch（bytes 为长度）。
    attempt(aux) {
      const start = segmentStartState(this.video, this.calibration.timing, aux);
      if (start.state === "waiting") return { status: "waiting" };
      if (start.state === "missing") return { status: "frames_missing" };
      const seq = this.seqFor(aux.msn);
      if (seq === void 0) return { status: "frames_missing" };
      const result = rebuildSegment({
        frameWindow: this.frameWindow,
        calibration: this.calibration,
        aux,
        seq,
        startIndex: start.index
      });
      if (result.status === "verified") {
        this.calibration.timing.audio.grids = [result.audioGrid];
        this.recordSegment(aux.msn, {
          seq,
          fragmentCount: result.fragmentCount,
          startTs: this.video[start.index].ts
        });
      }
      return result;
    }
  };

  // src/bank/live.js
  function isLiveLocation(locationObject) {
    return locationObject !== void 0 && locationObject.hostname === "live.bilibili.com";
  }
  function isLivePlayurlUrl(url) {
    const parsed = new URL(url);
    return parsed.hostname === "api.live.bilibili.com" && parsed.pathname.endsWith("/getRoomPlayInfo");
  }
  function classifyLiveRequest({ url, enabled = true, locationObject }) {
    if (enabled !== true) return { intercepted: false };
    const parsed = new URL(url, locationObject?.href);
    if (!isMediaHost(parsed.hostname)) return { intercepted: false, reason: "non_media_host" };
    if (parsed.pathname.endsWith(".flv")) {
      return { intercepted: true, url: parsed.href, kind: "flv_stream" };
    }
    if (parsed.pathname.endsWith(".m3u8")) return { intercepted: false, reason: "live_hls_playlist" };
    if (parsed.pathname.endsWith(".m4s") || parsed.pathname.endsWith(".ts")) {
      return { intercepted: true, url: parsed.href, kind: "hls_segment" };
    }
    return { intercepted: false, reason: "live_other_media" };
  }
  function hlsStreamPathOf(pathname) {
    if (typeof pathname !== "string" || pathname.length === 0 || !pathname.startsWith("/")) {
      throw new Error("HLS 分片路径无效");
    }
    const cut = pathname.lastIndexOf("/");
    return pathname.slice(0, cut + 1);
  }
  function hlsStreamNameOf(streamPath) {
    return streamPath.split("/").filter((part) => part.length > 0).at(-1);
  }
  function flvStreamNameOf(pathname) {
    if (!pathname.endsWith(".flv")) throw new Error(`不是 FLV 路径: ${pathname}`);
    return pathname.slice(pathname.lastIndexOf("/") + 1, -".flv".length);
  }
  function compareSegmentBytes(left, right) {
    if (left.byteLength !== right.byteLength) {
      const common = Math.min(left.byteLength, right.byteLength);
      for (let index = 0; index < common; index += 1) {
        if (left[index] !== right[index]) return index;
      }
      return common;
    }
    return compareByteRegions(left, right);
  }
  function hlsSegmentPairUrl(playerUrl, candidateUrl) {
    const streamPath = hlsStreamPathOf(playerUrl.pathname);
    const segmentName = playerUrl.pathname.slice(streamPath.length);
    const search = playerUrl.search !== "" ? candidateUrl.search : "";
    return `${candidateUrl.origin}${streamPath}${segmentName}${search}`;
  }
  function liveUrlExpiresAt(url) {
    const raw = new URL(url).searchParams.get("expires");
    if (raw === null) return void 0;
    const expires = Number(raw);
    if (!Number.isSafeInteger(expires) || expires <= 0) return void 0;
    return expires * 1e3;
  }
  function urlFromLiveUrlInfo(info, groupBaseUrl) {
    if (typeof info.url === "string") return info.url;
    const baseUrl = typeof info.base_url === "string" ? info.base_url : groupBaseUrl;
    if (typeof info.host !== "string" || typeof baseUrl !== "string" || typeof info.extra !== "string") {
      throw new Error("直播 playurl 地址簿条目缺少 host/base_url/extra");
    }
    if (baseUrl.endsWith("?") || info.extra.startsWith("?") || info.extra.startsWith("&")) {
      return `${info.host}${baseUrl}${info.extra}`;
    }
    return `${info.host}${baseUrl}?${info.extra}`;
  }
  function visitLiveUrlInfoGroups(value, callback) {
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visitLiveUrlInfoGroups(item, callback);
      return;
    }
    if (Array.isArray(value.url_info)) {
      const group = [];
      for (const info of value.url_info) {
        if (info === null || typeof info !== "object") continue;
        group.push({ host: info.host, base_url: info.base_url, extra: info.extra, url: info.url });
      }
      if (group.length > 0) callback(group, value.base_url, value.codec_name);
    }
    for (const child of Object.values(value)) visitLiveUrlInfoGroups(child, callback);
  }
  function compareByteRegions(left, right) {
    const length = Math.min(left.byteLength, right.byteLength);
    for (let index = 0; index < length; index += 1) {
      if (left[index] !== right[index]) return index;
    }
    return -1;
  }
  var LiveStreamStitcher = class {
    constructor({
      streamPath,
      legs,
      chunkBytes = BANK_CONFIG.chunkBytes,
      now = Date.now,
      emitChunk,
      emitStitch,
      deliver,
      cancelLeg,
      failStream,
      closeStream
    }) {
      if (!Array.isArray(legs) || legs.length < 1 || legs.length > 2) {
        throw new Error("直播流腿数必须是 1 或 2");
      }
      this.streamPath = streamPath;
      this.chunkBytes = chunkBytes;
      this.now = now;
      this.callbacks = { emitChunk, emitStitch, deliver, cancelLeg, failStream, closeStream };
      this.bytesChecked = 0;
      this.closed = false;
      this.completionSequence = 0;
      this.deliveredOffset = 0;
      this.deliveredWindows = /* @__PURE__ */ new Map();
      this.state = legs.length === 2 ? "gating" : "single";
      this.gateCompared = 0;
      this.legs = legs.map((meta) => ({
        slot: meta.slot,
        source: meta.source,
        mirror: meta.mirror,
        receivedTotal: 0,
        currentWindow: new Uint8Array(chunkBytes),
        windowFilled: 0,
        windowStartedAt: void 0,
        reportedInWindow: 0,
        ahead: /* @__PURE__ */ new Map(),
        startedAt: this.now(),
        ttfbAt: void 0,
        done: false,
        dead: false
      }));
    }
    legFor(slot) {
      return this.legs.find((leg) => leg.slot === slot);
    }
    noteLegBytes(slot, chunk) {
      if (this.closed) return;
      const leg = this.legFor(slot);
      if (leg === void 0 || leg.dead || leg.done) {
        throw new Error("直播腿结束后仍收到字节");
      }
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
        throw new Error("直播腿字节必须是长度大于零的 Uint8Array");
      }
      if (leg.ttfbAt === void 0) leg.ttfbAt = this.now();
      let view = chunk;
      while (view.byteLength > 0) {
        const windowIndex = chunkIndex(leg.receivedTotal, this.chunkBytes);
        if (leg.windowStartedAt === void 0) leg.windowStartedAt = this.now();
        const portion = Math.min(this.chunkBytes - leg.windowFilled, view.byteLength);
        leg.currentWindow.set(view.subarray(0, portion), leg.windowFilled);
        leg.windowFilled += portion;
        leg.receivedTotal += portion;
        view = view.subarray(portion);
        if (leg.windowFilled === this.chunkBytes) this.completeWindow(leg, windowIndex);
      }
      this.progress();
    }
    noteLegDone(slot) {
      if (this.closed) return;
      const leg = this.legFor(slot);
      if (leg === void 0 || leg.dead || leg.done) {
        throw new Error("直播腿重复结束");
      }
      if (leg.windowFilled > 0) {
        const windowIndex = chunkIndex(leg.receivedTotal, this.chunkBytes);
        const bytes = leg.currentWindow.slice(0, leg.windowFilled);
        this.completionSequence += 1;
        leg.ahead.set(windowIndex, {
          bytes,
          seq: this.completionSequence,
          startedAt: leg.windowStartedAt ?? leg.startedAt
        });
        leg.currentWindow = new Uint8Array(this.chunkBytes);
        leg.windowFilled = 0;
        leg.reportedInWindow = 0;
        leg.windowStartedAt = void 0;
      }
      leg.done = true;
      if (this.state === "gating") {
        if (this.legs.every((candidate) => candidate.done)) {
          this.resolveGateOnAllDone();
        } else if (leg.receivedTotal < this.chunkBytes) {
          this.reportLegUnreported(leg, "lost_race");
          this.legs.splice(this.legs.indexOf(leg), 1);
          this.state = "single";
        }
      }
      this.progress();
    }
    noteLegDead(slot, outcome, detail = {}) {
      if (this.closed) return;
      const leg = this.legFor(slot);
      if (leg === void 0 || leg.dead || leg.done) {
        throw new Error("直播腿重复死亡");
      }
      leg.dead = true;
      this.reportLegUnreported(leg, outcome, detail);
      for (const delivered of this.deliveredWindows.values()) delivered.compared.add(slot);
      this.legs.splice(this.legs.indexOf(leg), 1);
      if (this.state === "gating") {
        this.state = "single";
      }
      if (this.legs.length === 0) {
        this.failStreamNow();
        return;
      }
      if (this.legs.length === 1) this.state = "single";
      this.progress();
    }
    abortStream() {
      if (this.closed) return;
      for (const leg of this.legs) this.reportLegUnreported(leg, "aborted");
      this.legs = [];
      this.deliveredWindows.clear();
      this.closed = true;
    }
    completeWindow(leg, windowIndex) {
      const bytes = leg.currentWindow;
      leg.currentWindow = new Uint8Array(this.chunkBytes);
      this.completionSequence += 1;
      leg.ahead.set(windowIndex, {
        bytes,
        seq: this.completionSequence,
        startedAt: leg.windowStartedAt ?? leg.startedAt
      });
      leg.windowFilled = 0;
      leg.reportedInWindow = 0;
      leg.windowStartedAt = void 0;
    }
    regionOf(leg, windowIndex) {
      const entry = leg.ahead.get(windowIndex);
      if (entry !== void 0) return entry.bytes;
      return leg.currentWindow.subarray(0, leg.windowFilled);
    }
    emitChunkNow(leg, windowIndex, result, bytes, entry, detail = {}) {
      const start = windowIndex * this.chunkBytes;
      const startedAt = entry?.startedAt ?? leg.windowStartedAt;
      const payload = {
        slot: leg.slot,
        source: leg.source,
        mirror: leg.mirror,
        chunkIndex: windowIndex,
        start,
        end: bytes > 0 ? start + bytes - 1 : start,
        bytes,
        durationMs: startedAt === void 0 ? 0 : this.now() - startedAt,
        result
      };
      if (windowIndex === 0 && leg.ttfbAt !== void 0) payload.ttfbMs = leg.ttfbAt - leg.startedAt;
      if (Number.isInteger(detail.httpStatus)) payload.httpStatus = detail.httpStatus;
      if (typeof detail.errorName === "string" && detail.errorName.length > 0) payload.errorName = detail.errorName;
      this.callbacks.emitChunk(payload);
    }
    emitLegWindowEvent(leg, result, detail) {
      const windowIndex = chunkIndex(leg.receivedTotal, this.chunkBytes);
      const bytes = leg.windowFilled - leg.reportedInWindow;
      leg.reportedInWindow = leg.windowFilled;
      this.emitChunkNow(leg, windowIndex, result, bytes, void 0, detail);
    }
    reportLegUnreported(leg, result, detail = {}) {
      const indices = [...leg.ahead.keys()].sort((left, right) => left - right);
      for (const windowIndex of indices) {
        const entry = leg.ahead.get(windowIndex);
        this.emitChunkNow(leg, windowIndex, result, entry.bytes.byteLength, entry, detail);
        leg.ahead.delete(windowIndex);
      }
      this.emitLegWindowEvent(leg, result, detail);
    }
    emitStitchNow(mismatch, phase) {
      this.callbacks.emitStitch({
        streamPath: this.streamPath,
        bytesChecked: this.bytesChecked,
        mismatch,
        phase
      });
    }
    failStreamNow() {
      if (this.closed) return;
      this.closed = true;
      this.callbacks.failStream();
    }
    progress() {
      if (this.closed) return;
      if (this.state === "gating") this.progressGate();
      if (this.closed || this.state === "gating") return;
      if (this.state === "racing") this.progressRacing();
      if (this.closed) return;
      if (this.state === "single") this.progressSingle();
      if (this.closed) return;
      this.checkFinish();
    }
    progressGate() {
      if (this.legs.length !== 2) return;
      const [first, second] = this.legs;
      for (; ; ) {
        const limit = Math.min(first.receivedTotal, second.receivedTotal, this.chunkBytes);
        if (limit <= this.gateCompared) break;
        const start = this.gateCompared;
        const left = this.regionOf(first, 0).subarray(start, limit);
        const right = this.regionOf(second, 0).subarray(start, limit);
        const mismatchAt = compareByteRegions(left, right);
        if (mismatchAt !== -1) {
          this.bytesChecked += mismatchAt + 1;
          this.gateCompared += mismatchAt + 1;
          this.emitStitchNow(true, "prefix");
          this.degradeToSingle(first.slot);
          return;
        }
        this.bytesChecked += limit - start;
        this.gateCompared = limit;
      }
      if (this.gateCompared >= this.chunkBytes) {
        this.state = "racing";
        this.emitStitchNow(false, "prefix");
      }
    }
    resolveGateOnAllDone() {
      const [first, second] = this.legs;
      const common = Math.min(first.receivedTotal, second.receivedTotal);
      if (common > this.gateCompared) {
        const left = this.regionOf(first, 0).subarray(this.gateCompared, common);
        const right = this.regionOf(second, 0).subarray(this.gateCompared, common);
        const mismatchAt = compareByteRegions(left, right);
        if (mismatchAt !== -1) {
          this.bytesChecked += mismatchAt + 1;
          this.emitStitchNow(true, "prefix");
          this.degradeToSingle(first.slot);
          return;
        }
        this.bytesChecked += common - this.gateCompared;
      }
      if (first.receivedTotal !== second.receivedTotal) {
        this.emitStitchNow(true, "prefix");
        this.degradeToSingle(first.slot);
        return;
      }
      this.state = "racing";
      this.emitStitchNow(false, "prefix");
    }
    degradeToSingle(keepSlot) {
      const keep = this.legs.find((leg) => leg.slot === keepSlot && !leg.dead);
      if (keep === void 0) {
        this.failStreamNow();
        return;
      }
      for (const leg of [...this.legs]) {
        if (leg === keep || leg.dead) continue;
        this.reportLegUnreported(leg, "lost_race");
        leg.dead = true;
        this.legs.splice(this.legs.indexOf(leg), 1);
        this.callbacks.cancelLeg(leg.slot);
      }
      this.deliveredWindows.clear();
      this.state = "single";
    }
    progressRacing() {
      if (this.state !== "racing") return;
      for (; ; ) {
        const windowIndex = chunkIndex(this.deliveredOffset, this.chunkBytes);
        const start = windowIndex * this.chunkBytes;
        let winner;
        for (const leg of this.legs) {
          if (leg.dead) continue;
          const entry = leg.ahead.get(windowIndex);
          if (entry === void 0) continue;
          if (winner === void 0 || entry.seq < winner.entry.seq) winner = { leg, entry };
        }
        if (winner === void 0) break;
        const end = start + winner.entry.bytes.byteLength - 1;
        this.emitChunkNow(winner.leg, windowIndex, "fetched", winner.entry.bytes.byteLength, winner.entry);
        for (const other of this.legs) {
          if (other === winner.leg || other.dead) continue;
          const otherEntry = other.ahead.get(windowIndex);
          if (otherEntry !== void 0) {
            this.emitChunkNow(other, windowIndex, "lost_race", otherEntry.bytes.byteLength, otherEntry);
          } else if (!other.done) {
            this.emitLegWindowEvent(other, "lost_race");
          }
        }
        this.callbacks.deliver(winner.entry.bytes.slice(), start, end);
        this.deliveredOffset = end + 1;
        winner.leg.ahead.delete(windowIndex);
        this.deliveredWindows.set(windowIndex, {
          bytes: winner.entry.bytes,
          winnerSlot: winner.leg.slot,
          compared: /* @__PURE__ */ new Set([winner.leg.slot])
        });
        this.progressTripwire();
        if (this.closed || this.state !== "racing") return;
      }
      this.progressTripwire();
    }
    progressTripwire() {
      if (this.closed || this.state !== "racing") return;
      for (const [windowIndex, delivered] of [...this.deliveredWindows]) {
        for (const leg of this.legs) {
          if (leg.dead || leg.slot === delivered.winnerSlot || delivered.compared.has(leg.slot)) continue;
          const entry = leg.ahead.get(windowIndex);
          if (entry === void 0) continue;
          const mismatchAt = compareByteRegions(entry.bytes, delivered.bytes);
          this.bytesChecked += mismatchAt === -1 ? delivered.bytes.byteLength : mismatchAt + 1;
          delivered.compared.add(leg.slot);
          leg.ahead.delete(windowIndex);
          if (mismatchAt === -1) continue;
          this.emitStitchNow(true, "stream");
          const winner = this.legFor(delivered.winnerSlot);
          if (winner === void 0 || winner.dead) {
            this.failStreamNow();
            return;
          }
          this.degradeToSingle(winner.slot);
          return;
        }
        const open = this.legs.some((leg) => {
          if (leg.dead || leg.slot === delivered.winnerSlot || delivered.compared.has(leg.slot)) return false;
          return !leg.done || leg.ahead.has(windowIndex);
        });
        if (!open) this.deliveredWindows.delete(windowIndex);
      }
    }
    progressSingle() {
      const leg = this.legs[0];
      if (leg === void 0) return;
      while (this.deliveredOffset < leg.receivedTotal) {
        const windowIndex = chunkIndex(this.deliveredOffset, this.chunkBytes);
        const start = windowIndex * this.chunkBytes;
        const targetEnd = Math.min(leg.receivedTotal, start + this.chunkBytes);
        const region = this.regionOf(leg, windowIndex);
        const piece = region.subarray(this.deliveredOffset - start, targetEnd - start);
        this.callbacks.deliver(piece.slice(), this.deliveredOffset, targetEnd - 1);
        this.deliveredOffset = targetEnd;
        if (targetEnd === start + this.chunkBytes) {
          this.emitChunkNow(leg, windowIndex, "fetched", targetEnd - start, leg.ahead.get(windowIndex));
          leg.ahead.delete(windowIndex);
        }
      }
      if (leg.done && this.deliveredOffset === leg.receivedTotal && leg.receivedTotal % this.chunkBytes !== 0) {
        const windowIndex = chunkIndex(leg.receivedTotal, this.chunkBytes);
        this.emitChunkNow(
          leg,
          windowIndex,
          "fetched",
          leg.receivedTotal - windowIndex * this.chunkBytes,
          leg.ahead.get(windowIndex)
        );
        leg.ahead.delete(windowIndex);
      }
    }
    checkFinish() {
      if (this.closed || this.legs.length === 0) return;
      if (!this.legs.every((leg) => leg.done)) return;
      if (this.state === "gating") return;
      this.deliveredWindows.clear();
      this.closed = true;
      this.callbacks.closeStream();
    }
  };

  // src/bank/flv-backup.js
  var FlvRebuildFailure = class extends Error {
    constructor(result, bytes = 0) {
      super(`FLV 后备拼接未交付: ${result}`);
      this.name = "FlvRebuildFailure";
      this.result = result;
      this.bytes = bytes;
    }
  };
  function abortError() {
    return new DOMException("The operation was aborted", "AbortError");
  }
  var LiveFlvBackup = class {
    constructor({
      hlsStreamPath,
      resolveUrls,
      fetchImpl,
      credentials,
      timers,
      now,
      emitState,
      reportError,
      config
    }) {
      this.hlsStreamPath = hlsStreamPath;
      this.resolveUrls = resolveUrls;
      this.fetchImpl = fetchImpl;
      this.credentials = credentials;
      this.timers = timers;
      this.now = now;
      this.emitStateCallback = emitState;
      this.reportError = reportError;
      this.config = config;
      this.rebuilder = new FlvSegmentRebuilder({ windowMs: config.windowMs });
      this.pending = /* @__PURE__ */ new Set();
      this.closed = false;
      this.reconnects = 0;
      this.attempt = 0;
      this.calibrationFailures = 0;
      this.connection = void 0;
      this.reconnectTimer = void 0;
      this.url = void 0;
      this.lastHeaders = void 0;
    }
    get mirror() {
      return this.url === void 0 ? void 0 : new URL(this.url).hostname;
    }
    get streamPath() {
      return this.url === void 0 ? this.hlsStreamPath : new URL(this.url).pathname;
    }
    get ready() {
      return !this.closed && this.rebuilder.calibrated;
    }
    emitState(state, reason) {
      const payload = { state, streamPath: this.streamPath };
      if (this.mirror !== void 0) payload.mirror = this.mirror;
      if (reason !== void 0) payload.reason = reason;
      this.emitStateCallback(payload);
    }
    // 每次连接现取地址簿（签名可能已更新），跳过已过期的地址，在 Bilibili 给出的地址间轮换。
    pickUrl() {
      const lookup = this.resolveUrls();
      if (lookup.urls === void 0) return { miss: lookup.miss };
      const usable = lookup.urls.filter((url2) => {
        const expiresAt = liveUrlExpiresAt(url2);
        return expiresAt === void 0 || this.now() < expiresAt;
      });
      if (usable.length === 0) return { miss: "address_expired" };
      const url = usable[this.attempt % usable.length];
      this.attempt += 1;
      return { url };
    }
    // 开连接；地址簿里没有可用地址时不开，返回缺失原因（由调用方记 unavailable）。
    start() {
      const picked = this.pickUrl();
      if (picked.url === void 0) return picked.miss;
      this.url = picked.url;
      void this.connect();
      return void 0;
    }
    async connect() {
      const controller = new AbortController();
      const connection = {
        controller,
        stallTimer: void 0,
        reader: void 0,
        firstTs: void 0,
        fullWindow: false,
        stalled: false
      };
      this.connection = connection;
      const tagReader = new FlvTagReader();
      const armStall = () => {
        if (connection.stallTimer !== void 0) this.timers.clearTimeout(connection.stallTimer);
        connection.stallTimer = this.timers.setTimeout(() => {
          connection.stalled = true;
          controller.abort();
          void connection.reader?.cancel().catch((error) => {
            if (error?.name !== "AbortError") this.reportError("FLV 后备停滞读取取消失败", error);
          });
        }, this.config.stallMs);
      };
      armStall();
      let reason;
      let failure;
      try {
        const response = await this.fetchImpl(this.url, { credentials: this.credentials, signal: controller.signal });
        if (response.status < 200 || response.status >= 300) {
          reason = "http_error";
          failure = new Error(`FLV 后备响应状态无效: ${response.status}`);
        } else {
          connection.reader = response.body.getReader();
          for (; ; ) {
            const read = await connection.reader.read();
            if (read.done) break;
            if (read.value.byteLength === 0) continue;
            armStall();
            this.noteFrames(connection, tagReader.push(read.value));
            if (this.closed || this.connection !== connection) return;
          }
          reason = "stream_ended";
        }
      } catch (error) {
        if (this.closed || this.connection !== connection) return;
        if (error instanceof FlvUnsupportedError) {
          if (error.reason !== "flv_no_video") this.reportError("FLV 后备流格式不受支持", error);
          this.emitState("unavailable", error.reason);
          this.close();
          return;
        }
        reason = connection.stalled ? "stalled" : "network_error";
        failure = error;
      } finally {
        if (connection.stallTimer !== void 0) this.timers.clearTimeout(connection.stallTimer);
      }
      if (this.closed || this.connection !== connection) return;
      this.disconnected(reason, failure);
    }
    noteFrames(connection, frames) {
      if (frames.length === 0) return;
      const firstFrames = connection.firstTs === void 0;
      if (firstFrames) connection.firstTs = frames[0].ts;
      this.rebuilder.appendFrames(frames);
      if (firstFrames) this.emitState("connected");
      if (!connection.fullWindow && frames.at(-1).ts - connection.firstTs >= this.config.windowMs) {
        connection.fullWindow = true;
        this.reconnects = 0;
      }
      for (const request of [...this.pending]) this.progressRequest(request);
    }
    // 断线：新连接的时间戳重新起算，窗口、校准与分片链一并作废，等下一个网络分片重新校准。
    disconnected(reason, error) {
      this.connection = void 0;
      this.rebuilder.reset();
      this.failPending("frames_missing");
      if (this.reconnects >= this.config.maxReconnects) {
        this.emitState("given_up", reason);
        this.reportError("FLV 后备连接重连用尽", error ?? new Error(reason));
        this.close();
        return;
      }
      this.reconnects += 1;
      this.emitState("reconnecting", reason);
      this.reconnectTimer = this.timers.setTimeout(() => {
        this.reconnectTimer = void 0;
        if (this.closed) return;
        const picked = this.pickUrl();
        if (picked.url === void 0) {
          this.disconnected(picked.miss, new Error(`FLV 后备无可用地址: ${picked.miss}`));
          return;
        }
        this.url = picked.url;
        void this.connect();
      }, this.config.reconnectDelayMs);
    }
    close() {
      if (this.closed) return;
      this.closed = true;
      if (this.reconnectTimer !== void 0) this.timers.clearTimeout(this.reconnectTimer);
      const connection = this.connection;
      this.connection = void 0;
      if (connection !== void 0) {
        if (connection.stallTimer !== void 0) this.timers.clearTimeout(connection.stallTimer);
        connection.controller.abort();
        void connection.reader?.cancel().catch((error) => {
          if (error?.name !== "AbortError") this.reportError("FLV 后备读取取消失败", error);
        });
      }
      this.failPending("frames_missing");
      this.rebuilder.reset();
    }
    // init 分片的字节变了（换名而字节不变不算）后旧模板作废，等下一个网络分片重新校准。
    resetCalibration() {
      this.rebuilder.resetCalibration();
      this.failPending("frames_missing");
    }
    // 网络送达的真分片：记下响应头（拼接腿胜出时沿用），未校准时拿它校准，已校准时续分片链。
    // 连接供帧满一个窗口后仍连续 maxCalibrationAttempts 个分片校准不上，或分片结构不受支持，
    // 判这条流 unavailable 并关闭连接。
    noteNetworkSegment({ aux, bytes, headers }) {
      this.lastHeaders = headers;
      if (this.closed) return;
      const wasCalibrated = this.rebuilder.calibrated;
      let outcome;
      try {
        outcome = this.rebuilder.noteRealSegment(aux, bytes);
      } catch (error) {
        this.reportError("FLV 后备读取网络分片失败", error);
        return;
      }
      if (wasCalibrated) return;
      if (outcome.calibrated) {
        this.calibrationFailures = 0;
        this.emitState("calibrated");
        return;
      }
      if (outcome.reason !== "template_unsupported") {
        if (this.connection?.fullWindow !== true) return;
        this.calibrationFailures += 1;
        if (this.calibrationFailures < this.config.maxCalibrationAttempts) return;
      }
      this.emitState("unavailable", `calibration_${outcome.reason}`);
      this.close();
    }
    // 拼接腿：返回 { promise, cancel }。promise 以 { bytes } 兑现（字节数与 CRC32 已核对），
    // 或以 FlvRebuildFailure 拒绝；等待最多 stallMs。
    requestSegment(aux) {
      let resolve;
      let reject;
      const promise = new Promise((resolveArg, rejectArg) => {
        resolve = resolveArg;
        reject = rejectArg;
      });
      const request = { aux, resolve, reject, timer: void 0, settled: false };
      request.timer = this.timers.setTimeout(() => {
        this.settle(request, void 0, new FlvRebuildFailure("frames_missing"));
      }, this.config.stallMs);
      this.pending.add(request);
      this.progressRequest(request);
      return {
        promise,
        cancel: () => this.settle(request, void 0, abortError())
      };
    }
    settle(request, value, error) {
      if (request.settled) return;
      request.settled = true;
      this.pending.delete(request);
      this.timers.clearTimeout(request.timer);
      if (error === void 0) request.resolve(value);
      else request.reject(error);
    }
    failPending(result) {
      for (const request of [...this.pending]) this.settle(request, void 0, new FlvRebuildFailure(result));
    }
    progressRequest(request) {
      if (!this.rebuilder.calibrated) {
        this.settle(request, void 0, new FlvRebuildFailure("frames_missing"));
        return;
      }
      let result;
      try {
        result = this.rebuilder.attempt(request.aux);
      } catch (error) {
        this.reportError("FLV 后备拼接失败", error);
        this.settle(request, void 0, new FlvRebuildFailure("frames_missing"));
        return;
      }
      if (result.status === "waiting") return;
      if (result.status === "verified") this.settle(request, { bytes: result.bytes });
      else if (result.status === "mismatch") this.settle(request, void 0, new FlvRebuildFailure("crc_mismatch", result.bytes));
      else this.settle(request, void 0, new FlvRebuildFailure("frames_missing"));
    }
  };

  // src/bank/xhr.js
  var EVENT_NAMES = Object.freeze([
    "readystatechange",
    "progress",
    "loadstart",
    "load",
    "error",
    "abort",
    "timeout",
    "loadend"
  ]);
  function eventFor(windowObject, type, init = {}) {
    const EventConstructor = windowObject.Event || globalThis.Event;
    const event = new EventConstructor(type);
    for (const [field, value] of Object.entries(init)) {
      Object.defineProperty(event, field, { configurable: true, value });
    }
    return event;
  }
  function decodeText(bytes) {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  function responseValue(windowObject, responseType, bytes) {
    if (responseType === "" || responseType === "text") return decodeText(bytes);
    if (responseType === "arraybuffer") return bytes;
    if (responseType === "blob") {
      const BlobConstructor = windowObject.Blob || globalThis.Blob;
      return new BlobConstructor([bytes]);
    }
    if (responseType === "json") return JSON.parse(decodeText(bytes));
    return bytes;
  }
  function responseHeadersText(headers) {
    const rows = [];
    for (const [name, value] of headers.entries()) rows.push(`${name}: ${value}`);
    return rows.length === 0 ? "" : `${rows.join("\r\n")}\r
`;
  }
  function bankEnabled(bank) {
    return typeof bank.isEnabled === "function" ? bank.isEnabled() : bank.enabled === true;
  }
  function isAbortError(error) {
    return error?.name === "AbortError";
  }
  function mirrorForUrl(url) {
    return new URL(url).hostname;
  }
  function playlistResponseText(nativeRequest) {
    const responseType = nativeRequest.responseType;
    if (responseType === "" || responseType === "text") return nativeRequest.responseText;
    if (responseType === "arraybuffer") return decodeText(nativeRequest.response);
    throw new Error(`直播播放列表响应类型不受支持: ${responseType}`);
  }
  function createBankXMLHttpRequestClass({ windowObject, nativeConstructor, bank }) {
    return class SegmentBankXMLHttpRequest {
      static UNSENT = 0;
      static OPENED = 1;
      static HEADERS_RECEIVED = 2;
      static LOADING = 3;
      static DONE = 4;
      constructor() {
        this._native = new nativeConstructor();
        this._listeners = /* @__PURE__ */ new Map();
        this._openArgs = void 0;
        this._headers = {};
        this._range = void 0;
        this._body = void 0;
        this._intercepted = false;
        this._state = 0;
        this._responseType = "";
        this._status = 0;
        this._statusText = "";
        this._responseURL = "";
        this._responseHeaders = void 0;
        this._response = null;
        this._abortController = void 0;
        this._timer = void 0;
        this._done = false;
        this._aborted = false;
        this._timedOut = false;
        this._suppressNativeLoadstart = false;
        this._generation = 0;
        this._playurlObservationGeneration = void 0;
        this._playurlObservationUrl = void 0;
        this._livePlayurlObservationUrl = void 0;
        this._livePlaylistObservationUrl = void 0;
        this._liveTakeover = void 0;
        this._liveChunks = [];
        this._liveLoaded = 0;
        this._liveTextState = void 0;
        for (const eventName of EVENT_NAMES) {
          this._native.addEventListener(eventName, (event) => {
            if (!this._intercepted) {
              if (event.type === "load" && this._playurlObservationGeneration === this._generation && this._playurlObservationUrl !== void 0) {
                try {
                  bank.observePlayurlText(this._native.responseText);
                } catch (error) {
                  console.error("[BilibiliBuffer] playurl 地址簿读取失败", error);
                }
              }
              if (event.type === "load" && this._playurlObservationGeneration === this._generation && this._livePlayurlObservationUrl !== void 0) {
                try {
                  bank.observeLivePlayurlText(this._native.responseText);
                } catch (error) {
                  bank.reportLiveError("LIVE_PLAYURL", "直播 playurl 地址簿读取失败", error);
                }
              }
              if (event.type === "load" && this._playurlObservationGeneration === this._generation && this._livePlaylistObservationUrl !== void 0 && this._native.status >= 200 && this._native.status < 300) {
                try {
                  bank.observeLivePlaylistText(this._livePlaylistObservationUrl, playlistResponseText(this._native));
                } catch (error) {
                  bank.reportLiveError("LIVE_PLAYLIST", "直播播放列表读取失败", error);
                }
              }
              if (event.type === "loadstart" && this._suppressNativeLoadstart) {
                this._suppressNativeLoadstart = false;
                return;
              }
              this.dispatchEvent(event);
            }
          });
        }
      }
      get readyState() {
        return this._intercepted ? this._state : this._native.readyState;
      }
      get response() {
        if (this._intercepted) {
          if (this._liveTakeover !== void 0) {
            return responseValue(windowObject, this._responseType, this.joinLiveChunks());
          }
          return this._response;
        }
        return this._native.response;
      }
      get responseText() {
        if (this._intercepted) {
          if (this.responseType !== "" && this.responseType !== "text") {
            throw new DOMException("responseText is unavailable for this responseType", "InvalidStateError");
          }
          if (this._liveTakeover !== void 0) return this.liveText();
          return this._response || "";
        }
        return this._native.responseText;
      }
      get responseType() {
        return this._intercepted ? this._responseType : this._native.responseType;
      }
      set responseType(value) {
        this._responseType = value;
        this._native.responseType = value;
      }
      get responseURL() {
        return this._intercepted ? this._responseURL : this._native.responseURL;
      }
      get status() {
        return this._intercepted ? this._status : this._native.status;
      }
      get statusText() {
        return this._intercepted ? this._statusText : this._native.statusText;
      }
      get timeout() {
        return this._native.timeout;
      }
      set timeout(value) {
        this._native.timeout = value;
      }
      get withCredentials() {
        return this._native.withCredentials;
      }
      set withCredentials(value) {
        this._native.withCredentials = value;
      }
      open(...args) {
        this._abortController?.abort();
        this.clearTimer();
        this._generation += 1;
        this._playurlObservationGeneration = void 0;
        this._playurlObservationUrl = void 0;
        this._livePlayurlObservationUrl = void 0;
        this._livePlaylistObservationUrl = void 0;
        this._liveTakeover = void 0;
        this._liveChunks = [];
        this._liveLoaded = 0;
        this._liveTextState = void 0;
        this._openArgs = args;
        this._headers = {};
        this._range = void 0;
        this._body = void 0;
        this._intercepted = false;
        this._done = false;
        this._aborted = false;
        this._timedOut = false;
        this._suppressNativeLoadstart = false;
        this._status = 0;
        this._statusText = "";
        this._responseURL = "";
        this._responseHeaders = void 0;
        this._response = null;
        const result = this._native.open(...args);
        this._responseType = this._native.responseType;
        return result;
      }
      setRequestHeader(name, value) {
        const existing = this._headers[name];
        this._headers[name] = existing === void 0 ? String(value) : `${existing}, ${value}`;
        return this._native.setRequestHeader(name, value);
      }
      getResponseHeader(name) {
        if (!this._intercepted) return this._native.getResponseHeader(name);
        return this._responseHeaders?.get(name) || null;
      }
      getAllResponseHeaders() {
        if (!this._intercepted) return this._native.getAllResponseHeaders();
        if (this._responseHeaders === void 0) return "";
        return responseHeadersText(this._responseHeaders);
      }
      overrideMimeType(...args) {
        return this._native.overrideMimeType(...args);
      }
      addEventListener(type, listener, options) {
        const listeners = this._listeners.get(type) || /* @__PURE__ */ new Set();
        listeners.add(listener);
        this._listeners.set(type, listeners);
        return void 0;
      }
      removeEventListener(type, listener, options) {
        this._listeners.get(type)?.delete(listener);
        return void 0;
      }
      dispatchEvent(event) {
        const type = event.type;
        const handler = this[`on${type}`];
        if (typeof handler === "function") handler.call(this, event);
        for (const listener of this._listeners.get(type) || []) listener.call(this, event);
        return true;
      }
      send(body) {
        this._body = body;
        if (typeof bank.isLiveRoute === "function" && bank.isLiveRoute()) {
          return this.sendLive(body);
        }
        if (typeof bank.syncRouteLifecycle === "function" && !bank.syncRouteLifecycle()) {
          return this._native.send(body);
        }
        const url = new URL(this._openArgs?.[1], windowObject.location.href).href;
        const asyncFlag = this._openArgs?.[2] !== false;
        const generation = this._generation;
        this._playurlObservationGeneration = generation;
        this._playurlObservationUrl = typeof bank.isPlayurlUrl === "function" && bank.isPlayurlUrl(url) ? url : void 0;
        const enabled = bankEnabled(bank);
        const classification = classifyRequest({
          url,
          headers: this._headers,
          enabled,
          locationObject: windowObject.location
        });
        this._range = classification.range;
        if (!asyncFlag) {
          if (enabled) {
            bank.emitDiagnostic("bank.serve", {
              source: scrubUrl(url),
              mirror: mirrorForUrl(url),
              result: "pass",
              reason: "sync_xhr"
            });
          }
          return this._native.send(body);
        }
        if (!classification.intercepted) {
          if (enabled) {
            bank.emitDiagnostic("bank.serve", {
              source: scrubUrl(url),
              mirror: mirrorForUrl(url),
              result: "pass",
              reason: classification.reason
            });
          }
          return this._native.send(body);
        }
        this._intercepted = true;
        this._state = 1;
        this._abortController = new AbortController();
        this._status = 0;
        this._statusText = "";
        this._responseURL = "";
        this._responseHeaders = void 0;
        this._response = null;
        this.dispatchEvent(eventFor(windowObject, "loadstart"));
        if (this.timeout > 0) {
          this._timer = windowObject.setTimeout(() => {
            if (this._done || generation !== this._generation) return;
            this._timedOut = true;
            this._abortController.abort();
            this._done = true;
            this._state = 4;
            this.dispatchEvent(eventFor(windowObject, "readystatechange"));
            this.dispatchEvent(eventFor(windowObject, "timeout"));
            this.dispatchEvent(eventFor(windowObject, "loadend"));
          }, this.timeout);
        }
        void Promise.resolve().then(() => bank.serveRequest({
          url,
          headers: this._headers,
          credentials: this.withCredentials ? "include" : "same-origin",
          signal: this._abortController.signal
        })).then((served) => {
          if (this._done || generation !== this._generation) {
            served.release?.();
            return;
          }
          if (!served.intercepted) throw new Error("媒体分片请求未被下载层拦截");
          void this.serve(served, url, body, generation);
        }).catch((error) => this.handleServeError(error, url, body, generation));
      }
      joinLiveChunks() {
        const bytes = new Uint8Array(this._liveLoaded);
        let offset = 0;
        for (const chunk of this._liveChunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes.buffer;
      }
      liveText() {
        if (this._liveTextState === void 0) {
          this._liveTextState = { decoder: new TextDecoder(), text: "", consumed: 0 };
        }
        const state = this._liveTextState;
        for (; state.consumed < this._liveChunks.length; state.consumed += 1) {
          state.text += state.decoder.decode(this._liveChunks[state.consumed], { stream: true });
        }
        return state.text;
      }
      sendLive(body) {
        const url = new URL(this._openArgs?.[1], windowObject.location.href).href;
        const asyncFlag = this._openArgs?.[2] !== false;
        const generation = this._generation;
        this._playurlObservationGeneration = generation;
        this._livePlayurlObservationUrl = typeof bank.isLivePlayurlUrl === "function" && bank.isLivePlayurlUrl(url) ? url : void 0;
        const enabled = bankEnabled(bank);
        const classification = classifyLiveRequest({
          url,
          enabled,
          locationObject: windowObject.location
        });
        this._livePlaylistObservationUrl = classification.reason === "live_hls_playlist" ? url : void 0;
        if (!asyncFlag) {
          if (enabled) {
            bank.emitDiagnostic("bank.serve", {
              source: scrubUrl(url),
              mirror: mirrorForUrl(url),
              result: "pass",
              reason: "sync_xhr"
            });
          }
          return this._native.send(body);
        }
        if (!classification.intercepted) {
          if (enabled) {
            bank.emitDiagnostic("bank.serve", {
              source: scrubUrl(url),
              mirror: mirrorForUrl(url),
              result: "pass",
              reason: classification.reason
            });
          }
          return this._native.send(body);
        }
        this._intercepted = true;
        this._state = 1;
        this._abortController = new AbortController();
        this._status = 0;
        this._statusText = "";
        this._responseURL = "";
        this._responseHeaders = void 0;
        this._response = null;
        this.dispatchEvent(eventFor(windowObject, "loadstart"));
        if (this.timeout > 0) {
          this._timer = windowObject.setTimeout(() => {
            if (this._done || generation !== this._generation) return;
            this._timedOut = true;
            this._abortController.abort();
            this._done = true;
            this._state = 4;
            this.dispatchEvent(eventFor(windowObject, "readystatechange"));
            this.dispatchEvent(eventFor(windowObject, "timeout"));
            this.dispatchEvent(eventFor(windowObject, "loadend"));
          }, this.timeout);
        }
        let takeover;
        try {
          takeover = bank.serveLive({
            url,
            classification,
            credentials: this.withCredentials ? "include" : "same-origin",
            signal: this._abortController.signal
          });
        } catch (error) {
          bank.reportLiveError("LIVE_TAKEOVER", "直播流前台接管失败", error);
          this.finishError(error, generation);
          return void 0;
        }
        this._liveTakeover = takeover;
        takeover.onHeaders = ({ status, statusText, contentType }) => {
          if (this._done || generation !== this._generation) return;
          this._status = status;
          this._statusText = statusText;
          this._responseURL = url;
          const HeadersConstructor = windowObject.Headers || globalThis.Headers;
          const headers = new HeadersConstructor();
          if (contentType !== void 0) headers.set("Content-Type", contentType);
          this._responseHeaders = headers;
          this._state = 2;
          this.dispatchEvent(eventFor(windowObject, "readystatechange"));
          this._state = 3;
          this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        };
        takeover.onBytes = (bytes) => {
          if (this._done || generation !== this._generation) return;
          this._liveChunks.push(bytes);
          this._liveLoaded += bytes.byteLength;
          this.dispatchEvent(eventFor(windowObject, "progress", {
            loaded: this._liveLoaded,
            total: 0,
            lengthComputable: false
          }));
        };
        takeover.onEnd = () => {
          if (this._done || generation !== this._generation) return;
          this._response = responseValue(windowObject, this._responseType, this.joinLiveChunks());
          this._liveTakeover = void 0;
          this._state = 4;
          this._done = true;
          this.dispatchEvent(eventFor(windowObject, "readystatechange"));
          this.dispatchEvent(eventFor(windowObject, "load"));
          this.dispatchEvent(eventFor(windowObject, "loadend"));
          this.clearTimer();
        };
        takeover.onError = (error) => {
          if (this._done || generation !== this._generation) return;
          if (this._aborted || this._timedOut) return;
          bank.reportLiveError("LIVE_TAKEOVER", "直播流前台接管失败", error);
          this.finishError(error, generation);
        };
        void takeover.headersPromise.catch((error) => {
          if (this._done || generation !== this._generation) return;
          if (isAbortError(error)) {
            if (!this._aborted && !this._timedOut) this.finishError(error, generation);
            return;
          }
          bank.reportLiveError("LIVE_TAKEOVER", "直播流前台接管失败", error);
          this.finishError(error, generation);
        });
        return void 0;
      }
      handleServeError(error, url, body, generation) {
        if (this._done || generation !== this._generation) return;
        if (error instanceof BankFallbackError) {
          bank.emitDiagnostic("bank.serve", {
            source: scrubUrl(url),
            mirror: mirrorForUrl(url),
            ...this._range,
            result: "pass",
            reason: "internal_fallback"
          });
          this.clearTimer();
          this._suppressNativeLoadstart = true;
          this._intercepted = false;
          this._native.send(body);
          return;
        }
        if (error instanceof BankNetworkError) {
          if (!this._aborted && !this._timedOut) {
            console.error("[BilibiliBuffer] 媒体分片前台取数失败", error);
            this.finishError(error, generation);
          }
          return;
        }
        if (isAbortError(error)) {
          if (!this._aborted && !this._timedOut) this.finishError(error, generation);
          return;
        }
        console.error("[BilibiliBuffer] 媒体分片供数失败", error);
        bank.emitDiagnostic("bank.serve", {
          source: scrubUrl(url),
          mirror: mirrorForUrl(url),
          ...this._range,
          result: "pass",
          reason: "internal_error"
        });
        this.clearTimer();
        this._suppressNativeLoadstart = true;
        this._intercepted = false;
        this._native.send(body);
      }
      async serve(result, url, body, generation) {
        try {
          await Promise.resolve();
          if (this._done || generation !== this._generation) {
            result.release?.();
            return;
          }
          await this.finishResponse(result.response, result.bytes, url, generation);
          result.release?.();
        } catch (error) {
          result.release?.();
          if (this._done || generation !== this._generation) return;
          this.handleServeError(error, url, body, generation);
        }
      }
      async finishResponse(response, knownBytes, requestUrl, generation) {
        const bytes = knownBytes;
        if (this._done || generation !== this._generation) return;
        this._status = response.status;
        this._statusText = response.statusText;
        this._responseURL = response.url || requestUrl;
        this._responseHeaders = response.headers;
        this._response = responseValue(windowObject, this._responseType, bytes);
        const contentLength = response.headers.get("Content-Length");
        const total = contentLength === null ? 0 : Number(contentLength);
        const lengthComputable = Number.isFinite(total) && total >= 0;
        this._state = 2;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this._state = 3;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this.dispatchEvent(eventFor(windowObject, "progress", {
          loaded: bytes.byteLength,
          total: lengthComputable ? total : 0,
          lengthComputable
        }));
        this._state = 4;
        this._done = true;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this.dispatchEvent(eventFor(windowObject, "load"));
        this.dispatchEvent(eventFor(windowObject, "loadend"));
        this.clearTimer();
      }
      finishError(error, generation) {
        if (this._done || generation !== this._generation) return;
        this._state = 4;
        this._done = true;
        this.dispatchEvent(eventFor(windowObject, "readystatechange"));
        this.dispatchEvent(eventFor(windowObject, "error", { error }));
        this.dispatchEvent(eventFor(windowObject, "loadend"));
        this.clearTimer();
      }
      abort() {
        if (!this._intercepted) {
          this._native.abort();
          return;
        }
        if (this._done) return;
        this._aborted = true;
        this._abortController.abort();
        this._done = true;
        this._state = 0;
        this.dispatchEvent(eventFor(windowObject, "abort"));
        this.dispatchEvent(eventFor(windowObject, "loadend"));
        this.clearTimer();
      }
      clearTimer() {
        if (this._timer !== void 0) {
          windowObject.clearTimeout(this._timer);
          this._timer = void 0;
        }
      }
    };
  }

  // src/bank/main.js
  var MAX_PREFETCH_CONCURRENCY = 4;
  function abortError2() {
    return new DOMException("The operation was aborted", "AbortError");
  }
  function isAbortError2(error) {
    return error?.name === "AbortError";
  }
  function performanceNow(windowObject) {
    return typeof windowObject.performance?.now === "function" ? windowObject.performance.now() : Date.now();
  }
  function mirrorForUrl2(url) {
    return new URL(url).hostname;
  }
  function videoIdentityFor(locationObject) {
    if (locationObject === void 0) return void 0;
    return JSON.stringify(routeIdentity(locationObject));
  }
  function playurlRepresentationUrls(value) {
    if (value === null || typeof value !== "object" || typeof value.baseUrl !== "string") return void 0;
    const backupUrls = Array.isArray(value.backupUrl) ? value.backupUrl.filter((url) => typeof url === "string") : [];
    return [value.baseUrl, ...backupUrls].slice(0, 4);
  }
  function playurlSupportFormats(value) {
    if (value === null || typeof value !== "object") return [];
    if (Array.isArray(value.support_formats)) return value.support_formats;
    for (const child of Object.values(value)) {
      const result = playurlSupportFormats(child);
      if (result.length > 0) return result;
    }
    return [];
  }
  function representationLabel(value, supportFormats) {
    const matchingFormat = supportFormats.find((format) => format?.quality === value.id);
    if (typeof matchingFormat?.new_description === "string" && matchingFormat.new_description.length > 0) {
      return matchingFormat.new_description;
    }
    const parts = [];
    if (Number.isSafeInteger(value.height) && value.height > 0) parts.push(`${value.height}P`);
    const frameRate = value.frameRate ?? value.frame_rate;
    if (frameRate !== void 0 && frameRate !== null && String(frameRate).length > 0) {
      parts.push(`${frameRate}fps`);
    }
    if (typeof value.codecs === "string" && value.codecs.length > 0) parts.push(value.codecs);
    if (parts.length === 0 && Number.isSafeInteger(value.bandwidth) && value.bandwidth > 0) {
      parts.push(`${value.bandwidth}bps`);
    }
    return parts.length === 0 ? void 0 : parts.join(" · ");
  }
  function visitPlayurlRepresentations(value, callback) {
    if (value === null || typeof value !== "object") return;
    const urls = playurlRepresentationUrls(value);
    if (urls !== void 0) callback({
      urls,
      representation: {
        id: value.id,
        mimeType: value.mimeType,
        codecs: value.codecs,
        width: value.width,
        height: value.height,
        bandwidth: value.bandwidth,
        frameRate: value.frameRate,
        frame_rate: value.frame_rate
      }
    });
    for (const child of Object.values(value)) visitPlayurlRepresentations(child, callback);
  }
  function responseTypeConstructor(windowObject, name) {
    return windowObject[name] || globalThis[name];
  }
  function isRequestLike(value) {
    return value !== null && typeof value === "object" && typeof value.url === "string" && value.headers !== void 0;
  }
  function initField(init, field, inherited) {
    if (init !== null && (typeof init === "object" || typeof init === "function")) {
      const value = init[field];
      if (value !== void 0) return value;
    }
    return inherited;
  }
  function inspectFetchArguments(args, locationObject) {
    const [input, init] = args;
    const inherited = isRequestLike(input) ? input : void 0;
    const rawUrl = inherited === void 0 ? String(input) : inherited.url;
    const url = new URL(rawUrl, locationObject?.href).href;
    return {
      url,
      headers: initField(init, "headers", inherited?.headers),
      method: initField(init, "method", inherited?.method) || "GET",
      credentials: initField(init, "credentials", inherited?.credentials) || "same-origin",
      signal: initField(init, "signal", inherited?.signal)
    };
  }
  var SegmentBank = class {
    constructor({
      windowObject = window,
      nativeFetch = windowObject.fetch,
      maxPrefetchConcurrency = MAX_PREFETCH_CONCURRENCY,
      config = BANK_CONFIG,
      flvBackupConfig = LIVE_FLV_BACKUP_CONFIG,
      chunks = /* @__PURE__ */ new Map(),
      now = Date.now
    } = {}) {
      this.windowObject = windowObject;
      this.nativeFetch = nativeFetch;
      this.config = config;
      this.flvBackupConfig = flvBackupConfig;
      this.maxPrefetchConcurrency = maxPrefetchConcurrency;
      this.now = now;
      this.enabled = false;
      this.disabled = false;
      this.queue = [];
      this.inflight = /* @__PURE__ */ new Map();
      this.activePrefetch = /* @__PURE__ */ new Set();
      this.sessionGeneration = 0;
      this.resourceState = /* @__PURE__ */ new Map();
      this.recentResourceKeys = [];
      this.liveSegmentIdentity = /* @__PURE__ */ new Map();
      this.livePlaylists = /* @__PURE__ */ new Map();
      this.liveFlvBackup = void 0;
      this.liveFlvUnavailable = /* @__PURE__ */ new Map();
      this.addressBook = /* @__PURE__ */ new Map();
      this.lastInventoryPayload = void 0;
      this.lastInventoryPublishedAt = void 0;
      this.videoIdentity = videoIdentityFor(this.windowObject.location);
      this.chunks = chunks;
      this.lastRouteWasVideo = this.windowObject.location === void 0 || isVideoLocation(this.windowObject.location);
      this.observePlayurlData(this.windowObject.__playinfo__);
      this.prefetchTimer = this.windowObject.setInterval?.(() => {
        void this.prefetchTick().catch((error) => {
          console.error("[BilibiliBuffer] 媒体分片预取失败", error);
        });
      }, 1e3);
    }
    isEnabled() {
      if (this.disabled) return false;
      const root = this.windowObject.document?.documentElement;
      const configured = root?.getAttribute?.(BANK_ENABLED_ATTRIBUTE);
      if (configured === "true") return true;
      if (configured === "false") return false;
      return this.enabled === true;
    }
    emitDiagnostic(code, data) {
      const message = {
        namespace: BANK_MESSAGE_NAMESPACE,
        direction: "event",
        type: BANK_DIAGNOSTIC_MESSAGE_TYPE,
        code,
        data
      };
      try {
        this.windowObject.postMessage(message, "*");
      } catch (error) {
        console.error("[BilibiliBuffer] 媒体分片诊断派发失败", error);
      }
    }
    reportLiveError(code, message, error) {
      console.error(`[BilibiliBuffer] ${message}`, error);
      try {
        this.emitDiagnostic("log.error", {
          errorName: error?.name,
          message: error?.message === void 0 ? message : `${message}: ${error.message}`,
          code
        });
      } catch (persistError) {
        console.error("[BilibiliBuffer] 直播错误通道派发失败", persistError);
      }
    }
    stateFor(bankKeyValue) {
      let state = this.resourceState.get(bankKeyValue);
      if (state === void 0) {
        state = {
          bankKey: bankKeyValue,
          videoKey: this.windowObject.location.pathname,
          latestUrl: void 0,
          credentials: "same-origin",
          totalSize: void 0,
          lastForegroundStart: void 0,
          lastForegroundEnd: void 0,
          outstanding: /* @__PURE__ */ new Set(),
          chunkAttempts: /* @__PURE__ */ new Map()
        };
        this.resourceState.set(bankKeyValue, state);
      }
      return state;
    }
    cacheKeyForRange(resourceKey, start) {
      return cacheKey(resourceKey, chunkIndex(start, this.config.chunkBytes));
    }
    currentByteByBank() {
      return Object.fromEntries(
        [...this.resourceState.entries()].filter(([, state]) => Number.isSafeInteger(state.lastForegroundEnd)).map(([key, state]) => [key, state.lastForegroundEnd])
      );
    }
    releaseSession() {
      this.sessionGeneration += 1;
      this.abortPrefetchTasks();
      for (const task of this.queue) {
        task.controller.abort();
        task.settled = true;
        task.reject(abortError2());
        if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
      }
      this.queue = [];
      clearMemory(this.chunks);
      this.resourceState.clear();
      this.recentResourceKeys = [];
      this.addressBook.clear();
    }
    syncRouteLifecycle() {
      if (this.windowObject.location === void 0) return true;
      const currentIsVideo = isVideoLocation(this.windowObject.location);
      if (!currentIsVideo) {
        if (this.lastRouteWasVideo) this.releaseSession();
        this.lastRouteWasVideo = false;
        this.videoIdentity = void 0;
        return false;
      }
      const currentVideoIdentity = videoIdentityFor(this.windowObject.location);
      if (this.lastRouteWasVideo && this.videoIdentity !== currentVideoIdentity) this.releaseSession();
      this.videoIdentity = currentVideoIdentity;
      this.lastRouteWasVideo = true;
      return true;
    }
    touchResource(resourceKey) {
      const nextKeys = [
        ...this.recentResourceKeys.filter((key) => key !== resourceKey),
        resourceKey
      ].slice(-2);
      this.recentResourceKeys = nextKeys;
    }
    abortPrefetchTasks(predicate = () => true) {
      for (const task of this.inflight.values()) {
        if (predicate(task)) {
          this.clearTaskStall(task);
          task.controller.abort();
        }
      }
    }
    requestClassification(url, headers) {
      return classifyRequest({
        url,
        headers,
        enabled: this.isEnabled(),
        locationObject: this.windowObject.location
      });
    }
    isPlayurlUrl(url) {
      return new URL(url).pathname.endsWith("/playurl");
    }
    isLiveRoute() {
      return isLiveLocation(this.windowObject.location);
    }
    isLivePlayurlUrl(url) {
      return isLivePlayurlUrl(url);
    }
    async observePlayurlResponse(response) {
      const clone = response.clone();
      const data = await clone.json();
      this.observePlayurlData(data);
    }
    observePlayurlText(responseText) {
      try {
        this.observePlayurlData(JSON.parse(responseText));
      } catch (error) {
        console.error("[BilibiliBuffer] playurl 地址簿解析失败", error);
      }
    }
    async observeLivePlayurlResponse(response) {
      const clone = response.clone();
      const data = await clone.json();
      this.observeLivePlayurlData(data);
    }
    observeLivePlayurlText(responseText) {
      try {
        this.observeLivePlayurlData(JSON.parse(responseText));
      } catch (error) {
        this.reportLiveError("LIVE_PLAYURL", "直播 playurl 地址簿解析失败", error);
      }
    }
    // 播放器拿到的播放列表：读克隆体，不改播放器收到的内容；记下每个分片的 AUX 值。
    async observeLivePlaylistResponse(url, response) {
      if (response.status < 200 || response.status >= 300) return;
      const text = await response.clone().text();
      this.observeLivePlaylistText(url, text);
    }
    observeLivePlaylistText(url, text) {
      const streamPath = hlsStreamPathOf(new URL(url).pathname);
      const playlist = parseBiliPlaylist(text);
      let state = this.livePlaylists.get(streamPath);
      if (state === void 0) {
        state = { mapUri: void 0, initBytes: void 0, entries: /* @__PURE__ */ new Map() };
        this.livePlaylists.set(streamPath, state);
        while (this.livePlaylists.size > 8) this.livePlaylists.delete(this.livePlaylists.keys().next().value);
      }
      if (playlist.mapUri !== void 0) state.mapUri = playlist.mapUri;
      for (const entry of playlist.entries) {
        state.entries.delete(entry.name);
        state.entries.set(entry.name, entry);
      }
      while (state.entries.size > 256) state.entries.delete(state.entries.keys().next().value);
    }
    // init 分片经网络送达：字节与上一个不同才作废 FLV 后备的校准。实测有的直播间每分钟换一次
    // init 分片名（伴随 EXT-X-DISCONTINUITY），字节不变，分片时间线也不断，校准照常可用。
    noteLiveInitSegment(streamPath, bytes) {
      const state = this.livePlaylists.get(streamPath);
      if (state.initBytes !== void 0 && compareSegmentBytes(state.initBytes, bytes) !== -1 && this.liveFlvBackup?.hlsStreamPath === streamPath) {
        this.liveFlvBackup.resetCalibration();
      }
      state.initBytes = bytes.slice();
    }
    livePlaylistAuxFor(streamPath, name) {
      return this.livePlaylists.get(streamPath)?.entries.get(name);
    }
    // FLV 后备地址：地址簿里与该 fMP4 流同流名、同编码的 .flv 条目（Bilibili 自带的地址，
    // 不合成主机）。
    flvBackupUrlsFor(hlsStreamPath) {
      let hlsEntry;
      for (const [pathname, entry] of this.addressBook) {
        if (!pathname.endsWith(".m3u8") || hlsStreamPathOf(pathname) !== hlsStreamPath) continue;
        hlsEntry = entry;
        break;
      }
      if (hlsEntry === void 0) return { urls: void 0, miss: "no_hls_entry" };
      const streamName = hlsStreamNameOf(hlsStreamPath);
      for (const [pathname, entry] of this.addressBook) {
        if (!pathname.endsWith(".flv") || entry.codec !== hlsEntry.codec) continue;
        if (flvStreamNameOf(pathname) !== streamName) continue;
        return { urls: entry.urls };
      }
      return { urls: void 0, miss: "no_flv_entry" };
    }
    // 当前 fMP4 流的 FLV 后备：流目录一变就关掉旧连接另开；同一条流关闭后（given_up、
    // unavailable）不再重开。地址簿缺可用地址时不开，下一个分片再查，同一条流同一原因只记
    // 一次 unavailable。
    ensureLiveFlvBackup(streamPath, credentials) {
      if (this.liveFlvBackup?.hlsStreamPath === streamPath) return this.liveFlvBackup;
      this.closeLiveFlvBackup();
      const backup = new LiveFlvBackup({
        hlsStreamPath: streamPath,
        resolveUrls: () => this.flvBackupUrlsFor(streamPath),
        fetchImpl: (url, init) => this.nativeFetch.call(this.windowObject, url, init),
        credentials,
        timers: {
          setTimeout: (callback, ms) => this.windowObject.setTimeout(callback, ms),
          clearTimeout: (timer) => this.windowObject.clearTimeout(timer)
        },
        now: this.now,
        emitState: (payload) => this.emitDiagnostic("live.flv.backup", payload),
        reportError: (message, error) => this.reportLiveError("LIVE_FLV_BACKUP", message, error),
        config: { ...this.flvBackupConfig, stallMs: this.config.stallMs }
      });
      let miss = backup.start();
      if (miss !== void 0 && !this.liveFlvUnavailable.has(streamPath)) {
        this.readInlineLivePlayinfo();
        miss = backup.start();
      }
      if (miss === void 0) {
        this.liveFlvBackup = backup;
        return backup;
      }
      if (this.liveFlvUnavailable.get(streamPath) !== miss) {
        this.liveFlvUnavailable.delete(streamPath);
        this.liveFlvUnavailable.set(streamPath, miss);
        while (this.liveFlvUnavailable.size > 16) {
          this.liveFlvUnavailable.delete(this.liveFlvUnavailable.keys().next().value);
        }
        backup.emitState("unavailable", miss);
      }
      return void 0;
    }
    closeLiveFlvBackup() {
      this.liveFlvBackup?.close();
      this.liveFlvBackup = void 0;
    }
    readInlineLivePlayinfo() {
      const addressBook = new Map(this.addressBook);
      try {
        this.observeLivePlayurlData(this.windowObject.__NEPTUNE_IS_MY_WAIFU__, "inline_blob");
      } catch (error) {
        this.addressBook = addressBook;
        this.reportLiveError("LIVE_PLAYURL", "直播内嵌地址簿读取失败", error);
        this.emitDiagnostic("live.playurl_observed", {
          channel: "inline_blob",
          groupCount: 0,
          flvGroupCount: 0,
          errorName: error?.name
        });
      }
    }
    observeLivePlayurlData(data, channel = "playinfo_api") {
      if (data === void 0 || data === null) {
        this.emitDiagnostic("live.playurl_observed", { channel, groupCount: 0, flvGroupCount: 0 });
        return;
      }
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (error) {
          this.reportLiveError("LIVE_PLAYURL", "直播 playurl 地址簿解析失败", error);
          this.emitDiagnostic("live.playurl_observed", {
            channel,
            groupCount: 0,
            flvGroupCount: 0,
            errorName: error?.name
          });
          return;
        }
      }
      const observedAt = this.now();
      let groupCount = 0;
      let flvGroupCount = 0;
      let groupErrorName;
      visitLiveUrlInfoGroups(data, (group, groupBaseUrl, codec) => {
        try {
          const urls = group.map((info) => new URL(urlFromLiveUrlInfo(info, groupBaseUrl)).href);
          const pathnames = new Set(urls.map((entry) => new URL(entry).pathname));
          if (pathnames.size !== 1) throw new Error("直播主备地址路径不一致");
          const pathname = new URL(urls[0]).pathname;
          this.addressBook.set(pathname, { urls, observedAt, codec });
          groupCount += 1;
          if (pathname.endsWith(".flv")) flvGroupCount += 1;
        } catch (error) {
          groupErrorName = error?.name;
          this.reportLiveError("LIVE_PLAYURL", "直播 playurl 地址簿 URL 无效", error);
        }
      });
      const observed = { channel, groupCount, flvGroupCount };
      if (groupErrorName !== void 0) observed.errorName = groupErrorName;
      this.emitDiagnostic("live.playurl_observed", observed);
    }
    readInlinePlayinfo() {
      const addressBook = new Map(this.addressBook);
      try {
        this.observePlayurlData(this.windowObject.__playinfo__);
      } catch (error) {
        this.addressBook = addressBook;
        console.error("[BilibiliBuffer] __playinfo__ 地址簿读取失败", error);
      }
    }
    observePlayurlData(data) {
      if (data === void 0 || data === null) return;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch (error) {
          console.error("[BilibiliBuffer] __playinfo__ 地址簿解析失败", error);
          return;
        }
      }
      const observedAt = this.now();
      const supportFormats = playurlSupportFormats(data);
      visitPlayurlRepresentations(data, ({ urls, representation }) => {
        try {
          const parsedUrls = urls.map((url) => new URL(url));
          const pathname = parsedUrls[0].pathname;
          this.addressBook.set(pathname, {
            urls,
            observedAt,
            representation,
            supportFormats,
            label: representationLabel(representation, supportFormats)
          });
        } catch (error) {
          console.error("[BilibiliBuffer] playurl 地址簿 URL 无效", error);
        }
      });
    }
    pairDecisionFor(url) {
      const playerUrl = new URL(url);
      const entry = this.addressBook.get(playerUrl.pathname);
      if (entry === void 0) return { pairUrl: void 0, miss: "no_book_entry" };
      if (this.now() - entry.observedAt > this.config.pairFreshnessMs) return { pairUrl: void 0, miss: "stale" };
      for (const candidateUrl of entry.urls) {
        const candidate = new URL(candidateUrl);
        if (candidate.hostname === playerUrl.hostname) continue;
        if (candidate.pathname !== playerUrl.pathname) return { pairUrl: void 0 };
        return { pairUrl: candidateUrl };
      }
      return { pairUrl: void 0, miss: "no_alt_host" };
    }
    pairUrlFor(url) {
      return this.pairDecisionFor(url).pairUrl;
    }
    evaluateLivePair(url) {
      return this.pairDecisionFor(url);
    }
    // HLS 分片配对：地址簿里同流目录的 .m3u8 条目（同 cluster 主备由 Bilibili 自带，
    // 与 FLV 路径同一规则），配对 URL 由该条目的主机与它自己的签名 query 组成，
    // 不合成、不猜主机；条目过期或跨流目录不配。
    pairSegmentDecisionFor(playerUrl) {
      const streamPath = hlsStreamPathOf(playerUrl.pathname);
      let entry;
      for (const [pathname, candidate] of this.addressBook) {
        if (!pathname.endsWith(".m3u8")) continue;
        if (hlsStreamPathOf(pathname) !== streamPath) continue;
        entry = candidate;
        break;
      }
      if (entry === void 0) return { pairUrl: void 0, miss: "no_book_entry" };
      if (this.now() - entry.observedAt > this.config.pairFreshnessMs) {
        return { pairUrl: void 0, miss: "stale" };
      }
      for (const candidateUrl of entry.urls) {
        const candidate = new URL(candidateUrl);
        if (candidate.hostname === playerUrl.hostname) continue;
        return { pairUrl: hlsSegmentPairUrl(playerUrl, candidate) };
      }
      return { pairUrl: void 0, miss: "no_alt_host" };
    }
    // 流身份门状态：pending（首个竞速分片对尚未完整比对）、verified（已一致，开放竞速）、
    // rejected（比对不一致或门期反复无法完整比对，永久单腿）。
    liveSegmentIdentityFor(streamPath) {
      let state = this.liveSegmentIdentity.get(streamPath);
      if (state === void 0) {
        state = { verdict: "pending", attempts: 0 };
        this.liveSegmentIdentity.set(streamPath, state);
        while (this.liveSegmentIdentity.size > 16) {
          const oldest = this.liveSegmentIdentity.keys().next().value;
          this.liveSegmentIdentity.delete(oldest);
        }
      }
      return state;
    }
    createTaskLeg(task, slot, url) {
      return {
        slot,
        url,
        mirror: mirrorForUrl2(url),
        reader: void 0,
        stallTimer: void 0,
        startedAt: void 0,
        ttfbAt: void 0,
        byteCount: 0,
        abortReported: false,
        outcome: void 0,
        controller: new AbortController(),
        settled: false,
        abortReason: void 0
      };
    }
    buildTaskLegs(task) {
      const urls = [task.url];
      if (this.config.raceLegs > 1) {
        let pairUrl = this.pairUrlFor(task.url);
        if (pairUrl === void 0) {
          this.readInlinePlayinfo();
          pairUrl = this.pairUrlFor(task.url);
        }
        if (pairUrl !== void 0) urls.push(pairUrl);
      }
      task.legs = urls.map((url, slot) => this.createTaskLeg(task, slot, url));
      if (task.controller.signal.aborted) {
        for (const leg of task.legs) leg.controller.abort();
      }
    }
    async handleFetch(thisArg, args, originalFetch) {
      if (this.isLiveRoute()) {
        return this.handleLiveFetch(thisArg, args, originalFetch);
      }
      if (!this.syncRouteLifecycle()) {
        return originalFetch.apply(thisArg, args);
      }
      let request;
      try {
        request = inspectFetchArguments(args, this.windowObject.location);
      } catch (error) {
        return originalFetch.apply(thisArg, args);
      }
      let classification;
      try {
        classification = this.requestClassification(request.url, request.headers);
      } catch (error) {
        return originalFetch.apply(thisArg, args);
      }
      if (!classification.intercepted) {
        if (this.isEnabled()) {
          this.emitDiagnostic("bank.serve", {
            source: scrubUrl(request.url),
            mirror: mirrorForUrl2(request.url),
            result: "pass",
            reason: classification.reason
          });
        }
        const response = await originalFetch.apply(thisArg, args);
        if (this.isPlayurlUrl(request.url)) {
          await this.observePlayurlResponse(response).catch((error) => {
            console.error("[BilibiliBuffer] playurl 地址簿读取失败", error);
          });
        }
        return response;
      }
      try {
        const served = await this.serveRequest({
          url: request.url,
          headers: request.headers,
          credentials: request.credentials,
          signal: request.signal
        });
        if (!served.intercepted) {
          return originalFetch.apply(thisArg, args);
        }
        try {
          return served.response;
        } finally {
          served.release?.();
        }
      } catch (error) {
        if (isAbortError2(error)) throw error;
        if (error instanceof BankNetworkError) {
          console.error("[BilibiliBuffer] 媒体分片前台取数失败", error);
          throw error;
        }
        if (error instanceof BankFallbackError) {
          this.emitDiagnostic("bank.serve", {
            source: scrubUrl(request.url),
            mirror: mirrorForUrl2(request.url),
            start: classification.range.start,
            end: classification.range.end,
            result: "pass",
            reason: "internal_fallback"
          });
          return originalFetch.apply(thisArg, args);
        }
        console.error("[BilibiliBuffer] 媒体分片供数失败", error);
        this.emitDiagnostic("bank.serve", {
          source: scrubUrl(request.url),
          mirror: mirrorForUrl2(request.url),
          start: classification.range.start,
          end: classification.range.end,
          result: "pass",
          reason: "internal_error"
        });
        return originalFetch.apply(thisArg, args);
      }
    }
    async handleLiveFetch(thisArg, args, originalFetch) {
      let request;
      try {
        request = inspectFetchArguments(args, this.windowObject.location);
      } catch (error) {
        return originalFetch.apply(thisArg, args);
      }
      let classification;
      try {
        classification = classifyLiveRequest({
          url: request.url,
          enabled: this.isEnabled(),
          locationObject: this.windowObject.location
        });
      } catch (error) {
        return originalFetch.apply(thisArg, args);
      }
      if (!classification.intercepted) {
        if (this.isEnabled()) {
          this.emitDiagnostic("bank.serve", {
            source: scrubUrl(request.url),
            mirror: mirrorForUrl2(request.url),
            result: "pass",
            reason: classification.reason
          });
        }
        const response2 = await originalFetch.apply(thisArg, args);
        if (this.isLivePlayurlUrl(request.url)) {
          await this.observeLivePlayurlResponse(response2).catch((error) => {
            this.reportLiveError("LIVE_PLAYURL", "直播 playurl 地址簿读取失败", error);
          });
        }
        if (classification.reason === "live_hls_playlist") {
          await this.observeLivePlaylistResponse(request.url, response2).catch((error) => {
            this.reportLiveError("LIVE_PLAYLIST", "直播播放列表读取失败", error);
          });
        }
        return response2;
      }
      let takeover;
      try {
        takeover = this.serveLive({
          url: request.url,
          classification,
          credentials: request.credentials,
          signal: request.signal
        });
      } catch (error) {
        if (!isAbortError2(error)) this.reportLiveError("LIVE_TAKEOVER", "直播流前台接管失败", error);
        throw error;
      }
      let streamController;
      const body = new ReadableStream({
        start(controller) {
          streamController = controller;
        },
        cancel() {
          takeover.cancel();
        }
      });
      takeover.onBytes = (bytes) => {
        streamController.enqueue(bytes);
      };
      takeover.onEnd = () => {
        streamController.close();
      };
      takeover.onError = (error) => {
        if (!isAbortError2(error)) this.reportLiveError("LIVE_TAKEOVER", "直播流前台接管失败", error);
        streamController.error(error);
      };
      let headers;
      try {
        headers = await takeover.headersPromise;
      } catch (error) {
        if (isAbortError2(error)) throw error;
        this.reportLiveError("LIVE_TAKEOVER", "直播流前台接管失败", error);
        throw error;
      }
      const ResponseConstructor = responseTypeConstructor(this.windowObject, "Response");
      const responseHeaders = {};
      if (headers.contentType !== void 0) responseHeaders["Content-Type"] = headers.contentType;
      const response = new ResponseConstructor(body, {
        status: headers.status,
        statusText: headers.statusText,
        headers: responseHeaders
      });
      Object.defineProperty(response, "url", { configurable: true, value: request.url });
      Object.defineProperty(response, "type", { configurable: true, value: "basic" });
      return response;
    }
    serveLive({ url, classification, credentials, signal }) {
      if (classification?.kind === "hls_segment") {
        return this.serveLiveSegment({ url, credentials, signal });
      }
      return this.serveLiveStream({ url, credentials, signal });
    }
    serveLiveStream({ url, credentials, signal }) {
      if (signal?.aborted) throw abortError2();
      this.closeLiveFlvBackup();
      const startedAt = performanceNow(this.windowObject);
      let serveFailed = false;
      const emitFailedServe = (error) => {
        if (serveFailed) return;
        serveFailed = true;
        this.emitDiagnostic("bank.serve", {
          source: scrubUrl(url),
          mirror: mirrorForUrl2(url),
          durationMs: performanceNow(this.windowObject) - startedAt,
          result: "failed",
          reason: "live_stream_failed",
          errorName: error?.name
        });
      };
      let pairDecision = { pairUrl: void 0, miss: void 0 };
      if (this.config.raceLegs > 1) {
        pairDecision = this.evaluateLivePair(url);
        if (pairDecision.pairUrl === void 0) {
          this.readInlineLivePlayinfo();
          pairDecision = this.evaluateLivePair(url);
        }
      }
      const pairUrl = pairDecision.pairUrl;
      const candidateUrls = pairUrl === void 0 ? [url] : [url, pairUrl];
      const legDescriptors = [];
      for (const [slot, candidate] of candidateUrls.entries()) {
        const expiresAt = liveUrlExpiresAt(candidate);
        if (expiresAt !== void 0 && this.now() >= expiresAt) {
          this.emitDiagnostic("bank.fetch.chunk", {
            source: scrubUrl(candidate),
            mirror: mirrorForUrl2(candidate),
            chunkIndex: 0,
            start: 0,
            end: 0,
            bytes: 0,
            durationMs: 0,
            slot,
            priority: "foreground",
            result: "address_expired"
          });
          continue;
        }
        legDescriptors.push({ slot, url: candidate });
      }
      if (legDescriptors.length === 0) {
        const error = new BankNetworkError("直播流地址签名到期且无可用地址");
        emitFailedServe(error);
        throw error;
      }
      const legs = legDescriptors.map((descriptor) => ({
        ...descriptor,
        controller: new AbortController(),
        reader: void 0,
        stallTimer: void 0,
        abortReason: void 0,
        cancelledByStitcher: false,
        outcome: void 0
      }));
      let headersSettled = false;
      let resolveHeaders;
      let rejectHeaders;
      const headersPromise = new Promise((resolve, reject) => {
        resolveHeaders = resolve;
        rejectHeaders = reject;
      });
      const takeover = {
        headersPromise,
        onHeaders: void 0,
        onBytes: void 0,
        onEnd: void 0,
        onError: void 0,
        cancel: void 0
      };
      const clearLiveLegStall = (leg) => {
        if (leg.stallTimer !== void 0) {
          this.windowObject.clearTimeout(leg.stallTimer);
          leg.stallTimer = void 0;
        }
      };
      const cancelLiveLeg = (leg) => {
        clearLiveLegStall(leg);
        leg.controller.abort();
        if (leg.reader !== void 0) {
          void leg.reader.cancel().catch((error) => {
            if (!isAbortError2(error)) this.reportLiveError("LIVE_CANCEL", "直播流读取取消失败", error);
          });
        }
      };
      const abortAllLegs = () => {
        for (const leg of legs) {
          leg.cancelledByStitcher = true;
          cancelLiveLeg(leg);
        }
      };
      const stitcher = new LiveStreamStitcher({
        streamPath: new URL(url).pathname,
        legs: legs.map((leg) => ({
          slot: leg.slot,
          source: scrubUrl(leg.url),
          mirror: mirrorForUrl2(leg.url)
        })),
        chunkBytes: this.config.chunkBytes,
        now: this.now,
        emitChunk: (payload) => {
          this.emitDiagnostic("bank.fetch.chunk", { ...payload, priority: "foreground" });
        },
        emitStitch: (payload) => {
          this.emitDiagnostic("live.stream.stitch", payload);
        },
        deliver: (bytes) => takeover.onBytes?.(bytes),
        cancelLeg: (slot) => {
          const leg = legs.find((candidate) => candidate.slot === slot);
          if (leg === void 0) return;
          leg.cancelledByStitcher = true;
          cancelLiveLeg(leg);
        },
        failStream: () => {
          abortAllLegs();
          const error = new BankNetworkError("直播流双腿取数失败");
          emitFailedServe(error);
          if (!headersSettled) {
            headersSettled = true;
            rejectHeaders(error);
            return;
          }
          takeover.onError?.(error);
        },
        closeStream: () => takeover.onEnd?.()
      });
      let cancelled = false;
      takeover.cancel = () => {
        if (cancelled) return;
        cancelled = true;
        stitcher.abortStream();
        abortAllLegs();
        if (!headersSettled) {
          headersSettled = true;
          rejectHeaders(abortError2());
          return;
        }
        takeover.onError?.(abortError2());
      };
      if (signal !== void 0) {
        signal.addEventListener("abort", () => takeover.cancel(), { once: true });
      }
      const noteHeaders = (leg, response) => {
        if (headersSettled) return;
        headersSettled = true;
        const served = {
          source: scrubUrl(url),
          mirror: mirrorForUrl2(url),
          durationMs: performanceNow(this.windowObject) - startedAt,
          result: "hit",
          reason: legs.length > 1 ? "live_stream" : "live_stream_unpaired"
        };
        if (legs.length > 1) served.pairedAddressAvailable = true;
        else if (pairDecision.miss !== void 0) served.pairMiss = pairDecision.miss;
        this.emitDiagnostic("bank.serve", served);
        const info = {
          status: response.status,
          statusText: response.statusText,
          contentType: headerValue(response.headers, "Content-Type") || void 0
        };
        takeover.onHeaders?.(info);
        resolveHeaders(info);
      };
      for (const leg of legs) {
        void this.runLiveLeg(leg, { credentials, stitcher, noteHeaders }).catch((error) => {
          emitFailedServe(error);
          this.reportLiveError("LIVE_LEG", "直播流腿执行失败", error);
        });
      }
      return takeover;
    }
    // HLS 直播分片接管：整段文件双腿竞速（视频页分片同形）。身份门未决的首个竞速
    // 分片对等双腿收齐后整体比对，一致才开放竞速；不一致或门期反复无法完整比对则
    // 永久降级为播放器所名地址单腿。双腿全灭或签名到期且无新地址时显式失败。
    // fMP4 分片另有第三腿（slot 2）：FLV 后备已校准且播放列表给出该分片的 AUX 值时，
    // 从 FLV 帧拼出同一分片，长度与 CRC32 都对上才交付；先完整到手且已核对的一腿胜出。
    serveLiveSegment({ url, credentials, signal }) {
      if (signal?.aborted) throw abortError2();
      const startedAt = performanceNow(this.windowObject);
      const playerUrl = new URL(url);
      const streamPath = hlsStreamPathOf(playerUrl.pathname);
      const segmentName = playerUrl.pathname.slice(playerUrl.pathname.lastIndexOf("/") + 1);
      const aux = this.livePlaylistAuxFor(streamPath, segmentName);
      const backup = segmentName.endsWith(".m4s") ? this.ensureLiveFlvBackup(streamPath, credentials) : void 0;
      let serveFailed = false;
      const emitFailedServe = (error) => {
        if (serveFailed) return;
        serveFailed = true;
        this.emitDiagnostic("bank.serve", {
          source: scrubUrl(url),
          mirror: mirrorForUrl2(url),
          durationMs: performanceNow(this.windowObject) - startedAt,
          result: "failed",
          reason: "live_hls_segment_failed",
          errorName: error?.name
        });
      };
      const knownIdentity = this.liveSegmentIdentity.get(streamPath);
      let pairDecision = { pairUrl: void 0, miss: void 0 };
      if (knownIdentity?.verdict !== "rejected" && this.config.raceLegs > 1) {
        pairDecision = this.pairSegmentDecisionFor(playerUrl);
        if (pairDecision.pairUrl === void 0) {
          this.readInlineLivePlayinfo();
          pairDecision = this.pairSegmentDecisionFor(playerUrl);
        }
      }
      const pairUrl = pairDecision.pairUrl;
      const candidateUrls = pairUrl === void 0 ? [url] : [url, pairUrl];
      const legDescriptors = [];
      for (const [slot, candidate] of candidateUrls.entries()) {
        const expiresAt = liveUrlExpiresAt(candidate);
        if (expiresAt !== void 0 && this.now() >= expiresAt) {
          this.emitDiagnostic("bank.fetch.chunk", {
            source: scrubUrl(candidate),
            mirror: mirrorForUrl2(candidate),
            chunkIndex: 0,
            start: 0,
            end: 0,
            bytes: 0,
            durationMs: 0,
            slot,
            priority: "foreground",
            result: "address_expired"
          });
          continue;
        }
        legDescriptors.push({ slot, url: candidate });
      }
      if (legDescriptors.length === 0) {
        const error = new BankNetworkError("直播分片地址签名到期且无可用地址");
        emitFailedServe(error);
        throw error;
      }
      const legs = legDescriptors.map((descriptor) => ({
        ...descriptor,
        controller: new AbortController(),
        reader: void 0,
        stallTimer: void 0,
        startedAt: void 0,
        ttfbAt: void 0,
        byteCount: 0,
        httpStatus: void 0,
        errorName: void 0,
        outcome: void 0,
        cancelledByWinner: false
      }));
      const rebuildLeg = backup?.ready === true && aux !== void 0 ? {
        slot: 2,
        url,
        mirror: backup.mirror,
        startedAt: performanceNow(this.windowObject),
        ttfbAt: void 0,
        byteCount: 0,
        settled: false,
        request: backup.requestSegment(aux)
      } : void 0;
      let headersSettled = false;
      let resolveHeaders;
      let rejectHeaders;
      const headersPromise = new Promise((resolve, reject) => {
        resolveHeaders = resolve;
        rejectHeaders = reject;
      });
      const takeover = {
        headersPromise,
        onHeaders: void 0,
        onBytes: void 0,
        onEnd: void 0,
        onError: void 0,
        cancel: void 0
      };
      let finished = false;
      let cancelled = false;
      let deferredFailure;
      const emitSegmentChunk = (leg, result, detail = {}) => {
        const payload = {
          source: scrubUrl(leg.url),
          mirror: leg.mirror ?? mirrorForUrl2(leg.url),
          chunkIndex: 0,
          start: 0,
          end: leg.byteCount > 0 ? leg.byteCount - 1 : 0,
          bytes: leg.byteCount,
          durationMs: leg.startedAt === void 0 ? 0 : performanceNow(this.windowObject) - leg.startedAt,
          slot: leg.slot,
          priority: "foreground",
          result
        };
        if (leg.byteCount > 0 && leg.ttfbAt !== void 0) payload.ttfbMs = leg.ttfbAt - leg.startedAt;
        if (Number.isInteger(detail.httpStatus)) payload.httpStatus = detail.httpStatus;
        if (typeof detail.errorName === "string" && detail.errorName.length > 0) payload.errorName = detail.errorName;
        this.emitDiagnostic("bank.fetch.chunk", payload);
      };
      const emitSegmentServeHit = (winner) => {
        const served = {
          source: scrubUrl(url),
          mirror: mirrorForUrl2(url),
          durationMs: performanceNow(this.windowObject) - startedAt,
          result: "hit",
          reason: legs.length > 1 ? "live_hls_segment" : "live_hls_segment_unpaired",
          winner
        };
        if (legs.length > 1) served.pairedAddressAvailable = true;
        else if (pairDecision.miss !== void 0) served.pairMiss = pairDecision.miss;
        this.emitDiagnostic("bank.serve", served);
      };
      const clearSegmentLegStall = (leg) => {
        if (leg.stallTimer !== void 0) {
          this.windowObject.clearTimeout(leg.stallTimer);
          leg.stallTimer = void 0;
        }
      };
      const cancelSegmentLeg = (leg) => {
        clearSegmentLegStall(leg);
        leg.controller.abort();
        if (leg.reader !== void 0) {
          void leg.reader.cancel().catch((error) => {
            if (!isAbortError2(error)) this.reportLiveError("LIVE_CANCEL", "直播分片读取取消失败", error);
          });
        }
      };
      const settleHeaders = (info) => {
        if (headersSettled) return;
        headersSettled = true;
        takeover.onHeaders?.(info);
        resolveHeaders(info);
      };
      const deliverSegment = (leg, value) => {
        if (finished) {
          if (!cancelled) emitSegmentChunk(leg, "lost_race");
          return;
        }
        finished = true;
        const rebuilt = leg === rebuildLeg;
        if (rebuilt) settleHeaders(backup.lastHeaders);
        emitSegmentChunk(leg, "fetched");
        emitSegmentServeHit(rebuilt ? "flv_rebuild" : "network");
        for (const other of legs) {
          if (other === leg || other.outcome !== void 0) continue;
          other.cancelledByWinner = true;
          cancelSegmentLeg(other);
        }
        if (!rebuilt) rebuildLeg?.request.cancel();
        takeover.onBytes?.(value.bytes);
        takeover.onEnd?.();
        if (!rebuilt && aux !== void 0 && backup !== void 0) {
          backup.noteNetworkSegment({
            aux,
            bytes: value.bytes,
            headers: { status: value.status, statusText: value.statusText, contentType: value.contentType }
          });
        }
        if (!rebuilt && segmentName === this.livePlaylists.get(streamPath)?.mapUri) {
          this.noteLiveInitSegment(streamPath, value.bytes);
        }
      };
      const failSegment = (error) => {
        if (finished) return;
        if (rebuildLeg !== void 0 && !rebuildLeg.settled) {
          deferredFailure = error;
          return;
        }
        finished = true;
        for (const leg of legs) clearSegmentLegStall(leg);
        emitFailedServe(error);
        if (!headersSettled) {
          headersSettled = true;
          rejectHeaders(error);
          return;
        }
        takeover.onError?.(error);
      };
      takeover.cancel = () => {
        if (cancelled || finished) return;
        cancelled = true;
        finished = true;
        rebuildLeg?.request.cancel();
        for (const leg of legs) {
          clearSegmentLegStall(leg);
          leg.controller.abort();
          if (leg.reader !== void 0) {
            void leg.reader.cancel().catch((error) => {
              if (!isAbortError2(error)) this.reportLiveError("LIVE_CANCEL", "直播分片读取取消失败", error);
            });
          }
        }
        if (!headersSettled) {
          headersSettled = true;
          rejectHeaders(abortError2());
          return;
        }
        takeover.onError?.(abortError2());
      };
      if (signal !== void 0) {
        signal.addEventListener("abort", () => takeover.cancel(), { once: true });
      }
      const noteHeaders = (leg, response) => {
        settleHeaders({
          status: response.status,
          statusText: response.statusText,
          contentType: headerValue(response.headers, "Content-Type") || void 0
        });
      };
      if (rebuildLeg !== void 0) {
        rebuildLeg.request.promise.then(
          (value) => {
            rebuildLeg.settled = true;
            rebuildLeg.byteCount = value.bytes.byteLength;
            deliverSegment(rebuildLeg, value);
          },
          (error) => {
            rebuildLeg.settled = true;
            if (error instanceof FlvRebuildFailure) {
              rebuildLeg.byteCount = error.bytes;
              emitSegmentChunk(rebuildLeg, error.result);
            } else if (isAbortError2(error)) {
              emitSegmentChunk(rebuildLeg, cancelled ? "aborted" : "lost_race");
            } else {
              throw error;
            }
            if (deferredFailure !== void 0) failSegment(deferredFailure);
          }
        ).catch((error) => {
          this.reportLiveError("LIVE_LEG", "直播分片拼接腿执行失败", error);
        });
      }
      const settlements = legs.map((leg) => this.runLiveSegmentLeg(leg, { credentials, noteHeaders }).then(
        (value) => ({ kind: "done", leg, value }),
        (error) => ({ kind: "failed", leg, error })
      ));
      void this.settleLiveSegment({
        url,
        streamPath,
        legs,
        settlements,
        identity: pairUrl === void 0 ? void 0 : this.liveSegmentIdentityFor(streamPath),
        maxGateAttempts: this.config.maxChunkAttempts,
        emitSegmentChunk,
        deliverSegment,
        failSegment
      });
      return takeover;
    }
    async settleLiveSegment({
      streamPath,
      legs,
      settlements,
      identity,
      maxGateAttempts,
      emitSegmentChunk,
      deliverSegment,
      failSegment
    }) {
      const settlementOf = (leg) => settlements[legs.indexOf(leg)];
      const emitFailure = (settlement) => {
        let fallback = isAbortError2(settlement.error) ? "aborted" : "network_error";
        if (settlement.leg.cancelledByWinner) fallback = "lost_race";
        emitSegmentChunk(settlement.leg, settlement.leg.outcome ?? fallback, {
          httpStatus: settlement.leg.httpStatus,
          errorName: settlement.leg.errorName ?? settlement.error?.name
        });
      };
      if (legs.length === 1) {
        const settlement = await settlements[0];
        if (settlement.kind === "done") {
          deliverSegment(settlement.leg, settlement.value);
          return;
        }
        emitFailure(settlement);
        failSegment(new BankNetworkError("直播分片取数失败", settlement.error));
        return;
      }
      const [first, second] = legs;
      if (identity.verdict === "verified") {
        const winner = await Promise.race(settlements);
        if (winner.kind === "done") {
          deliverSegment(winner.leg, winner.value);
          const loserSettlement = await settlementOf(winner.leg === first ? second : first);
          if (loserSettlement.kind === "done" || loserSettlement.leg.outcome === void 0) {
            emitSegmentChunk(loserSettlement.leg, "lost_race");
          } else {
            emitFailure(loserSettlement);
          }
          return;
        }
        emitFailure(winner);
        const last = await settlementOf(winner.leg === first ? second : first);
        if (last.kind === "done") {
          deliverSegment(last.leg, last.value);
          return;
        }
        emitFailure(last);
        failSegment(new BankNetworkError("直播分片双腿取数失败"));
        return;
      }
      const firstSettlement = await Promise.race(settlements);
      const secondSettlement = await settlementOf(firstSettlement.leg === first ? second : first);
      if (firstSettlement.kind === "done" && secondSettlement.kind === "done") {
        const mismatchAt = compareSegmentBytes(
          firstSettlement.value.bytes,
          secondSettlement.value.bytes
        );
        if (mismatchAt === -1) {
          identity.verdict = "verified";
          this.emitDiagnostic("live.stream.stitch", {
            streamPath,
            bytesChecked: firstSettlement.value.bytes.byteLength,
            mismatch: false,
            phase: "segment"
          });
          deliverSegment(firstSettlement.leg, firstSettlement.value);
          emitSegmentChunk(secondSettlement.leg, "lost_race");
          return;
        }
        identity.verdict = "rejected";
        this.emitDiagnostic("live.stream.stitch", {
          streamPath,
          bytesChecked: mismatchAt + 1,
          mismatch: true,
          phase: "segment"
        });
        const playerSettlement = firstSettlement.leg === first ? firstSettlement : secondSettlement;
        const otherSettlement = playerSettlement === firstSettlement ? secondSettlement : firstSettlement;
        deliverSegment(playerSettlement.leg, playerSettlement.value);
        emitSegmentChunk(otherSettlement.leg, "lost_race");
        return;
      }
      if (firstSettlement.kind === "failed") emitFailure(firstSettlement);
      if (secondSettlement.kind === "failed") emitFailure(secondSettlement);
      if (firstSettlement.kind === "failed" && secondSettlement.kind === "failed") {
        failSegment(new BankNetworkError("直播分片双腿取数失败"));
        return;
      }
      const survivor = firstSettlement.kind === "done" ? firstSettlement : secondSettlement;
      const casualty = survivor === firstSettlement ? secondSettlement : firstSettlement;
      if (!casualty.leg.cancelledByWinner) {
        identity.attempts += 1;
        if (identity.attempts >= maxGateAttempts) identity.verdict = "rejected";
      }
      deliverSegment(survivor.leg, survivor.value);
    }
    async runLiveSegmentLeg(leg, { credentials, noteHeaders }) {
      const armStall = () => {
        if (leg.stallTimer !== void 0) this.windowObject.clearTimeout(leg.stallTimer);
        leg.stallTimer = this.windowObject.setTimeout(() => {
          if (leg.controller.signal.aborted) return;
          leg.abortReason = "stalled";
          leg.outcome = "stalled";
          leg.controller.abort();
          if (leg.reader !== void 0) {
            void leg.reader.cancel().catch((error) => {
              if (!isAbortError2(error)) this.reportLiveError("LIVE_CANCEL", "直播分片停滞读取取消失败", error);
            });
          }
        }, this.config.stallMs);
      };
      armStall();
      leg.startedAt = performanceNow(this.windowObject);
      try {
        let response;
        try {
          response = await this.nativeFetch.call(this.windowObject, leg.url, {
            credentials,
            signal: leg.controller.signal
          });
        } catch (error) {
          if (isAbortError2(error) || leg.controller.signal.aborted) throw error;
          leg.outcome = "network_error";
          leg.errorName = error?.name;
          throw new BankNetworkError("直播分片网络取数失败", error);
        }
        if (leg.controller.signal.aborted) throw abortError2();
        if (response.status < 200 || response.status >= 300) {
          leg.outcome = "http_error";
          leg.httpStatus = response.status;
          throw new BankNetworkError(`直播分片网络响应状态无效: ${response.status}`);
        }
        noteHeaders(leg, response);
        const reader = response.body.getReader();
        leg.reader = reader;
        armStall();
        const bodyChunks = [];
        try {
          for (; ; ) {
            const read = await reader.read();
            if (read.done) break;
            if (read.value.byteLength > 0) {
              if (leg.ttfbAt === void 0) leg.ttfbAt = performanceNow(this.windowObject);
              bodyChunks.push(read.value.slice());
              leg.byteCount += read.value.byteLength;
              armStall();
            }
            if (leg.controller.signal.aborted) throw abortError2();
          }
        } catch (error) {
          if (isAbortError2(error) || leg.controller.signal.aborted) throw error;
          leg.outcome = "network_error";
          leg.errorName = error?.name;
          throw new BankNetworkError("直播分片响应读取失败", error);
        }
        if (leg.controller.signal.aborted) throw abortError2();
        const bytes = new Uint8Array(leg.byteCount);
        let offset = 0;
        for (const chunk of bodyChunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return {
          bytes,
          status: response.status,
          statusText: response.statusText,
          contentType: headerValue(response.headers, "Content-Type") || void 0
        };
      } finally {
        if (leg.stallTimer !== void 0) {
          this.windowObject.clearTimeout(leg.stallTimer);
          leg.stallTimer = void 0;
        }
      }
    }
    async runLiveLeg(leg, { credentials, stitcher, noteHeaders }) {
      const armStall = () => {
        if (leg.stallTimer !== void 0) this.windowObject.clearTimeout(leg.stallTimer);
        leg.stallTimer = this.windowObject.setTimeout(() => {
          if (leg.controller.signal.aborted) return;
          leg.abortReason = "stalled";
          leg.controller.abort();
          if (leg.reader !== void 0) {
            void leg.reader.cancel().catch((error) => {
              if (!isAbortError2(error)) this.reportLiveError("LIVE_CANCEL", "直播停滞读取取消失败", error);
            });
          }
        }, this.config.stallMs);
      };
      armStall();
      try {
        let response;
        try {
          response = await this.nativeFetch.call(this.windowObject, leg.url, {
            credentials,
            signal: leg.controller.signal
          });
        } catch (error) {
          if (isAbortError2(error) || leg.controller.signal.aborted) throw error;
          leg.outcome = "network_error";
          stitcher.noteLegDead(leg.slot, "network_error", { errorName: error?.name });
          return;
        }
        if (leg.controller.signal.aborted) throw abortError2();
        if (response.status < 200 || response.status >= 300) {
          leg.outcome = "http_error";
          stitcher.noteLegDead(leg.slot, "http_error", { httpStatus: response.status });
          return;
        }
        noteHeaders(leg, response);
        try {
          const reader = response.body.getReader();
          leg.reader = reader;
          armStall();
          for (; ; ) {
            const read = await reader.read();
            if (read.done) break;
            const chunk = read.value.slice();
            if (chunk.byteLength > 0) {
              stitcher.noteLegBytes(leg.slot, chunk);
              armStall();
            }
            if (leg.controller.signal.aborted) throw abortError2();
          }
          if (leg.controller.signal.aborted) throw abortError2();
          stitcher.noteLegDone(leg.slot);
        } catch (error) {
          if (isAbortError2(error) || leg.controller.signal.aborted) throw error;
          leg.outcome = "network_error";
          stitcher.noteLegDead(leg.slot, "network_error", { errorName: error?.name });
          return;
        }
      } catch (error) {
        if (isAbortError2(error) || leg.controller.signal.aborted) {
          if (leg.abortReason === "stalled" && !leg.cancelledByStitcher) {
            stitcher.noteLegDead(leg.slot, "stalled");
          }
          return;
        }
        throw error;
      } finally {
        if (leg.stallTimer !== void 0) {
          this.windowObject.clearTimeout(leg.stallTimer);
          leg.stallTimer = void 0;
        }
      }
    }
    readStoredRange(bankKeyValue, start, end) {
      return readMemoryRange(this.chunks, bankKeyValue, start, end, this.config.chunkBytes);
    }
    recordTotalSize(url, totalSize) {
      this.stateFor(bankKey(url)).totalSize = totalSize;
    }
    createResponse(bytes, start, end, totalSize, url) {
      const ResponseConstructor = responseTypeConstructor(this.windowObject, "Response");
      const response = new ResponseConstructor(bytes, {
        status: 206,
        statusText: "Partial Content",
        headers: partialResponseHeaders(start, end, totalSize)
      });
      Object.defineProperty(response, "url", { configurable: true, value: url });
      Object.defineProperty(response, "type", { configurable: true, value: "basic" });
      return response;
    }
    async serveRequest({ url, headers, credentials, signal }) {
      const startedAt = performanceNow(this.windowObject);
      const classification = this.requestClassification(url, headers);
      if (!classification.intercepted) return { intercepted: false };
      if (signal?.aborted) throw abortError2();
      const { start, end } = classification.range;
      const resourceKey = bankKey(url);
      this.touchResource(resourceKey);
      const state = this.stateFor(resourceKey);
      state.videoKey = this.windowObject.location.pathname;
      state.latestUrl = url;
      state.credentials = credentials || "same-origin";
      state.lastForegroundStart = start;
      state.lastForegroundEnd = end;
      const stored = this.readStoredRange(resourceKey, start, end);
      if (signal?.aborted) throw abortError2();
      if (stored?.hit === true) {
        if (!(stored.bytes instanceof ArrayBuffer) || stored.bytes.byteLength !== rangeLength({ start, end })) {
          throw new BankFallbackError("媒体分片存储命中长度不符");
        }
        if (!Number.isSafeInteger(stored.totalSize) || stored.totalSize <= end) {
          throw new BankFallbackError("媒体分片存储命中总长度无效");
        }
        state.totalSize = stored.totalSize;
        this.scheduleResourceWindow(state);
        const response = this.createResponse(stored.bytes, start, end, stored.totalSize, url);
        this.emitDiagnostic("bank.serve", {
          source: scrubUrl(url),
          mirror: mirrorForUrl2(url),
          start,
          end,
          durationMs: performanceNow(this.windowObject) - startedAt,
          result: "hit",
          reason: "stored_range"
        });
        return {
          intercepted: true,
          response,
          bytes: stored.bytes,
          totalSize: stored.totalSize
        };
      }
      const requestPlans = planFetchRanges(start, end, {
        chunkBytes: this.config.chunkBytes,
        totalSize: state.totalSize,
        bankKeyValue: resourceKey
      });
      const missingPlans = requestPlans.filter((plan) => !this.chunks.has(plan.cacheKey));
      const gaveUpPlans = missingPlans.filter((plan) => {
        const attempts = state.chunkAttempts.get(plan.chunkIndex) || 0;
        return attempts >= this.config.maxChunkAttempts;
      });
      const foreground = { start, end, state, completed: false };
      state.outstanding.add(foreground);
      const completeOnAbort = () => this.completeForegroundRequest(foreground);
      signal?.addEventListener("abort", completeOnAbort, { once: true });
      try {
        if (gaveUpPlans.length > 0) {
          for (const plan of gaveUpPlans) {
            this.emitTaskChunkDiagnostic(
              { ...plan, url, kind: "foreground" },
              0,
              0,
              "gave_up"
            );
          }
          for (const plan of missingPlans) state.chunkAttempts.delete(plan.chunkIndex);
          throw new BankNetworkError("媒体分片连续取数失败，已达到尝试上限");
        }
        for (const plan of missingPlans) state.chunkAttempts.delete(plan.chunkIndex);
        this.scheduleResourceWindow(state);
        await Promise.all(missingPlans.map((plan) => this.getTask(plan, {
          kind: "foreground",
          url,
          credentials: state.credentials,
          videoKey: state.videoKey
        })));
        if (signal?.aborted) throw abortError2();
        const supplied = this.readStoredRange(resourceKey, start, end);
        if (supplied?.hit !== true) {
          throw new BankNetworkError("媒体分片取数完成后未找到完整分片");
        }
        if (!(supplied.bytes instanceof ArrayBuffer) || supplied.bytes.byteLength !== rangeLength({ start, end })) {
          throw new BankFallbackError("媒体分片供数长度不符");
        }
        if (!Number.isSafeInteger(supplied.totalSize) || supplied.totalSize <= end) {
          throw new BankFallbackError("媒体分片供数总长度无效");
        }
        state.totalSize = supplied.totalSize;
        const response = this.createResponse(supplied.bytes, start, end, supplied.totalSize, url);
        this.emitDiagnostic("bank.serve", {
          source: scrubUrl(url),
          mirror: mirrorForUrl2(url),
          start,
          end,
          durationMs: performanceNow(this.windowObject) - startedAt,
          result: "hit",
          reason: "fetched_range"
        });
        return {
          intercepted: true,
          response,
          bytes: supplied.bytes,
          totalSize: supplied.totalSize,
          release: () => {
            signal?.removeEventListener("abort", completeOnAbort);
            this.completeForegroundRequest(foreground);
          }
        };
      } catch (error) {
        signal?.removeEventListener("abort", completeOnAbort);
        this.completeForegroundRequest(foreground, false);
        throw error;
      }
    }
    completeForegroundRequest(request, schedule = true) {
      if (request.completed) return;
      request.completed = true;
      request.state.outstanding.delete(request);
      if (schedule && this.resourceState.get(request.state.bankKey) === request.state) {
        this.scheduleResourceWindow(request.state);
      }
    }
    anchorChunkForState(state) {
      const outstanding = [...state.outstanding];
      if (outstanding.length > 0) {
        return Math.min(...outstanding.map((request) => chunkIndex(request.start, this.config.chunkBytes)));
      }
      if (!Number.isSafeInteger(state.lastForegroundStart)) return void 0;
      return chunkIndex(state.lastForegroundStart, this.config.chunkBytes);
    }
    windowPlansForState(state, anchorChunk) {
      const start = anchorChunk * this.config.chunkBytes;
      const end = (anchorChunk + this.config.lookAheadChunks) * this.config.chunkBytes - 1;
      return planFetchRanges(start, end, {
        chunkBytes: this.config.chunkBytes,
        totalSize: state.totalSize,
        bankKeyValue: state.bankKey
      });
    }
    supersedeTasksBefore(bankKeyValue, anchorChunk) {
      for (const task of this.inflight.values()) {
        if (task.bankKey !== bankKeyValue || task.chunkIndex >= anchorChunk || task.controller.signal.aborted) continue;
        task.abortReason = "superseded";
        this.clearTaskStall(task);
        task.controller.abort();
      }
    }
    scheduleResourceWindow(state) {
      if (!this.isEnabled()) return;
      const anchorChunk = this.anchorChunkForState(state);
      if (anchorChunk === void 0 || state.latestUrl === void 0) return;
      this.supersedeTasksBefore(state.bankKey, anchorChunk);
      const candidates = this.windowPlansForState(state, anchorChunk).filter((plan) => {
        if (this.chunks.has(plan.cacheKey)) return false;
        const attempts = state.chunkAttempts.get(plan.chunkIndex) || 0;
        return attempts < this.config.maxChunkAttempts;
      });
      for (const plan of candidates.slice(0, this.maxPrefetchConcurrency)) {
        if (this.inflight.has(plan.cacheKey)) continue;
        void this.getTask(plan, {
          kind: "prefetch",
          url: state.latestUrl,
          credentials: state.credentials,
          videoKey: state.videoKey
        }).catch((error) => {
          if (isAbortError2(error) || error instanceof BankNetworkError || error instanceof BankFallbackError) return;
          throw error;
        });
      }
      this.pump();
    }
    disable(reason) {
      if (this.disabled) return;
      this.disabled = true;
      this.enabled = false;
      this.abortPrefetchTasks();
      for (const task of this.queue) {
        task.controller.abort();
        task.settled = true;
        task.reject(abortError2());
        if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
      }
      this.queue = [];
      this.closeLiveFlvBackup();
      this.emitDiagnostic("bank.disabled", { reason });
    }
    clearLegStall(leg) {
      if (leg.stallTimer !== void 0) {
        this.windowObject.clearTimeout(leg.stallTimer);
        leg.stallTimer = void 0;
      }
      leg.reader = void 0;
    }
    clearTaskStall(task) {
      for (const leg of task.legs) this.clearLegStall(leg);
    }
    armLegStall(task, leg) {
      if (leg.stallTimer !== void 0) this.windowObject.clearTimeout(leg.stallTimer);
      leg.stallTimer = this.windowObject.setTimeout(() => {
        if (task.settled || leg.settled || leg.controller.signal.aborted) return;
        leg.abortReason = "stalled";
        leg.controller.abort();
        if (leg.reader !== void 0) {
          void leg.reader.cancel().catch((error) => {
            if (!isAbortError2(error)) console.error("[BilibiliBuffer] 停滞媒体分片读取取消失败", error);
          });
        }
      }, this.config.stallMs);
    }
    emitTaskAbortDiagnostic(task, leg, bytes, durationMs, result) {
      if (leg.abortReported === true) return;
      leg.abortReported = true;
      this.emitChunkDiagnostic(task, leg, bytes, durationMs, result);
    }
    taskAbortError(task, leg, error) {
      const result = task.abortReason === "superseded" ? "superseded" : leg.abortReason === "stalled" ? "stalled" : "aborted";
      this.emitTaskAbortDiagnostic(
        task,
        leg,
        leg.byteCount,
        performanceNow(this.windowObject) - leg.startedAt,
        result
      );
      return error;
    }
    recordTaskFailure(task, error) {
      if (task.sessionGeneration !== this.sessionGeneration) return;
      if (task.abortReason !== void 0 && task.abortReason !== "stalled") return;
      if (isAbortError2(error) && task.abortReason !== "stalled" && !task.legs.some((leg) => leg.outcome === "stalled")) return;
      const state = this.resourceState.get(task.bankKey);
      if (state === void 0) return;
      const attempts = state.chunkAttempts.get(task.chunkIndex) || 0;
      state.chunkAttempts.set(task.chunkIndex, attempts + 1);
    }
    resetTaskAttempts(task) {
      if (task.sessionGeneration !== this.sessionGeneration) return;
      const state = this.resourceState.get(task.bankKey);
      if (state !== void 0) state.chunkAttempts.delete(task.chunkIndex);
    }
    startTask(task) {
      task.started = true;
      this.activePrefetch.add(task);
      let succeeded = false;
      void this.runTask(task).then((result) => {
        succeeded = true;
        if (!task.settled) {
          task.settled = true;
          task.resolve(result);
        }
      }, (error) => {
        this.recordTaskFailure(task, error);
        task.settled = true;
        task.reject(error);
      }).finally(() => {
        this.clearTaskStall(task);
        this.activePrefetch.delete(task);
        if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
        if (succeeded && task.sessionGeneration === this.sessionGeneration && this.recentResourceKeys.includes(task.bankKey)) {
          const state = this.resourceState.get(task.bankKey);
          if (state !== void 0) this.scheduleResourceWindow(state);
        }
        this.pump();
      });
    }
    getTask(plan, { kind, url, credentials, videoKey }) {
      const existing = this.inflight.get(plan.cacheKey);
      if (existing !== void 0) return existing.promise;
      if (this.chunks.has(plan.cacheKey)) {
        return Promise.resolve({ skipped: true, cacheKey: plan.cacheKey });
      }
      if (kind === "foreground") {
        const state = this.stateFor(plan.cacheKey.slice(0, plan.cacheKey.lastIndexOf("#")));
        const attempts = state.chunkAttempts.get(plan.chunkIndex) || 0;
        if (attempts >= this.config.maxChunkAttempts) {
          this.emitTaskChunkDiagnostic({ ...plan, url, kind }, 0, 0, "gave_up");
          return Promise.reject(new BankNetworkError("媒体分片连续取数失败，已达到尝试上限"));
        }
      }
      const controller = new AbortController();
      const task = {
        ...plan,
        bankKey: plan.cacheKey.slice(0, plan.cacheKey.lastIndexOf("#")),
        url,
        credentials,
        videoKey,
        kind,
        sessionGeneration: this.sessionGeneration,
        controller,
        started: false,
        abortReason: void 0,
        settled: false,
        legs: [],
        promise: void 0,
        resolve: void 0,
        reject: void 0
      };
      controller.signal.addEventListener("abort", () => {
        for (const leg of task.legs) leg.controller.abort();
      }, { once: true });
      task.promise = new Promise((resolve, reject) => {
        task.resolve = resolve;
        task.reject = reject;
      });
      this.inflight.set(plan.cacheKey, task);
      this.queue.push(task);
      this.pump();
      return task.promise;
    }
    pump() {
      while (this.activePrefetch.size < this.maxPrefetchConcurrency && this.queue.length > 0) {
        const task = this.queue.shift();
        if (task.controller.signal.aborted) {
          if (task.abortReason === "superseded") this.emitTaskChunkDiagnostic(task, 0, 0, "superseded");
          task.settled = true;
          task.reject(abortError2());
          if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
          continue;
        }
        this.startTask(task);
      }
    }
    async runLeg(task, leg) {
      leg.startedAt = performanceNow(this.windowObject);
      this.armLegStall(task, leg);
      try {
        let response;
        try {
          response = await this.nativeFetch.call(this.windowObject, leg.url, {
            headers: { Range: `bytes=${task.start}-${task.end}` },
            credentials: task.credentials,
            signal: leg.controller.signal
          });
        } catch (error) {
          if (isAbortError2(error) || leg.controller.signal.aborted) throw error;
          leg.outcome = "network_error";
          throw new BankNetworkError("媒体分片网络取数失败", error);
        }
        if (leg.controller.signal.aborted) throw abortError2();
        if (response.status < 200 || response.status >= 300) {
          leg.outcome = "http_error";
          throw new BankNetworkError(`媒体分片网络响应状态无效: ${response.status}`);
        }
        const bodyChunks = [];
        try {
          const reader = response.body.getReader();
          leg.reader = reader;
          this.armLegStall(task, leg);
          while (true) {
            const read = await reader.read();
            if (read.done) break;
            const chunk = read.value.slice();
            if (chunk.byteLength > 0) {
              if (leg.ttfbAt === void 0) leg.ttfbAt = performanceNow(this.windowObject);
              bodyChunks.push(chunk);
              leg.byteCount += chunk.byteLength;
              this.armLegStall(task, leg);
            }
            if (leg.controller.signal.aborted) throw abortError2();
          }
          if (leg.controller.signal.aborted) throw abortError2();
        } catch (error) {
          if (isAbortError2(error) || leg.controller.signal.aborted) throw error;
          leg.outcome = "network_error";
          throw new BankNetworkError("媒体分片响应读取失败", error);
        }
        if (leg.controller.signal.aborted) throw abortError2();
        const body = new Uint8Array(leg.byteCount);
        let offset = 0;
        for (const chunk of bodyChunks) {
          body.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const bytes = body.buffer;
        const contentRange = parseContentRange(headerValue(response.headers, "Content-Range"));
        const isCompleteTailChunk = contentRange !== void 0 && contentRange.start === task.start && contentRange.end < task.end && contentRange.end === contentRange.totalSize - 1;
        if (contentRange === void 0 || contentRange.start !== task.start || contentRange.end !== task.end && !isCompleteTailChunk) {
          leg.outcome = "invalid_response";
          throw new BankFallbackError("媒体分片网络 Content-Range 不匹配");
        }
        const resultRange = { start: contentRange.start, end: contentRange.end };
        if (leg.byteCount !== rangeLength(resultRange)) {
          leg.outcome = "invalid_response";
          throw new BankFallbackError("媒体分片网络字节长度不匹配");
        }
        if (leg.controller.signal.aborted) throw abortError2();
        return {
          ...resultRange,
          bytes,
          totalSize: contentRange.totalSize
        };
      } finally {
        this.clearLegStall(leg);
        leg.settled = true;
      }
    }
    classifyTaskFailure(task) {
      if (task.controller.signal.aborted) return abortError2();
      if (task.legs.length === 1 && task.legs[0].outcome === "stalled") return abortError2();
      if (task.legs.every((leg) => leg.outcome === "invalid_response")) {
        return new BankFallbackError("媒体分片所有网络响应均无效");
      }
      return new BankNetworkError("媒体分片网络取数失败");
    }
    emitTaskChunkDiagnostic(task, bytes, durationMs, result, range = task) {
      this.emitChunkDiagnostic(task, {
        slot: 0,
        url: task.url,
        mirror: mirrorForUrl2(task.url),
        byteCount: bytes,
        ttfbAt: void 0,
        startedAt: void 0,
        abortReported: false
      }, bytes, durationMs, result, range);
    }
    async runTask(task) {
      this.buildTaskLegs(task);
      return new Promise((resolve, reject) => {
        let remaining = task.legs.length;
        for (const leg of task.legs) {
          const legPromise = this.runLeg(task, leg);
          void legPromise.catch(() => {
          });
          legPromise.then((result) => {
            if (task.settled) {
              leg.outcome = "lost_race";
              this.emitChunkDiagnostic(
                task,
                leg,
                leg.byteCount,
                performanceNow(this.windowObject) - leg.startedAt,
                "lost_race",
                result
              );
              return;
            }
            task.settled = true;
            for (const loser of task.legs) {
              if (loser === leg) continue;
              loser.abortReason = "lost_race";
              loser.controller.abort();
            }
            for (const loser of task.legs) {
              if (loser === leg || loser.reader === void 0) continue;
              void loser.reader.cancel().catch((error) => {
                if (!isAbortError2(error)) console.error("[BilibiliBuffer] 败选媒体分片读取取消失败", error);
              });
            }
            leg.outcome = "fetched";
            if (task.sessionGeneration === this.sessionGeneration) {
              this.recordTotalSize(leg.url, result.totalSize);
              if (this.isEnabled()) {
                try {
                  this.storeTask(task, result);
                } catch (error) {
                  this.emitDiagnostic("bank.store", {
                    operation: "write",
                    chunkIndex: task.chunkIndex,
                    bytes: result.bytes.byteLength,
                    result: "failed",
                    reason: "write_error"
                  });
                  console.error("[BilibiliBuffer] 媒体分片内存写入失败", error);
                  this.disable("store_write_failed");
                }
                this.resetTaskAttempts(task);
              }
            }
            this.emitChunkDiagnostic(
              task,
              leg,
              leg.byteCount,
              performanceNow(this.windowObject) - leg.startedAt,
              "fetched",
              result
            );
            task.resolve(result);
            resolve(result);
          }, (error) => {
            if (task.settled) {
              leg.outcome = "lost_race";
              this.emitChunkDiagnostic(
                task,
                leg,
                leg.byteCount,
                performanceNow(this.windowObject) - leg.startedAt,
                "lost_race"
              );
              return;
            }
            if (leg.abortReason === "stalled" || task.controller.signal.aborted || isAbortError2(error)) {
              leg.outcome = leg.abortReason === "stalled" ? "stalled" : "aborted";
              this.taskAbortError(task, leg, error);
            } else {
              const result = leg.outcome || "network_error";
              this.emitChunkDiagnostic(
                task,
                leg,
                leg.byteCount,
                performanceNow(this.windowObject) - leg.startedAt,
                result
              );
            }
            remaining -= 1;
            if (remaining === 0) reject(this.classifyTaskFailure(task));
          });
        }
      });
    }
    emitChunkDiagnostic(task, leg, bytes, durationMs, result, range = task) {
      const data = {
        source: scrubUrl(leg.url),
        mirror: mirrorForUrl2(leg.url),
        chunkIndex: task.chunkIndex,
        start: range.start,
        end: range.end,
        bytes,
        durationMs,
        slot: leg.slot,
        priority: task.kind,
        result
      };
      if (leg.byteCount > 0) data.ttfbMs = leg.ttfbAt - leg.startedAt;
      this.emitDiagnostic("bank.fetch.chunk", data);
    }
    publishInventory(routeActive = this.lastRouteWasVideo) {
      const payload = deriveBankInventory({
        chunks: this.chunks,
        resourceState: this.resourceState,
        addressBook: this.addressBook,
        recentResourceKeys: this.recentResourceKeys,
        maxBankBytes: this.config.maxBankBytes,
        maxPrefetchConcurrency: this.maxPrefetchConcurrency,
        queueLength: this.queue.length,
        inflightCount: this.inflight.size,
        disabled: !this.isEnabled(),
        routeActive,
        isPairedAddressAvailable: (url) => this.pairUrlFor(url) !== void 0,
        sessionGeneration: this.sessionGeneration
      });
      const now = this.now();
      const unchanged = sameInventoryPayload(this.lastInventoryPayload, payload);
      if (unchanged && this.lastInventoryPublishedAt !== void 0 && now - this.lastInventoryPublishedAt < INVENTORY_HEARTBEAT_FLOOR_MS) {
        return false;
      }
      this.emitDiagnostic("bank.inventory", payload);
      this.lastInventoryPayload = payload;
      this.lastInventoryPublishedAt = now;
      return true;
    }
    storeTask(task, result) {
      const previous = this.chunks.get(task.cacheKey);
      try {
        const written = writeMemoryChunk({
          chunks: this.chunks,
          bankKey: task.bankKey,
          start: result.start,
          end: result.end,
          totalSize: result.totalSize,
          bytes: result.bytes,
          chunkBytes: this.config.chunkBytes,
          storedAt: this.now()
        });
        const eviction = enforceMemoryLimit({
          chunks: this.chunks,
          maxBankBytes: this.config.maxBankBytes,
          chunkBytes: this.config.chunkBytes,
          currentByteByBank: this.currentByteByBank()
        });
        this.emitDiagnostic("bank.store", {
          operation: "write",
          chunkIndex: written.chunkIndex,
          bytes: written.bytes,
          result: "stored",
          reason: "memory"
        });
        for (const entry of eviction.entries) {
          this.emitDiagnostic("bank.store", {
            operation: "evict",
            chunkIndex: entry.chunkIndex,
            bytes: entry.byteLength,
            result: "evicted",
            reason: eviction.reason
          });
        }
        if (eviction.bytes > 0) {
          this.emitDiagnostic("bank.evict", {
            bytes: eviction.bytes,
            reason: eviction.reason
          });
        }
        return eviction;
      } catch (error) {
        if (previous === void 0) this.chunks.delete(task.cacheKey);
        else this.chunks.set(task.cacheKey, previous);
        throw error;
      }
    }
    async prefetch(routeActive = this.syncRouteLifecycle(), inventoryPublished = false) {
      if (!inventoryPublished) this.publishInventory(routeActive);
      if (!routeActive) {
        this.abortPrefetchTasks();
        return;
      }
      if (!this.isEnabled()) {
        this.abortPrefetchTasks();
        return;
      }
      for (const state of this.resourceState.values()) {
        if (!this.recentResourceKeys.includes(state.bankKey)) continue;
        this.scheduleResourceWindow(state);
      }
    }
    async prefetchTick() {
      const routeActive = this.syncRouteLifecycle();
      this.publishInventory(routeActive);
      return this.prefetch(routeActive, true);
    }
    destroy() {
      if (this.prefetchTimer !== void 0) this.windowObject.clearInterval(this.prefetchTimer);
      for (const task of this.inflight.values()) {
        this.clearTaskStall(task);
        task.controller.abort();
      }
      for (const task of this.queue) {
        task.settled = true;
        task.reject(abortError2());
        if (this.inflight.get(task.cacheKey) === task) this.inflight.delete(task.cacheKey);
      }
      this.queue = [];
      this.closeLiveFlvBackup();
      this.releaseSession();
    }
  };
  function installSegmentBank(windowObject = window) {
    if (!windowObject.location) throw new Error("媒体分片页面位置不可用");
    if (windowObject.__smoothSegmentBank !== void 0) return windowObject.__smoothSegmentBank;
    if (!windowObject.fetch || !windowObject.XMLHttpRequest) throw new Error("页面网络 API 不可用");
    const originalFetch = windowObject.fetch;
    const originalXMLHttpRequest = windowObject.XMLHttpRequest;
    const bank = new SegmentBank({ windowObject, nativeFetch: originalFetch });
    windowObject.fetch = function smoothSegmentBankFetch(...args) {
      return bank.handleFetch(this, args, originalFetch);
    };
    windowObject.XMLHttpRequest = createBankXMLHttpRequestClass({
      windowObject,
      nativeConstructor: originalXMLHttpRequest,
      bank
    });
    const marker = {
      bank,
      installed: true,
      setEnabled(enabled) {
        if (!bank.disabled) bank.enabled = enabled === true;
      },
      destroy() {
        windowObject.fetch = originalFetch;
        windowObject.XMLHttpRequest = originalXMLHttpRequest;
        bank.destroy();
        delete windowObject.__smoothSegmentBank;
      }
    };
    windowObject.__smoothSegmentBank = marker;
    return marker;
  }
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    const locationObject = window.location;
    if (locationObject !== void 0 && (locationObject.hostname === "www.bilibili.com" || isLiveLocation(locationObject))) {
      installSegmentBank(window);
    }
  }
})();
//# sourceMappingURL=bank.js.map
