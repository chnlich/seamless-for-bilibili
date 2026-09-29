import { EXTENSION_PREFERENCES, VOD_CONFIG } from '../constants.js';
import { logSessionFragment } from '../diagnostics/log-session.js';
import { STATUS_MESSAGE_VERSION } from '../ui/panel.js';
import {
  POPUP_ROUTE,
  applyPopupRoute,
  emptyLiveFacts,
  popupRouteForTabUrl,
  preferenceNames,
  savePreferenceChange,
  storedPreferences,
} from './popup-live.js';
import { popupAttachedTab } from './popup-tabs.js';
import {
  NO_PAGE_MESSAGES,
  applyPageAvailability,
  cdnLinesView,
  renderCdnLines,
  renderLiveTakeover,
  renderVideoPanel as renderVideoPanelView,
} from './popup-view.js';

const PREFERENCES = Object.freeze(preferenceNames());
const RECEIVER_MISSING = 'Could not establish connection. Receiving end does not exist.';

const mainElement = document.querySelector('main');
const noticeElement = document.querySelector('[data-notice]');
const errorLineElement = document.querySelector('[data-status-field="error"]');
const cdnLinesElement = document.querySelector('[data-cdn-lines]');
const liveTakeoverElement = document.querySelector('[data-live-takeover]');
const bufferRefs = {
  bar: document.querySelector('[data-buffer-bar]'),
  fill: document.querySelector('[data-buffer-fill]'),
  seconds: document.querySelector('[data-buffer-seconds]'),
  goal: document.querySelector('[data-buffer-goal]'),
  note: document.querySelector('[data-buffer-note]'),
  targetLabel: document.querySelector('[data-buffer-target-label]'),
  targetValue: document.querySelector('[data-target-value]'),
  stateLine: document.querySelector('[data-status-field="state"]'),
  errorLine: errorLineElement,
};
const liveRefs = {
  takeover: liveTakeoverElement,
};
const inputs = new Map(
  PREFERENCES.map((name) => [name, document.querySelector(`input[data-preference="${name}"]`)]),
);

let popupRoute = POPUP_ROUTE.VIDEO;
let enhancementEnabled = true;
let liveEnabled = true;
let latestReadouts;
let latestSnapshot;
let latestForwardSeconds;
let sessionId;
let raceSessionId;
let raceSummary;
let raceError;
let raceQueryInFlight = false;
let nextRaceQueryAt = 0;
let liveSessionId;
let liveFacts = emptyLiveFacts();
let liveError;
let liveQueryInFlight = false;
let nextLiveQueryAt = 0;
let pageUnavailable = true;
let panelTabId;

function showNotice(text) {
  noticeElement.textContent = text;
}

