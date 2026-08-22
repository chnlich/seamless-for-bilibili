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
    vodEnabled: "vodEnabled"
  });
  var VOD_CONFIG = Object.freeze({
    stableBufferSeconds: 120
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

  // src/diagnostics/cdn.js
  var CDN_RESULT_VALUES = Object.freeze([
    "fetched",
    "lost_race",
    "stalled",
    "aborted",
    "superseded",
    "network_error",
    "http_error",
    "invalid_response",
    "gave_up"
  ]);

  // src/diagnostics/log-session.js
  var UNKNOWN_SESSION_ID = "未提供";
  function logSessionFragment(sessionId) {
    if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId === UNKNOWN_SESSION_ID) return "";
    return `#sessionId=${encodeURIComponent(sessionId)}`;
  }

  // src/ui/panel.js
  var STATUS_MESSAGE_VERSION = 2;
  var MODE_LABELS = Object.freeze({ video: "视频" });
  var VIDEO_FIELDS = Object.freeze([
    "mode",
    "state",
    "buffered",
    "target",
    "effective",
    "error"
  ]);
  var VIDEO_STATE_LABELS = Object.freeze({
    WAITING: "等待",
    APPLIED: "已应用",
    UNSUPPORTED: "不支持",
    FAILED: "失败"
  });

  // src/extension/popup-live.js
  var POPUP_ROUTE = Object.freeze({ VIDEO: "video", LIVE: "live" });
  var TOGGLE_LABELS = Object.freeze({ video: "视频增强", live: "直播增强" });
  function popupRouteForTabUrl(urlString) {
    if (typeof urlString !== "string" || urlString.length === 0) return POPUP_ROUTE.VIDEO;
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (error) {
      return POPUP_ROUTE.VIDEO;
    }
    return parsed.hostname === "live.bilibili.com" ? POPUP_ROUTE.LIVE : POPUP_ROUTE.VIDEO;
  }
  function popupToggleLabel(route) {
    return route === POPUP_ROUTE.LIVE ? TOGGLE_LABELS.live : TOGGLE_LABELS.video;
  }
  function applyPopupRoute(documentObject, route) {
    const livePanel = documentObject.querySelector("[data-live-panel]");
    if (livePanel !== null) livePanel.hidden = route !== POPUP_ROUTE.LIVE;
    const label = documentObject.querySelector("[data-vod-toggle-label]");
    if (label !== null) label.textContent = popupToggleLabel(route);
    for (const block of documentObject.querySelectorAll("[data-vod-only]")) {
      block.hidden = route === POPUP_ROUTE.LIVE;
    }
  }
  function emptyLiveFacts() {
    return {
      serveCount: 0,
      pairMissCount: 0,
      stitchCount: 0,
      errorCount: 0,
      latestServe: void 0,
      latestStitch: void 0
    };
  }
  function foldLiveEvent(facts, event) {
    const code = event?.code;
    const data = event?.data !== null && typeof event?.data === "object" ? event.data : {};
    if (code === "bank.serve") {
      facts.serveCount += 1;
      if (typeof data.pairMiss === "string" && data.pairMiss.length > 0) facts.pairMissCount += 1;
      facts.latestServe = {
        result: data.result,
        reason: data.reason,
        durationMs: data.durationMs,
        pairMiss: data.pairMiss,
        pairedAddressAvailable: data.pairedAddressAvailable,
        errorName: data.errorName
      };
      return;
    }
    if (code === "live.stream.stitch") {
      facts.stitchCount += 1;
      facts.latestStitch = {
        mismatch: data.mismatch,
        phase: data.phase,
        bytesChecked: data.bytesChecked
      };
      return;
    }
    if (code === "log.error") facts.errorCount += 1;
  }
  function foldLiveEvents(facts, events) {
    for (const event of events || []) foldLiveEvent(facts, event);
    return facts;
  }
  function textValue(value) {
    return value === void 0 || value === null || value === "" ? "未提供" : String(value);
  }
  function liveServeText(latestServe) {
    if (latestServe === void 0) return "未提供";
    const parts = [textValue(latestServe.result), textValue(latestServe.reason)];
    if (latestServe.pairedAddressAvailable === true) parts.push("pairedAddressAvailable");
    if (latestServe.pairMiss !== void 0) parts.push(latestServe.pairMiss);
    if (latestServe.errorName !== void 0) parts.push(latestServe.errorName);
    return parts.join(" · ");
  }
  function liveStitchText(latestStitch) {
    if (latestStitch === void 0) return "未提供";
    return `${textValue(latestStitch.phase)} · mismatch=${textValue(latestStitch.mismatch)} · bytesChecked=${textValue(latestStitch.bytesChecked)}`;
  }
  function renderLiveFacts(documentObject, container, facts, { error, inFlight = false, hasSession = true } = {}) {
    container.replaceChildren();
    const append = (label, value) => {
      const row = documentObject.createElement("div");
      row.className = "readout-row";
      const name = documentObject.createElement("dt");
      name.textContent = label;
      const valueElement = documentObject.createElement("dd");
      valueElement.textContent = textValue(value);
      row.append(name, valueElement);
      container.append(row);
    };
    if (!hasSession) {
      append("直播事实", "未提供");
      return;
    }
    if (error !== void 0) {
      append("直播事实", `读取失败: ${textValue(error)}`);
      return;
    }
    if (inFlight && facts.serveCount === 0 && facts.stitchCount === 0) {
      append("直播事实", "读取中");
      return;
    }
    append("接管状态", liveServeText(facts.latestServe));
    append("缝合门", liveStitchText(facts.latestStitch));
    append("应答计数", facts.serveCount);
    append("配对缺失", facts.pairMissCount);
    append("缝合计数", facts.stitchCount);
    append("错误计数", facts.errorCount);
  }

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
      "resources"
    ]),
    live: Object.freeze([
      "streamPath",
      "bytesChecked",
      "mismatch",
      "phase",
      "channel",
      "groupCount",
      "flvGroupCount",
      "errorName"
    ]),
    extension: Object.freeze(["action", "reason", "status"]),
    persist: Object.freeze(["status", "batchSize", "eventCount", "message", "code"]),
    log: Object.freeze(["errorName", "message", "code"])
  });

  // src/extension/bridge-contract.js
  var BRIDGE_OPERATIONS = Object.freeze([
    "getCoreSnapshot",
    "callCoreSync"
  ]);
  var BRIDGE_CORE_SYNC_METHODS = Object.freeze(["setStableBufferTime"]);

  // src/bank/inventory.js
  var INVENTORY_HEARTBEAT_FLOOR_MS = 5e3;

  // src/extension/readouts.js
  var OTHER_LIVE_MEDIA_SOURCES_FIELD = [
    "otherLive",
    String.fromCharCode(77, 101, 100, 105, 97),
    "Sources"
  ].join("");
  function inventoryStoppedPublishing(ageMs) {
    return Number.isFinite(ageMs) && ageMs > INVENTORY_HEARTBEAT_FLOOR_MS;
  }

  // src/extension/popup.js
  var PREFERENCES = Object.freeze(Object.values(EXTENSION_PREFERENCES));
  var OTHER_LIVE_MEDIA_SOURCES_FIELD2 = [
    "otherLive",
    String.fromCharCode(77, 101, 100, 105, 97),
    "Sources"
  ].join("");
  var statusElement = document.querySelector("[data-status]");
  var inputs = new Map(
    PREFERENCES.map((name) => [name, document.querySelector(`input[data-preference="${name}"]`)])
  );
  var latestStatusSnapshot;
  var latestReadouts;
  var raceSessionId;
  var raceSummary;
  var raceError;
  var raceQueryInFlight = false;
  var nextRaceQueryAt = 0;
  var popupRoute = POPUP_ROUTE.VIDEO;
  var liveSessionId;
  var liveFacts = emptyLiveFacts();
  var liveAfterEventId = 0;
  var liveError;
  var liveQueryInFlight = false;
  var nextLiveQueryAt = 0;
  var livePanelBodyElement = document.querySelector("[data-live-panel-body]");
  var readoutMediaElement = document.querySelector("[data-readout-media]");
  var readoutBankElement = document.querySelector("[data-readout-bank]");
  var readoutBankTitle = document.querySelector("[data-readout-bank-title]");
  var readoutRaceElement = document.querySelector("[data-readout-race]");
  var readoutDiagnosticsElement = document.querySelector("[data-readout-diagnostics]");
  function displayValue(value) {
    return value === void 0 || value === null || value === "" ? "未提供" : String(value);
  }
  function fieldsForSnapshot(snapshot) {
    return VIDEO_FIELDS;
  }
  function textValue2(value) {
    return value === void 0 || value === null || value === "" ? "未提供" : String(value);
  }
  function numberText(value, suffix = "") {
    return Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : "未提供";
  }
  function integerText(value, suffix = "") {
    return Number.isSafeInteger(value) ? `${value}${suffix}` : "未提供";
  }
  function rangeText(ranges) {
    if (!Array.isArray(ranges)) return "未提供";
    return ranges.map((range) => `${numberText(range.start)}–${numberText(range.end)}`).join(", ") || "无";
  }
  function clearReadout(element) {
    element.replaceChildren();
  }
  function appendRow(element, label, value, { estimate = false } = {}) {
    const row = document.createElement("div");
    row.className = "readout-row";
    const name = document.createElement("dt");
    name.textContent = label;
    const valueElement = document.createElement("dd");
    valueElement.textContent = textValue2(value);
    if (estimate && value !== "未提供") {
      const marker = document.createElement("span");
      marker.className = "estimate-marker";
      marker.textContent = "估算";
      valueElement.append(" ", marker);
    }
    row.append(name, valueElement);
    element.append(row);
  }
  function appendHeading(element, text) {
    const heading = document.createElement("h3");
    heading.textContent = text;
    element.append(heading);
  }
  function lastStallText(lastStall) {
    if (lastStall === void 0 || lastStall === "未提供") return "未提供";
    return `${textValue2(lastStall.kind)} · ${numberText(lastStall.agoMs, " ms 前")}`;
  }
  function renderMediaReadout(media, lastStall) {
    clearReadout(readoutMediaElement);
    if (media === "未提供") {
      appendRow(readoutMediaElement, "读数", "未提供");
      appendRow(readoutMediaElement, "上次停顿", lastStallText(lastStall));
      return;
    }
    appendRow(readoutMediaElement, "交集前向秒数", numberText(media.forwardSeconds, " 秒"));
    appendRow(readoutMediaElement, "短板轨", media.limiterTrack);
    appendRow(readoutMediaElement, "媒体源状态", media.mediaSourceState);
    appendRow(readoutMediaElement, "其他存活媒体源", integerText(media[OTHER_LIVE_MEDIA_SOURCES_FIELD2]));
    appendRow(readoutMediaElement, "readyState", integerText(media.element.readyState));
    appendRow(readoutMediaElement, "networkState", integerText(media.element.networkState));
    appendRow(readoutMediaElement, "当前时间", numberText(media.element.currentTime, " 秒"));
    appendRow(readoutMediaElement, "时长", numberText(media.element.duration, " 秒"));
    appendRow(readoutMediaElement, "倍速", numberText(media.element.playbackRate, "×"));
    appendRow(readoutMediaElement, "分辨率", media.element.resolution === "未提供" ? "未提供" : `${textValue2(media.element.resolution?.width)}×${textValue2(media.element.resolution?.height)}`);
    appendRow(readoutMediaElement, "暂停", media.element.paused);
    appendRow(readoutMediaElement, "结束", media.element.ended);
    appendRow(readoutMediaElement, "上次停顿", lastStallText(lastStall));
    if (media.tracks.length === 0) {
      appendRow(readoutMediaElement, "轨道", "未提供");
      return;
    }
    for (const track of media.tracks) {
      appendHeading(readoutMediaElement, `轨道 ${textValue2(track.track)}`);
      appendRow(readoutMediaElement, "附着", track.attached);
      appendRow(readoutMediaElement, "前向秒数", numberText(track.forwardSeconds, " 秒"));
      appendRow(readoutMediaElement, "ranges", rangeText(track.ranges));
      appendRow(readoutMediaElement, "更新中", track.updating);
      appendRow(readoutMediaElement, "等待追加", numberText(track.pendingSinceMs, " ms"));
      appendRow(readoutMediaElement, "最近追加", numberText(track.lastAppendAgoMs, " ms 前"));
      appendRow(readoutMediaElement, "追加错误", track.appendErrors);
    }
  }
  function renderBankReadout(bank, bankSecondsEstimated) {
    clearReadout(readoutBankElement);
    const stopped = bank !== "未提供" && inventoryStoppedPublishing(bank.ageMs);
    readoutBankTitle.textContent = stopped ? "下载层库存（已停止发布）" : "下载层库存";
    readoutBankTitle.classList.toggle("stale-readout", stopped);
    if (bank === "未提供") {
      appendRow(readoutBankElement, "读数", "未提供");
      return;
    }
    appendRow(readoutBankElement, "库存年龄", numberText(bank.ageMs, " ms"));
    appendRow(readoutBankElement, "sessionGeneration", integerText(bank.sessionGeneration));
    appendRow(readoutBankElement, "已存字节", integerText(bank.storedBytes));
    appendRow(readoutBankElement, "已存块数", integerText(bank.storedChunks));
    appendRow(readoutBankElement, "内存上限", integerText(bank.maxBankBytes));
    appendRow(readoutBankElement, "队列", integerText(bank.queued));
    appendRow(readoutBankElement, "在途", integerText(bank.inflight));
    appendRow(readoutBankElement, "预取并发", integerText(bank.prefetchConcurrency));
    appendRow(readoutBankElement, "已停用", bank.disabled);
    appendRow(readoutBankElement, "视频路由", bank.routeActive);
    appendRow(readoutBankElement, "有配对地址", bank.pairedAddressAvailable);
    for (const resource of bank.resources) {
      appendHeading(readoutBankElement, `${textValue2(resource.label)} · ${textValue2(resource.pathname)}`);
      appendRow(readoutBankElement, "类型", resource.kind);
      appendRow(readoutBankElement, "已存字节", integerText(resource.storedBytes));
      appendRow(readoutBankElement, "已存块数", integerText(resource.storedChunks));
      appendRow(readoutBankElement, "总长度", integerText(resource.totalSize));
      appendRow(readoutBankElement, "前台结束", integerText(resource.lastForegroundEnd));
      appendRow(readoutBankElement, "在途块", integerText(resource.outstanding));
      appendRow(readoutBankElement, "重试块", integerText(resource.retrying));
      appendRow(readoutBankElement, "活跃", resource.active);
      appendRow(
        readoutBankElement,
        "库存秒数",
        numberText(bankSecondsEstimated[resource.pathname], " 秒"),
        { estimate: true }
      );
    }
  }
  function renderRaceReadout(persistence) {
    clearReadout(readoutRaceElement);
    if (persistence === "DEGRADED") {
      appendRow(readoutRaceElement, "提示", "日志写入降级，成绩可能缺事件");
    }
    if (raceQueryInFlight) {
      appendRow(readoutRaceElement, "成绩", "读取中");
      return;
    }
    if (raceError !== void 0) {
      appendRow(readoutRaceElement, "成绩", `读取失败: ${raceError}`);
      return;
    }
    if (raceSummary === void 0) {
      appendRow(
        readoutRaceElement,
        "成绩",
        raceSessionId === void 0 || raceSessionId === "未提供" ? "未提供" : "读取中"
      );
      return;
    }
    if (raceSummary.sampleCount === 0) {
      appendRow(readoutRaceElement, "成绩", "尚无竞速事件");
      return;
    }
    const summary = raceSummary.summary;
    appendRow(readoutRaceElement, "样本数", raceSummary.sampleCount);
    appendRow(readoutRaceElement, "读取截止", raceSummary.maxEventId);
    appendRow(readoutRaceElement, "配对覆盖率", `${(summary.pairCoverage * 100).toFixed(1)}%`);
    appendRow(readoutRaceElement, "浪费字节率", `${(summary.wastedByteRatio * 100).toFixed(1)}%`);
    for (const row of summary.rows) {
      appendHeading(readoutRaceElement, `镜像 ${textValue2(row.mirror)}`);
      appendRow(readoutRaceElement, "竞速进入", row.racesEntered);
      appendRow(readoutRaceElement, "胜出", row.wins);
      appendRow(readoutRaceElement, "胜率", `${(row.winRate * 100).toFixed(1)}%`);
      appendRow(readoutRaceElement, "TTFB P50", numberText(row.ttfbP50, " ms"));
      appendRow(readoutRaceElement, "TTFB P90", numberText(row.ttfbP90, " ms"));
      appendRow(readoutRaceElement, "停滞", row.stalled);
      appendRow(readoutRaceElement, "交付字节", row.bytesDelivered);
    }
    for (const result of CDN_RESULT_VALUES) {
      if (summary.byResult[result] === 0) continue;
      appendRow(readoutRaceElement, result, summary.byResult[result]);
    }
  }
  function renderDiagnosticsReadout(diagnostics) {
    clearReadout(readoutDiagnosticsElement);
    appendRow(readoutDiagnosticsElement, "sessionId", diagnostics?.sessionId);
    appendRow(readoutDiagnosticsElement, "持久化", diagnostics?.persistence);
  }
  function renderReadouts(snapshot) {
    const values = snapshot || {};
    latestReadouts = snapshot;
    renderMediaReadout(values.media || "未提供", values.lastStall || "未提供");
    renderBankReadout(values.bank || "未提供", values.bankSecondsEstimated || {});
    renderRaceReadout(values.diagnostics?.persistence);
    renderDiagnosticsReadout(values.diagnostics);
  }
  function renderSnapshot(snapshot) {
    const values = snapshot || {};
    const fields = fieldsForSnapshot(values);
    for (const field of VIDEO_FIELDS) {
      const element = document.querySelector(`[data-status-field="${field}"]`);
      if (element !== null) element.textContent = fields.includes(field) ? displayValue(values[field]) : "未提供";
    }
  }
  async function activeTab() {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) return void 0;
    return tabs[0];
  }
  async function pollStatus() {
    try {
      const tab = await activeTab();
      if (tab === void 0) {
        latestStatusSnapshot = void 0;
        renderSnapshot(void 0);
        statusElement.textContent = "当前活动页面未提供扩展状态。";
        return;
      }
      const response = await chrome.tabs.sendMessage(tab.id, {
        version: STATUS_MESSAGE_VERSION,
        type: "status:get"
      });
      if (response?.ok === false) throw new Error(response.error?.message || "当前页面拒绝状态请求");
      latestStatusSnapshot = response;
      renderSnapshot(response);
      statusElement.textContent = "状态每 500ms 刷新。";
    } catch (error) {
      latestStatusSnapshot = void 0;
      renderSnapshot(void 0);
      statusElement.textContent = `读取当前页面状态失败: ${displayValue(error?.message || error)}`;
    }
  }
  async function refreshRace(sessionId) {
    if (sessionId === void 0 || sessionId === "未提供") {
      raceSessionId = sessionId;
      raceSummary = void 0;
      raceError = void 0;
      renderRaceReadout(latestReadouts?.diagnostics?.persistence);
      return;
    }
    if (raceSessionId !== sessionId) {
      raceSessionId = sessionId;
      raceSummary = void 0;
      raceError = void 0;
      nextRaceQueryAt = 0;
    }
    if (raceQueryInFlight || Date.now() < nextRaceQueryAt) return;
    raceQueryInFlight = true;
    raceError = void 0;
    renderRaceReadout(latestReadouts?.diagnostics?.persistence);
    try {
      const response = await chrome.runtime.sendMessage({
        version: 1,
        type: "logs:cdn-summary",
        sessionId
      });
      if (response?.ok !== true) throw new Error(response?.error?.message || "CDN summary 请求失败");
      if (raceSessionId !== sessionId) return;
      raceSummary = response;
    } catch (error) {
      if (raceSessionId === sessionId) raceError = textValue2(error?.message || error);
    } finally {
      raceQueryInFlight = false;
      nextRaceQueryAt = Date.now() + 1e3;
      renderRaceReadout(latestReadouts?.diagnostics?.persistence);
    }
  }
  function renderLivePanel() {
    renderLiveFacts(document, livePanelBodyElement, liveFacts, {
      error: liveError,
      inFlight: liveQueryInFlight,
      hasSession: liveSessionId !== void 0 && liveSessionId !== "未提供"
    });
  }
  async function sendLogsRead(message) {
    const response = await chrome.runtime.sendMessage({ version: 1, ...message });
    if (response?.ok !== true) throw new Error(response?.error?.message || "日志服务拒绝请求");
    return response;
  }
  async function refreshLivePanel(sessionId) {
    if (popupRoute !== POPUP_ROUTE.LIVE) return;
    if (sessionId === void 0 || sessionId === "未提供") {
      liveSessionId = sessionId;
      liveFacts = emptyLiveFacts();
      liveAfterEventId = 0;
      liveError = void 0;
      renderLivePanel();
      return;
    }
    if (liveSessionId !== sessionId) {
      liveSessionId = sessionId;
      liveFacts = emptyLiveFacts();
      liveAfterEventId = 0;
      liveError = void 0;
      nextLiveQueryAt = 0;
    }
    if (liveQueryInFlight || Date.now() < nextLiveQueryAt) return;
    liveQueryInFlight = true;
    renderLivePanel();
    try {
      const max = await sendLogsRead({ type: "logs:max-event-id", sessionId });
      let afterEventId = liveAfterEventId;
      for (; ; ) {
        const page = await sendLogsRead({
          type: "logs:events-page",
          limit: 250,
          afterEventId,
          maxEventId: max.maxEventId,
          sessionId
        });
        if (liveSessionId !== sessionId) return;
        foldLiveEvents(liveFacts, page.events);
        if (!page.hasMore) {
          afterEventId = page.nextAfterEventId;
          break;
        }
        const nextAfterEventId = page.nextAfterEventId ?? page.events.at(-1)?.eventId;
        if (!Number.isInteger(nextAfterEventId) || nextAfterEventId <= afterEventId) {
          throw new Error("日志分页没有向前推进");
        }
        afterEventId = nextAfterEventId;
      }
      liveAfterEventId = afterEventId;
      liveError = void 0;
    } catch (error) {
      if (liveSessionId === sessionId) liveError = error?.message || String(error);
    } finally {
      liveQueryInFlight = false;
      nextLiveQueryAt = Date.now() + 1e3;
      renderLivePanel();
    }
  }
  async function pollReadouts() {
    try {
      const tab = await activeTab();
      const route = popupRouteForTabUrl(tab?.url);
      if (route !== popupRoute) {
        popupRoute = route;
        applyPopupRoute(document, popupRoute);
      }
      if (tab === void 0) {
        renderReadouts(void 0);
        await refreshRace(void 0);
        if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(void 0);
        return;
      }
      const response = await chrome.tabs.sendMessage(tab.id, {
        version: STATUS_MESSAGE_VERSION,
        type: "readouts:get"
      });
      if (response?.ok === false) throw new Error(response.error?.message || "当前页面拒绝实时读数请求");
      renderReadouts(response);
      await refreshRace(response?.diagnostics?.sessionId);
      if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(response?.diagnostics?.sessionId);
    } catch (error) {
      renderReadouts(void 0);
      await refreshRace(void 0);
      if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(void 0);
      if (error?.message === "Could not establish connection. Receiving end does not exist.") {
        console.warn("[BilibiliBuffer] 当前活动页面没有实时面板接收端", error);
      } else {
        console.error("[BilibiliBuffer] 读取实时面板失败", error);
      }
    }
  }
  async function loadPreferences() {
    const values = await chrome.storage.local.get(PREFERENCES);
    for (const name of PREFERENCES) inputs.get(name).checked = values[name] !== false;
  }
  for (const name of PREFERENCES) {
    inputs.get(name).addEventListener("change", async (event) => {
      await chrome.storage.local.set({ [name]: event.currentTarget.checked });
      statusElement.textContent = "已保存；刷新页面后生效。";
    });
  }
  document.querySelector("[data-open-logs]").addEventListener("click", () => {
    void (async () => {
      let fragment = "";
      try {
        const tab = await activeTab();
        if (tab !== void 0) {
          const response = await chrome.tabs.sendMessage(tab.id, {
            version: STATUS_MESSAGE_VERSION,
            type: "diagnostics:session-id:get"
          });
          if (response?.ok !== true) throw new Error(response?.error?.message || "当前页面拒绝日志 session 请求");
          fragment = logSessionFragment(response.sessionId);
        }
        await chrome.tabs.create({ url: chrome.runtime.getURL(`logs.html${fragment}`) });
      } catch (error) {
        console.error("[BilibiliBuffer] 打开开发日志失败", error);
        await chrome.tabs.create({ url: chrome.runtime.getURL("logs.html") });
      }
    })();
  });
  void loadPreferences().catch((error) => {
    console.error("[BilibiliBuffer] Popup 读取设置失败", error);
    statusElement.textContent = `读取设置失败: ${displayValue(error?.message || error)}`;
  });
  renderReadouts(void 0);
  void pollStatus();
  void pollReadouts();
  var pollTimer = setInterval(() => {
    void pollStatus();
    void pollReadouts();
  }, 500);
  window.addEventListener("pagehide", () => clearInterval(pollTimer), { once: true });
})();
//# sourceMappingURL=popup.js.map
