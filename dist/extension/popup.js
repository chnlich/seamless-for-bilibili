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
      pairRejected: false
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
  function lineHealth(row) {
    const stalled = row?.stalled;
    const failures = row?.failures;
    if (Number.isFinite(stalled) && stalled > 0) return { word: "有停滞", tone: "warn" };
    if (Number.isFinite(failures) && failures > 0) return { word: "有错误", tone: "bad" };
    if (Number.isFinite(row?.ttfbP50) || Number.isFinite(row?.bytesDelivered) && row.bytesDelivered > 0) {
      return { word: "正常", tone: "ok" };
    }
    return { word: "尚无数据", tone: "idle" };
  }
  function connectionText(ttfbP50, ttfbP90) {
    if (!Number.isFinite(ttfbP50)) return void 0;
    const typical = `${Math.round(ttfbP50)} 毫秒`;
    if (!Number.isFinite(ttfbP90)) return `通常 ${typical}`;
    return `通常 ${typical} · 慢时 ${Math.round(ttfbP90)} 毫秒`;
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
  function cdnLinesView(summary, error, inFlight) {
    if (error !== void 0) return { message: "线路状态读取失败" };
    if (summary === void 0) return { message: inFlight === true ? "正在读取线路状态…" : "还没有线路数据" };
    if (summary.sampleCount === 0) return { message: "还没有线路数据" };
    return { rows: summary.summary.rows };
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
  function renderCdnLines(documentObject, container, { rows, message } = {}) {
    container.replaceChildren();
    if (Array.isArray(rows) && rows.length > 0) {
      for (const row of rows) {
        const health = lineHealth(row);
        const line = documentObject.createElement("div");
        line.className = "cdn-line";
        line.dataset.tone = health.tone;
        const head = documentObject.createElement("div");
        head.className = "cdn-line-head";
        const name = documentObject.createElement("span");
        name.className = "cdn-name";
        name.textContent = shortMirrorName(row?.mirror);
        const healthWord = documentObject.createElement("span");
        healthWord.className = "cdn-health";
        healthWord.textContent = health.word;
        head.append(name, healthWord);
        const connection = documentObject.createElement("div");
        connection.className = "cdn-conn";
        connection.textContent = connectionText(row?.ttfbP50, row?.ttfbP90) || "还没有连接记录";
        line.append(head, connection);
        container.append(line);
      }
      return;
    }
    const empty = documentObject.createElement("p");
    empty.className = "cdn-empty";
    empty.textContent = message === void 0 || message === "" ? "还没有线路数据" : message;
    container.append(empty);
  }
  function liveTakeoverText(facts, { liveEnabled: liveEnabled2 } = {}) {
    if (facts && facts.serveCount > 0) {
      if (facts.engagement === "engaged") {
        if (facts.pairedAddressAvailable && !facts.pairRejected) return "正在按两条线路竞速下载";
        return "单路接管（无可用备用线路）";
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
    renderCdnLines(document, cdnLinesElement, cdnLinesView(raceSummary, raceError, raceQueryInFlight));
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