function renderVideoPanel() {
  renderVideoPanelView(document, bufferRefs, {
    forwardSeconds: latestForwardSeconds,
    snapshot: latestSnapshot,
    enhancementEnabled,
    targetSeconds: VOD_CONFIG.stableBufferSeconds,
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
  renderVideoPanel();
  renderRacePanel();
  renderLivePanel();
}

function resetPageData() {
  latestReadouts = undefined;
  latestSnapshot = undefined;
  latestForwardSeconds = undefined;
  sessionId = undefined;
}

async function activeTab() {
  return popupAttachedTab({ windowsApi: chrome.windows, tabsApi: chrome.tabs });
}

async function sendTabMessage(tabId, type) {
  const response = await chrome.tabs.sendMessage(tabId, {
    version: STATUS_MESSAGE_VERSION,
    type,
  });
  if (response?.ok === false) throw new Error(response.error?.message || `当前页面拒绝 ${type} 请求`);
  return response;
}

async function sendLogsRead(message) {
  const response = await chrome.runtime.sendMessage({ version: 1, ...message });
  if (response?.ok !== true) throw new Error(response?.error?.message || '日志读取请求失败');
  return response;
}

async function refreshRace(sessionIdValue) {
  if (sessionIdValue === undefined || sessionIdValue === '未提供') {
    raceSessionId = sessionIdValue;
    raceSummary = undefined;
    raceError = undefined;
    renderRacePanel();
    return;
  }
  if (raceSessionId !== sessionIdValue) {
    raceSessionId = sessionIdValue;
    raceSummary = undefined;
    raceError = undefined;
    nextRaceQueryAt = 0;
  }
  if (raceQueryInFlight || Date.now() < nextRaceQueryAt) return;
  raceQueryInFlight = true;
  raceError = undefined;
  renderRacePanel();
  try {
    const response = await sendLogsRead({ type: 'logs:cdn-summary', sessionId: sessionIdValue });
    if (raceSessionId !== sessionIdValue) return;
    raceSummary = response;
  } catch (error) {
    if (raceSessionId === sessionIdValue) raceError = error?.message || String(error);
    console.error('[BilibiliBuffer] 读取线路状态失败', error);
  } finally {
    raceQueryInFlight = false;
    nextRaceQueryAt = Date.now() + 1000;
    renderRacePanel();
  }
}

// 直播状态走 worker 端摘要（logs:live-summary）：worker 按 [sessionId, sequence]
// 索引只读该 session 自己的事件并折叠事实，代价只随本 session 的大小增长。按全局
// eventId 分页的 logs:events-page 在大库上要从 0 扫过其他 session 的全部记录才能
// 凑齐第一页，直播状态会长时间停在「等待直播数据」（2026-09-28 用户实测）。
async function refreshLivePanel(sessionIdValue) {
  if (sessionIdValue === undefined || sessionIdValue === '未提供') {
    liveSessionId = sessionIdValue;
    liveFacts = emptyLiveFacts();
    liveError = undefined;
    renderLivePanel();
    return;
  }
  if (liveSessionId !== sessionIdValue) {
    liveSessionId = sessionIdValue;
    liveFacts = emptyLiveFacts();
    liveError = undefined;
    nextLiveQueryAt = 0;
  }
  if (liveQueryInFlight || Date.now() < nextLiveQueryAt) return;
  liveQueryInFlight = true;
  renderLivePanel();
  try {
    const response = await sendLogsRead({ type: 'logs:live-summary', sessionId: sessionIdValue });
    if (liveSessionId !== sessionIdValue) return;
    liveFacts = response.facts;
    liveError = undefined;
  } catch (error) {
    if (liveSessionId === sessionIdValue) liveError = error?.message || String(error);
    console.error('[BilibiliBuffer] 读取直播状态失败', error);
  } finally {
    liveQueryInFlight = false;
    nextLiveQueryAt = Date.now() + 1000;
    renderLivePanel();
  }
}

// 路由优先用内容侧自报的 routeKind（popup 没有 tabs 权限，看不到标签页地址），
// 内容侧不可用时退回标签页地址推断。
function routeFor(readouts, tabUrl) {
  if (readouts?.routeKind === 'live') return POPUP_ROUTE.LIVE;
  if (readouts?.routeKind === 'video' || readouts?.routeKind === 'other') return POPUP_ROUTE.VIDEO;
  return popupRouteForTabUrl(tabUrl);
}

async function pollTab(tab) {
  const readouts = await sendTabMessage(tab.id, 'readouts:get');
  const snapshot = popupRoute === POPUP_ROUTE.VIDEO
    ? await sendTabMessage(tab.id, 'status:get')
    : undefined;
  return { readouts, snapshot };
}

async function failPanel(message, { error } = {}) {
  pageUnavailable = true;
  panelTabId = undefined;
  resetPageData();
  latestReadouts = undefined;
  await refreshRace(undefined);
  if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(undefined);
  renderAll();
  if (error !== undefined) console.error('[BilibiliBuffer] 读取页面状态失败', error);
  showNotice(message);
}

// 面板只报告它所附着窗口的活动标签页（见 popup-tabs.js），不向其余标签页询问：
// 另一个窗口仍在运行的增强与本面板无关，显示它只会被读成对当前窗口的错误判断
// （2026-09-28 用户实测误读）。活动标签页不答（Receiver 缺失）时统一走未运行提示：
// 弹窗看不到标签页地址，无法可靠区分「非 Bilibili 页面」与「扩展安装或更新前就已
// 打开的 Bilibili 页面」，合并成一句对两者都成立的提示（见 popup-view.js）。
async function refresh() {
  const active = await activeTab();
  const route = routeFor(latestReadouts, active?.url);
  if (route !== popupRoute) {
    popupRoute = route;
    applyPopupRoute(document, route);
  }
  if (active === undefined) {
    pageUnavailable = true;
    panelTabId = undefined;
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
  latestForwardSeconds = Number.isFinite(polled.readouts?.forwardSeconds)
    ? polled.readouts.forwardSeconds
    : undefined;
  sessionId = polled.readouts?.diagnostics?.sessionId;
  panelTabId = active.id;
  const readoutsRoute = routeFor(latestReadouts, active?.url);
  if (readoutsRoute !== popupRoute) {
    popupRoute = readoutsRoute;
    applyPopupRoute(document, popupRoute);
  }
  pageUnavailable = false;
  showNotice('');
  document.body.dataset.ready = 'true';
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
  inputs.get(name).addEventListener('change', async (event) => {
    // event.currentTarget 只在事件派发期间有效：await 存储写完后再读它是 null，
    // 确认提示与面板刷新会被静默吞掉（2026-09-29 弹窗 console 实测）。
    const checked = event.currentTarget.checked;
    const affectsVideoPanel = await savePreferenceChange({
      name,
      checked,
      storageObject: chrome.storage.local,
    });
    if (affectsVideoPanel) {
      enhancementEnabled = checked;
      renderVideoPanel();
    }
    if (name === EXTENSION_PREFERENCES.liveEnabled) {
      liveEnabled = checked;
      renderLivePanel();
    }
    showNotice(NO_PAGE_MESSAGES.preferenceSaved);
  });
}

document.querySelector('[data-open-logs]').addEventListener('click', () => {
  void (async () => {
    let fragment = '';
    try {
      // 日志带上面板正在显示的标签页的 session（面板只显示它所附着窗口的活动标签页）。
      if (panelTabId !== undefined) {
        const response = await sendTabMessage(panelTabId, 'diagnostics:session-id:get');
        fragment = logSessionFragment(response.sessionId);
      }
      await chrome.tabs.create({ url: chrome.runtime.getURL(`logs.html${fragment}`) });
    } catch (error) {
      console.error('[BilibiliBuffer] 打开开发日志失败', error);
      await chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') });
    }
  })();
});

void loadPreferences().catch((error) => {
  console.error('[BilibiliBuffer] Popup 读取设置失败', error);
  showNotice(NO_PAGE_MESSAGES.preferenceFailed);
});

showNotice(NO_PAGE_MESSAGES.loading);
renderAll();
void refresh();
const pollTimer = setInterval(() => {
  void refresh();
}, 500);
window.addEventListener('pagehide', () => clearInterval(pollTimer), { once: true });
