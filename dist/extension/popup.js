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

  // src/diagnostics/log-session.js
  var UNKNOWN_SESSION_ID = "未提供";
  function logSessionFragment(sessionId2) {
    if (typeof sessionId2 !== "string" || sessionId2.length === 0 || sessionId2 === UNKNOWN_SESSION_ID) return "";
    return `#sessionId=${encodeURIComponent(sessionId2)}`;
  }

  // src/ui/panel.js
  var STATUS_MESSAGE_VERSION = 2;
  var VIDEO_FIELDS = Object.freeze([
    "state",
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
  function preferenceNames() {
    return Object.values(EXTENSION_PREFERENCES);
  }
  function storedPreferences(values) {
    const result = {};
    for (const name of preferenceNames()) result[name] = values[name] !== false;
    return result;
  }
  async function savePreferenceChange({ name, checked, storageObject }) {
    if (!preferenceNames().includes(name)) throw new Error(`未允许的偏好开关: ${name}`);
    await storageObject.set({ [name]: checked === true });
    return name === EXTENSION_PREFERENCES.vodEnabled;
  }
  function applyPopupRoute(documentObject, route) {
    const livePanel = documentObject.querySelector("[data-live-panel]");
    if (livePanel !== null) livePanel.hidden = route !== POPUP_ROUTE.LIVE;
    for (const block of documentObject.querySelectorAll("[data-vod-only]")) {
      block.hidden = route === POPUP_ROUTE.LIVE;
    }
  }
  function emptyLiveFacts() {
    return {
      serveCount: 0,
      engagement: void 0,
      pairedAddressAvailable: false,
      pairRejected: false,
      flvBackup: void 0
    };
  }

  // src/extension/popup-tabs.js
  async function popupAttachedTab({ windowsApi, tabsApi }) {
    const ownWindow = await windowsApi.getCurrent();
    const tabs = await tabsApi.query({ active: true, windowId: ownWindow.id });
    if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) return void 0;
    return tabs[0];
  }

  // src/extension/popup-view.js
  var SWITCH_OFF_TEXT = Object.freeze({
    videoLabel: "视频增强开关",
    videoOffValue: "已关闭",
    liveOff: "直播增强开关已关闭"
  });
  var NO_PAGE_MESSAGES = Object.freeze({
    loading: "正在读取页面状态…",
    noTab: "请先打开一个 Bilibili 页面，再打开本面板。",
    noReceiver: "这个页面没有运行 Bilibili 增强。请打开 Bilibili 的视频或直播页面；如果页面在扩展安装或更新之前就已打开，刷新这个页面后增强才会运行。",
    readFailed: "读取页面状态失败，请稍后重开面板。",
    preferenceFailed: "读取设置失败，请稍后重开面板。",
    preferenceSaved: "已保存，刷新页面后生效。"
  });
  var TARGET_STATE_WORDS = Object.freeze({
    已应用: "已生效",
    等待: "等待生效",
    不支持: "播放器不支持，未生效",
    失败: "申请失败"
  });
  function shortMirrorName(mirror) {
    if (typeof mirror !== "string" || mirror.length === 0) return "未知线路";
    const labels = mirror.split(".").filter((label) => label.length > 0);
    const body = labels.length > 2 ? labels.slice(0, -2).join(".") : mirror;
    const trimmed = body.replace(/^upos-/, "").replace(/^[a-z]+\d*--/, "");
    return trimmed.length >= 3 ? trimmed : mirror;
  }
  var LINE_FAILURE_TEXTS = Object.freeze({
    invalid_response: "数据没给全就断开",
    stalled: "10 秒没有收到数据",
    network_error: "连接失败",
    http_error: "服务器返回错误",
    address_expired: "地址已过期"
  });
  var DOWNLOAD_CARD_TEXT = Object.freeze({
    noRecords: "还没有下载数据",
    noSession: "还没有线路数据",
    loading: "正在读取线路状态…",
    readFailed: "线路状态读取失败",
    videoSwitchOff: "视频增强开关已关闭",
    liveSwitchOff: SWITCH_OFF_TEXT.liveOff,
    pause: "已下载够，暂停下载",
    pauseWaitingForPlayer: "暂停下载，播放器要时再取",
    quietVideo: "正在下载，最近 5 秒没有收到数据",
    quietLive: "最近 5 秒没有收到数据",
    lineIdle: "空闲",
    lineLostRace: "另一条线路更快"
  });
  function speedText(bitsPerSecond) {
    const mbps = bitsPerSecond / 1e6;
    return `${mbps >= 10 ? String(Math.round(mbps)) : mbps.toFixed(1)} Mbps`;
  }
  function clockText(seconds) {
    const whole = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(whole / 60);
    return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
  }
  function playerResources(resources) {
    return (resources ?? []).filter((resource) => resource?.active === true && (resource.kind === "video" || resource.kind === "audio") && Number.isSafeInteger(resource.contiguousEnd) && Number.isFinite(resource.totalSize) && resource.totalSize > 0);
  }
  function lagResource(resources) {
    let picked;
    for (const resource of playerResources(resources)) {
      if (picked === void 0 || resource.contiguousEnd / resource.totalSize < picked.contiguousEnd / picked.totalSize) {
        picked = resource;
      }
    }
    return picked;
  }
  function lineRowsOf(status, { live, inventoryQuiet }) {
    return status.lines.map((line) => {
      const idle = live ? !line.seenInActivityWindow : inventoryQuiet;
      if (idle) return { mirror: line.mirror, text: DOWNLOAD_CARD_TEXT.lineIdle, tone: "idle" };
      if (line.fetchedEndsInWindow) {
        return { mirror: line.mirror, text: `下载中 · ${speedText(line.bitsPerSecond)}`, tone: "ok" };
      }
      const failureText = LINE_FAILURE_TEXTS[line.lastResultInWindow];
      if (failureText !== void 0) {
        const tone = line.lastResultInWindow === "stalled" ? "warn" : "bad";
        return { mirror: line.mirror, text: failureText, tone };
      }
      if (line.lastResultInWindow === "lost_race") {
        return { mirror: line.mirror, text: DOWNLOAD_CARD_TEXT.lineLostRace, tone: "idle" };
      }
      return { mirror: line.mirror, text: DOWNLOAD_CARD_TEXT.lineIdle, tone: "idle" };
    });
  }
  var DECODER_STALL_FORWARD_SECONDS = 2;
  function videoHeadline({ status, missingData, decoderStall, forwardSeconds, currentTime, lag }) {
    if (decoderStall) return `播放器解码没跟上，缓冲里还有 ${Math.round(forwardSeconds)} 秒数据`;
    if (missingData) {
      const rounds = Number.isSafeInteger(lag?.outstanding) && lag.outstanding > 0 && Number.isSafeInteger(lag.failedRounds) && lag.failedRounds >= 1 ? lag.failedRounds : 0;
      return `正在等 ${clockText(currentTime)} 处的数据` + (rounds >= 1 ? `，已重试 ${rounds} 轮` : "");
    }
    const inventory = status.inventory;
    if (inventory?.inflight === 0 && inventory?.queued === 0) {
      return Number.isSafeInteger(lag?.failedRounds) && lag.failedRounds >= 1 ? DOWNLOAD_CARD_TEXT.pauseWaitingForPlayer : DOWNLOAD_CARD_TEXT.pause;
    }
    if (status.anyLineBytesInWindow) return `正在下载 · 合计 ${speedText(status.totalBitsPerSecond)}`;
    return DOWNLOAD_CARD_TEXT.quietVideo;
  }
  function videoSubline({ status, missingData, lag, readouts }) {
    if (missingData) return void 0;
    const candidates = playerResources(status.inventory?.resources);
    const duration = readouts?.duration;
    if (candidates.length === 0 || !Number.isFinite(duration)) return void 0;
    if (candidates.every((resource) => resource.contiguousEnd === resource.totalSize)) {
      return `整个视频已下载（全长 ${clockText(duration)}）`;
    }
    const estimated = Math.min(...candidates.map((resource) => resource.contiguousEnd / resource.totalSize * duration));
    const bufferEnd = Number.isFinite(readouts?.currentTime) && Number.isFinite(readouts?.forwardSeconds) ? readouts.currentTime + readouts.forwardSeconds : 0;
    const ahead = Math.max(estimated, bufferEnd);
    const rounds = Number.isSafeInteger(lag?.failedRounds) && lag.failedRounds >= 1 ? lag.failedRounds : 0;
    return `已提前下载到约 ${clockText(ahead)}（全长 ${clockText(duration)}）` + (rounds >= 1 ? `，之后的数据已重试 ${rounds} 轮` : "");
  }
  function downloadLinesView({ response, error, inFlight, live, readouts, vodEnabled, liveEnabled: liveEnabled2 }) {
    if (error !== void 0) return { message: DOWNLOAD_CARD_TEXT.readFailed };
    if (response === void 0) return { message: inFlight === true ? DOWNLOAD_CARD_TEXT.loading : DOWNLOAD_CARD_TEXT.noSession };
    const status = response.downloadStatus;
    if (!status.hasRecords) {
      const switchOn = live === true ? liveEnabled2 !== false : vodEnabled !== false;
      const headline = switchOn ? DOWNLOAD_CARD_TEXT.noRecords : live === true ? DOWNLOAD_CARD_TEXT.liveSwitchOff : DOWNLOAD_CARD_TEXT.videoSwitchOff;
      return { headline, subline: void 0, lines: [] };
    }
    if (live === true) {
      const headline = status.anyLineBytesInWindow ? `正在下载 · 合计 ${speedText(status.totalBitsPerSecond)}` : DOWNLOAD_CARD_TEXT.quietLive;
      return { headline, subline: void 0, lines: lineRowsOf(status, { live: true, inventoryQuiet: false }) };
    }
    const waitingNow = readouts?.waiting === true && Number.isFinite(readouts?.currentTime);
    const forwardSeconds = readouts?.forwardSeconds;
    const decoderStall = waitingNow && Number.isFinite(forwardSeconds) && forwardSeconds >= DECODER_STALL_FORWARD_SECONDS;
    const missingData = waitingNow && !decoderStall;
    const lag = lagResource(status.inventory?.resources);
    return {
      headline: videoHeadline({ status, missingData, decoderStall, forwardSeconds, currentTime: readouts?.currentTime, lag }),
      subline: videoSubline({ status, missingData, lag, readouts }),
      lines: lineRowsOf(status, { live: false, inventoryQuiet: status.inventory?.inflight === 0 && status.inventory?.queued === 0 })
    };
  }
  function targetStateText({ hasVideo, stateLabel, enhancementEnabled: enhancementEnabled2 }) {
    if (hasVideo !== true) return "";
    const mapped = TARGET_STATE_WORDS[stateLabel];
    if (mapped !== void 0) return mapped;
    return enhancementEnabled2 === false ? SWITCH_OFF_TEXT.videoOffValue : "等待增强启动";
  }
  function applyPageAvailability(documentObject, available) {
    documentObject.querySelector("main")?.classList.toggle("no-page", available !== true);
  }
  function surfaceErrorText(snapshot) {
    const error = snapshot?.error;
    return typeof error === "string" && error.length > 0 && error !== "未提供" ? error : void 0;
  }
  function renderVideoPanel(documentObject, refs, { forwardSeconds, snapshot, enhancementEnabled: enhancementEnabled2, targetSeconds }) {
    const hasVideo = Number.isFinite(forwardSeconds);
    renderBuffer(documentObject, refs, {
      forwardSeconds,
      targetSeconds,
      stateText: targetStateText({
        hasVideo,
        stateLabel: snapshot?.state,
        enhancementEnabled: enhancementEnabled2
      }),
      targetLabel: enhancementEnabled2 === false ? SWITCH_OFF_TEXT.videoLabel : `已向播放器申请 ${targetSeconds} 秒缓存`,
      goalSuffix: enhancementEnabled2 === false ? "" : void 0
    });
    const error = surfaceErrorText(snapshot);
    refs.errorLine.hidden = error === void 0;
    refs.errorLine.textContent = error ?? "";
  }
  function renderLiveTakeover(refs, { facts, error, liveEnabled: liveEnabled2 } = {}) {
    refs.takeover.textContent = error !== void 0 ? "直播状态读取失败" : liveTakeoverText(facts, { liveEnabled: liveEnabled2 });
  }
  function renderBuffer(documentObject, refs, { forwardSeconds, targetSeconds, stateText, targetLabel, goalSuffix }) {
    const hasVideo = Number.isFinite(forwardSeconds) && Number.isFinite(targetSeconds) && targetSeconds > 0;
    if (hasVideo) {
      const percent = Math.max(0, Math.min(100, forwardSeconds / targetSeconds * 100));
      refs.fill.style.width = `${percent}%`;
      refs.bar.classList.toggle("reached", forwardSeconds >= targetSeconds);
      refs.seconds.textContent = `${Math.round(forwardSeconds)} 秒`;
      refs.goal.textContent = goalSuffix ?? `/ 目标 ${Math.round(targetSeconds)} 秒`;
      refs.note.hidden = true;
      refs.note.textContent = "";
    } else {
      refs.fill.style.width = "0%";
      refs.bar.classList.remove("reached");
      refs.seconds.textContent = "—";
      refs.goal.textContent = "";
      refs.note.hidden = false;
      refs.note.textContent = "当前页面没有在播放的视频";
    }
    refs.targetLabel.textContent = targetLabel;
    refs.targetValue.textContent = stateText;
    refs.stateLine.hidden = stateText === void 0 || stateText === "";
  }
  function renderCdnLines(documentObject, container, view = {}) {
    container.replaceChildren();
    if (typeof view.message === "string" && view.message.length > 0) {
      const empty = documentObject.createElement("p");
      empty.className = "cdn-empty";
      empty.textContent = view.message;
      container.append(empty);
      return;
    }
    const headline = documentObject.createElement("p");
    headline.className = "cdn-headline";
    headline.textContent = view.headline;
    container.append(headline);
    if (typeof view.subline === "string" && view.subline.length > 0) {
      const subline = documentObject.createElement("p");
      subline.className = "cdn-subline";
      subline.textContent = view.subline;
      container.append(subline);
    }
    for (const row of view.lines ?? []) {
      const line = documentObject.createElement("div");
      line.className = "cdn-line";
      line.dataset.tone = row.tone;
      const head = documentObject.createElement("div");
      head.className = "cdn-line-head";
      const name = documentObject.createElement("span");
      name.className = "cdn-name";
      name.textContent = shortMirrorName(row?.mirror);
      const status = documentObject.createElement("span");
      status.className = "cdn-status";
      status.textContent = row.text;
      head.append(name, status);
      line.append(head);
      container.append(line);
    }
  }
  var FLV_BACKUP_TEXT = Object.freeze({
    connected: "FLV 后备校准中",
    calibrated: "FLV 后备已接上",
    reconnecting: "FLV 后备重连中",
    given_up: "FLV 后备已断开",
    unavailable: "无 FLV 后备"
  });
  function liveTakeoverText(facts, { liveEnabled: liveEnabled2 } = {}) {
    if (facts && facts.serveCount > 0) {
      if (facts.engagement === "engaged") {
        const backup = FLV_BACKUP_TEXT[facts.flvBackup];
        const suffix = backup === void 0 ? "" : `，${backup}`;
        if (facts.pairedAddressAvailable && !facts.pairRejected) return `正在按两条线路竞速下载${suffix}`;
        return `单路接管（无可用备用线路）${suffix}`;
      }
      if (facts.engagement === "failed") return "接管请求失败";
      return "未接管（未发现直播媒体流）";
    }
    if (liveEnabled2 === false) return SWITCH_OFF_TEXT.liveOff;
    return "等待直播数据";
  }

  // src/extension/popup.js
  var PREFERENCES = Object.freeze(preferenceNames());
  var RECEIVER_MISSING = "Could not establish connection. Receiving end does not exist.";
  var mainElement = document.querySelector("main");
  var noticeElement = document.querySelector("[data-notice]");
  var errorLineElement = document.querySelector('[data-status-field="error"]');
  var cdnLinesElement = document.querySelector("[data-cdn-lines]");
  var liveTakeoverElement = document.querySelector("[data-live-takeover]");
  var bufferRefs = {
    bar: document.querySelector("[data-buffer-bar]"),
    fill: document.querySelector("[data-buffer-fill]"),
    seconds: document.querySelector("[data-buffer-seconds]"),
    goal: document.querySelector("[data-buffer-goal]"),
    note: document.querySelector("[data-buffer-note]"),
    targetLabel: document.querySelector("[data-buffer-target-label]"),
    targetValue: document.querySelector("[data-target-value]"),
    stateLine: document.querySelector('[data-status-field="state"]'),
    errorLine: errorLineElement
  };
  var liveRefs = {
    takeover: liveTakeoverElement
  };
  var inputs = new Map(
    PREFERENCES.map((name) => [name, document.querySelector(`input[data-preference="${name}"]`)])
  );
  var popupRoute = POPUP_ROUTE.VIDEO;
  var enhancementEnabled = true;
  var liveEnabled = true;
  var latestReadouts;
  var latestSnapshot;
  var latestForwardSeconds;
  var sessionId;
  var raceSessionId;
  var raceSummary;
  var raceError;
  var raceQueryInFlight = false;
  var nextRaceQueryAt = 0;
  var liveSessionId;
  var liveFacts = emptyLiveFacts();
  var liveError;
  var liveQueryInFlight = false;
  var nextLiveQueryAt = 0;
  var pageUnavailable = true;
  var panelTabId;
  var PREFERENCE_NOTICE_HOLD_MS = 4e3;
  var noticeHoldUntil = 0;
  function showNotice(text, { holdMs = 0 } = {}) {
    noticeElement.textContent = text;
    noticeHoldUntil = holdMs > 0 ? Date.now() + holdMs : 0;
  }
  function clearTransientNotice() {
    if (Date.now() < noticeHoldUntil) return;
    showNotice("");
  }
  function renderVideoPanel2() {
    renderVideoPanel(document, bufferRefs, {
      forwardSeconds: latestForwardSeconds,
      snapshot: latestSnapshot,
      enhancementEnabled,
      targetSeconds: VOD_CONFIG.stableBufferSeconds
    });
  }
  function renderRacePanel() {
    renderCdnLines(document, cdnLinesElement, downloadLinesView({
      response: raceSummary,
      error: raceError,
      inFlight: raceQueryInFlight,
      live: popupRoute === POPUP_ROUTE.LIVE,
      readouts: latestReadouts,
      vodEnabled: enhancementEnabled,
      liveEnabled
    }));
  }
  function renderLivePanel() {
    renderLiveTakeover(liveRefs, { facts: liveFacts, error: liveError, liveEnabled });
  }
  function renderAll() {
    applyPageAvailability(document, !pageUnavailable);
    renderVideoPanel2();
    renderRacePanel();
    renderLivePanel();
  }
  function resetPageData() {
    latestReadouts = void 0;
    latestSnapshot = void 0;
    latestForwardSeconds = void 0;
    sessionId = void 0;
  }
  async function activeTab() {
    return popupAttachedTab({ windowsApi: chrome.windows, tabsApi: chrome.tabs });
  }
  async function sendTabMessage(tabId, type) {
    const response = await chrome.tabs.sendMessage(tabId, {
      version: STATUS_MESSAGE_VERSION,
      type
    });
    if (response?.ok === false) throw new Error(response.error?.message || `当前页面拒绝 ${type} 请求`);
    return response;
  }
  async function sendLogsRead(message) {
    const response = await chrome.runtime.sendMessage({ version: 1, ...message });
    if (response?.ok !== true) throw new Error(response?.error?.message || "日志读取请求失败");
    return response;
  }
  async function refreshRace(sessionIdValue) {
    if (sessionIdValue === void 0 || sessionIdValue === "未提供") {
      raceSessionId = sessionIdValue;
      raceSummary = void 0;
      raceError = void 0;
      renderRacePanel();
      return;
    }
    if (raceSessionId !== sessionIdValue) {
      raceSessionId = sessionIdValue;
      raceSummary = void 0;
      raceError = void 0;
      nextRaceQueryAt = 0;
    }
    if (raceQueryInFlight || Date.now() < nextRaceQueryAt) return;
    raceQueryInFlight = true;
    raceError = void 0;
    renderRacePanel();
    try {
      const response = await sendLogsRead({ type: "logs:cdn-summary", sessionId: sessionIdValue });
      if (raceSessionId !== sessionIdValue) return;
      raceSummary = response;
    } catch (error) {
      if (raceSessionId === sessionIdValue) raceError = error?.message || String(error);
      console.error("[BilibiliBuffer] 读取线路状态失败", error);
    } finally {
      raceQueryInFlight = false;
      nextRaceQueryAt = Date.now() + 1e3;
      renderRacePanel();
    }
  }
  async function refreshLivePanel(sessionIdValue) {
    if (sessionIdValue === void 0 || sessionIdValue === "未提供") {
      liveSessionId = sessionIdValue;
      liveFacts = emptyLiveFacts();
      liveError = void 0;
      renderLivePanel();
      return;
    }
    if (liveSessionId !== sessionIdValue) {
      liveSessionId = sessionIdValue;
      liveFacts = emptyLiveFacts();
      liveError = void 0;
      nextLiveQueryAt = 0;
    }
    if (liveQueryInFlight || Date.now() < nextLiveQueryAt) return;
    liveQueryInFlight = true;
    renderLivePanel();
    try {
      const response = await sendLogsRead({ type: "logs:live-summary", sessionId: sessionIdValue });
      if (liveSessionId !== sessionIdValue) return;
      liveFacts = response.facts;
      liveError = void 0;
    } catch (error) {
      if (liveSessionId === sessionIdValue) liveError = error?.message || String(error);
      console.error("[BilibiliBuffer] 读取直播状态失败", error);
    } finally {
      liveQueryInFlight = false;
      nextLiveQueryAt = Date.now() + 1e3;
      renderLivePanel();
    }
  }
  function routeFor(readouts, tabUrl) {
    if (readouts?.routeKind === "live") return POPUP_ROUTE.LIVE;
    if (readouts?.routeKind === "video" || readouts?.routeKind === "other") return POPUP_ROUTE.VIDEO;
    return popupRouteForTabUrl(tabUrl);
  }
  async function pollTab(tab) {
    const readouts = await sendTabMessage(tab.id, "readouts:get");
    const snapshot = popupRoute === POPUP_ROUTE.VIDEO ? await sendTabMessage(tab.id, "status:get") : void 0;
    return { readouts, snapshot };
  }
  async function failPanel(message, { error } = {}) {
    pageUnavailable = true;
    panelTabId = void 0;
    resetPageData();
    latestReadouts = void 0;
    await refreshRace(void 0);
    if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(void 0);
    renderAll();
    if (error !== void 0) console.error("[BilibiliBuffer] 读取页面状态失败", error);
    showNotice(message);
  }
  async function refresh() {
    const active = await activeTab();
    const route = routeFor(latestReadouts, active?.url);
    if (route !== popupRoute) {
      popupRoute = route;
      applyPopupRoute(document, route);
    }
    if (active === void 0) {
      pageUnavailable = true;
      panelTabId = void 0;
      resetPageData();
      renderAll();
      showNotice(NO_PAGE_MESSAGES.noTab);
      return;
    }
    let polled;
    try {
      polled = await pollTab(active);
    } catch (error) {
      if (error?.message === RECEIVER_MISSING) {
        await failPanel(NO_PAGE_MESSAGES.noReceiver);
      } else {
        await failPanel(NO_PAGE_MESSAGES.readFailed, { error });
      }
      return;
    }
    latestReadouts = polled.readouts;
    latestSnapshot = polled.snapshot;
    latestForwardSeconds = Number.isFinite(polled.readouts?.forwardSeconds) ? polled.readouts.forwardSeconds : void 0;
    sessionId = polled.readouts?.diagnostics?.sessionId;
    panelTabId = active.id;
    const readoutsRoute = routeFor(latestReadouts, active?.url);
    if (readoutsRoute !== popupRoute) {
      popupRoute = readoutsRoute;
      applyPopupRoute(document, popupRoute);
    }
    pageUnavailable = false;
    clearTransientNotice();
    document.body.dataset.ready = "true";
    renderAll();
    await refreshRace(sessionId);
    if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(sessionId);
  }
  async function loadPreferences() {
    const values = await chrome.storage.local.get(PREFERENCES);
    const stored = storedPreferences(values);
    for (const name of PREFERENCES) inputs.get(name).checked = stored[name];
    enhancementEnabled = stored[EXTENSION_PREFERENCES.vodEnabled];
    liveEnabled = stored[EXTENSION_PREFERENCES.liveEnabled];
  }
  for (const name of PREFERENCES) {
    inputs.get(name).addEventListener("change", async (event) => {
      const checked = event.currentTarget.checked;
      const affectsVideoPanel = await savePreferenceChange({
        name,
        checked,
        storageObject: chrome.storage.local
      });
      if (affectsVideoPanel) {
        enhancementEnabled = checked;
        renderVideoPanel2();
      }
      if (name === EXTENSION_PREFERENCES.liveEnabled) {
        liveEnabled = checked;
        renderLivePanel();
      }
      showNotice(NO_PAGE_MESSAGES.preferenceSaved, { holdMs: PREFERENCE_NOTICE_HOLD_MS });
    });
  }
  document.querySelector("[data-open-logs]").addEventListener("click", () => {
    void (async () => {
      let fragment = "";
      try {
        if (panelTabId !== void 0) {
          const response = await sendTabMessage(panelTabId, "diagnostics:session-id:get");
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
    showNotice(NO_PAGE_MESSAGES.preferenceFailed);
  });
  showNotice(NO_PAGE_MESSAGES.loading);
  renderAll();
  void refresh();
  var pollTimer = setInterval(() => {
    void refresh();
  }, 500);
  window.addEventListener("pagehide", () => clearInterval(pollTimer), { once: true });
})();
//# sourceMappingURL=popup.js.map
