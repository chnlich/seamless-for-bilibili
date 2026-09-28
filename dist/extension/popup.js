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
      latestServe: void 0
    };
  }
  function foldLiveEvent(facts, event) {
    if (event?.code !== "bank.serve") return facts;
    const data = event?.data !== null && typeof event?.data === "object" ? event.data : {};
    facts.serveCount += 1;
    facts.latestServe = {
      result: data.result,
      pairedAddressAvailable: data.pairedAddressAvailable
    };
    return facts;
  }
  function foldLiveEvents(facts, events) {
    for (const event of events || []) foldLiveEvent(facts, event);
    return facts;
  }

  // src/extension/popup-view.js
  var NO_PAGE_MESSAGES = Object.freeze({
    noTab: "请先打开一个 Bilibili 页面，再打开本面板。",
    noReceiver: "这个页面没有运行 Bilibili 增强。请打开 Bilibili 的视频或直播页面。",
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
    return enhancementEnabled2 === false ? "增强开关已关闭" : "等待增强启动";
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
      targetLabel: `已向播放器申请 ${targetSeconds} 秒缓存`
    });
    const error = surfaceErrorText(snapshot);
    refs.errorLine.hidden = error === void 0;
    refs.errorLine.textContent = error ?? "";
  }
  function renderLiveTakeover(refs, { facts, error } = {}) {
    refs.takeover.textContent = error !== void 0 ? "直播状态读取失败" : liveTakeoverText(facts);
  }
  function renderBuffer(documentObject, refs, { forwardSeconds, targetSeconds, stateText, targetLabel }) {
    const hasVideo = Number.isFinite(forwardSeconds) && Number.isFinite(targetSeconds) && targetSeconds > 0;
    if (hasVideo) {
      const percent = Math.max(0, Math.min(100, forwardSeconds / targetSeconds * 100));
      refs.fill.style.width = `${percent}%`;
      refs.bar.classList.toggle("reached", forwardSeconds >= targetSeconds);
      refs.seconds.textContent = `${Math.round(forwardSeconds)} 秒`;
      refs.goal.textContent = `/ 目标 ${Math.round(targetSeconds)} 秒`;
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
    refs.stateLine.textContent = stateText;
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
  function liveTakeoverText(facts) {
    if (!facts || facts.serveCount === 0) return "等待直播数据";
    if (facts.latestServe?.result === "failed") return "接管请求失败";
    if (facts.latestServe?.pairedAddressAvailable === true) return "正在按两条线路竞速下载";
    return "单路接管（未找到备用线路）";
  }

  // src/extension/popup.js
  var PREFERENCES = Object.freeze(Object.values(EXTENSION_PREFERENCES));
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
  var liveAfterEventId = 0;
  var liveError;
  var liveQueryInFlight = false;
  var nextLiveQueryAt = 0;
  var pageUnavailable = true;
  function showNotice(text) {
    noticeElement.textContent = text;
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
    renderLiveTakeover(liveRefs, { facts: liveFacts, error: liveError });
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
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) return void 0;
    return tabs[0];
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
      liveAfterEventId = 0;
      liveError = void 0;
      renderLivePanel();
      return;
    }
    if (liveSessionId !== sessionIdValue) {
      liveSessionId = sessionIdValue;
      liveFacts = emptyLiveFacts();
      liveAfterEventId = 0;
      liveError = void 0;
      nextLiveQueryAt = 0;
    }
    if (liveQueryInFlight || Date.now() < nextLiveQueryAt) return;
    liveQueryInFlight = true;
    renderLivePanel();
    try {
      const max = await sendLogsRead({ type: "logs:max-event-id", sessionId: sessionIdValue });
      let afterEventId = liveAfterEventId;
      for (; ; ) {
        const page = await sendLogsRead({
          type: "logs:events-page",
          limit: 250,
          afterEventId,
          maxEventId: max.maxEventId,
          sessionId: sessionIdValue
        });
        if (liveSessionId !== sessionIdValue) return;
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
  async function refresh() {
    const tab = await activeTab();
    const route = routeFor(latestReadouts, tab?.url);
    if (route !== popupRoute) {
      popupRoute = route;
      applyPopupRoute(document, route);
    }
    if (tab === void 0) {
      pageUnavailable = true;
      resetPageData();
      renderAll();
      showNotice(NO_PAGE_MESSAGES.noTab);
      return;
    }
    try {
      const readouts = await sendTabMessage(tab.id, "readouts:get");
      latestReadouts = readouts;
      latestForwardSeconds = Number.isFinite(readouts?.forwardSeconds) ? readouts.forwardSeconds : void 0;
      sessionId = readouts?.diagnostics?.sessionId;
      latestSnapshot = popupRoute === POPUP_ROUTE.VIDEO ? await sendTabMessage(tab.id, "status:get") : void 0;
    } catch (error) {
      if (error?.message === RECEIVER_MISSING) {
        pageUnavailable = true;
        resetPageData();
        await refreshRace(void 0);
        if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(void 0);
        renderAll();
        showNotice(NO_PAGE_MESSAGES.noReceiver);
        return;
      }
      resetPageData();
      latestReadouts = void 0;
      await refreshRace(void 0);
      if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(void 0);
      renderAll();
      console.error("[BilibiliBuffer] 读取页面状态失败", error);
      showNotice(NO_PAGE_MESSAGES.readFailed);
      return;
    }
    pageUnavailable = false;
    showNotice("");
    document.body.dataset.ready = "true";
    renderAll();
    await refreshRace(sessionId);
    if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(sessionId);
  }
  async function loadPreferences() {
    const values = await chrome.storage.local.get(PREFERENCES);
    for (const name of PREFERENCES) inputs.get(name).checked = values[name] !== false;
    enhancementEnabled = inputs.get(EXTENSION_PREFERENCES.vodEnabled).checked;
  }
  for (const name of PREFERENCES) {
    inputs.get(name).addEventListener("change", async (event) => {
      await chrome.storage.local.set({ [name]: event.currentTarget.checked });
      enhancementEnabled = event.currentTarget.checked;
      renderVideoPanel2();
      showNotice(NO_PAGE_MESSAGES.preferenceSaved);
    });
  }
  document.querySelector("[data-open-logs]").addEventListener("click", () => {
    void (async () => {
      let fragment = "";
      try {
        const tab = await activeTab();
        if (tab !== void 0) {
          const response = await sendTabMessage(tab.id, "diagnostics:session-id:get");
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
  renderAll();
  void refresh();
  var pollTimer = setInterval(() => {
    void refresh();
  }, 500);
  window.addEventListener("pagehide", () => clearInterval(pollTimer), { once: true });
})();
//# sourceMappingURL=popup.js.map
