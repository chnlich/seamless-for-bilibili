import { EXTENSION_PREFERENCES, VOD_CONFIG } from '../constants.js';
import { logSessionFragment } from '../diagnostics/log-session.js';
import { STATUS_MESSAGE_VERSION } from '../ui/panel.js';
import {
  POPUP_ROUTE,
  applyPopupRoute,
  emptyLiveFacts,
  foldLiveEvents,
  popupRouteForTabUrl,
} from './popup-live.js';
import {
  NO_PAGE_MESSAGES,
  applyPageAvailability,
  cdnLinesView,
  renderCdnLines,
  renderLiveTakeover,
  renderVideoPanel as renderVideoPanelView,
} from './popup-view.js';

const PREFERENCES = Object.freeze(Object.values(EXTENSION_PREFERENCES));
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
let liveAfterEventId = 0;
let liveError;
let liveQueryInFlight = false;
let nextLiveQueryAt = 0;
let pageUnavailable = true;

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
  renderLiveTakeover(liveRefs, { facts: liveFacts, error: liveError });
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
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tabs.length !== 1 || !Number.isInteger(tabs[0].id)) return undefined;
  return tabs[0];
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

async function refreshLivePanel(sessionIdValue) {
  if (sessionIdValue === undefined || sessionIdValue === '未提供') {
    liveSessionId = sessionIdValue;
    liveFacts = emptyLiveFacts();
    liveAfterEventId = 0;
    liveError = undefined;
    renderLivePanel();
    return;
  }
  if (liveSessionId !== sessionIdValue) {
    liveSessionId = sessionIdValue;
    liveFacts = emptyLiveFacts();
    liveAfterEventId = 0;
    liveError = undefined;
    nextLiveQueryAt = 0;
  }
  if (liveQueryInFlight || Date.now() < nextLiveQueryAt) return;
  liveQueryInFlight = true;
  renderLivePanel();
  try {
    const max = await sendLogsRead({ type: 'logs:max-event-id', sessionId: sessionIdValue });
    let afterEventId = liveAfterEventId;
    for (;;) {
      const page = await sendLogsRead({
        type: 'logs:events-page',
        limit: 250,
        afterEventId,
        maxEventId: max.maxEventId,
        sessionId: sessionIdValue,
      });
      if (liveSessionId !== sessionIdValue) return;
      foldLiveEvents(liveFacts, page.events);
      if (!page.hasMore) {
        afterEventId = page.nextAfterEventId;
        break;
      }
      const nextAfterEventId = page.nextAfterEventId ?? page.events.at(-1)?.eventId;
      if (!Number.isInteger(nextAfterEventId) || nextAfterEventId <= afterEventId) {
        throw new Error('日志分页没有向前推进');
      }
      afterEventId = nextAfterEventId;
    }
    liveAfterEventId = afterEventId;
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

async function refresh() {
  const tab = await activeTab();
  const route = routeFor(latestReadouts, tab?.url);
  if (route !== popupRoute) {
    popupRoute = route;
    applyPopupRoute(document, route);
  }
  if (tab === undefined) {
    pageUnavailable = true;
    resetPageData();
    renderAll();
    showNotice(NO_PAGE_MESSAGES.noTab);
    return;
  }
  try {
    const readouts = await sendTabMessage(tab.id, 'readouts:get');
    latestReadouts = readouts;
    latestForwardSeconds = Number.isFinite(readouts?.forwardSeconds) ? readouts.forwardSeconds : undefined;
    sessionId = readouts?.diagnostics?.sessionId;
    latestSnapshot = popupRoute === POPUP_ROUTE.VIDEO
      ? await sendTabMessage(tab.id, 'status:get')
      : undefined;
  } catch (error) {
    if (error?.message === RECEIVER_MISSING) {
      pageUnavailable = true;
      resetPageData();
      await refreshRace(undefined);
      if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(undefined);
      renderAll();
      showNotice(NO_PAGE_MESSAGES.noReceiver);
      return;
    }
    resetPageData();
    latestReadouts = undefined;
    await refreshRace(undefined);
    if (popupRoute === POPUP_ROUTE.LIVE) await refreshLivePanel(undefined);
    renderAll();
    console.error('[BilibiliBuffer] 读取页面状态失败', error);
    showNotice(NO_PAGE_MESSAGES.readFailed);
    return;
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
  for (const name of PREFERENCES) inputs.get(name).checked = values[name] !== false;
  enhancementEnabled = inputs.get(EXTENSION_PREFERENCES.vodEnabled).checked;
}

for (const name of PREFERENCES) {
  inputs.get(name).addEventListener('change', async (event) => {
    await chrome.storage.local.set({ [name]: event.currentTarget.checked });
    enhancementEnabled = event.currentTarget.checked;
    renderVideoPanel();
    showNotice(NO_PAGE_MESSAGES.preferenceSaved);
  });
}

document.querySelector('[data-open-logs]').addEventListener('click', () => {
  void (async () => {
    let fragment = '';
    try {
      const tab = await activeTab();
      if (tab !== undefined) {
        const response = await sendTabMessage(tab.id, 'diagnostics:session-id:get');
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

renderAll();
void refresh();
const pollTimer = setInterval(() => {
  void refresh();
}, 500);
window.addEventListener('pagehide', () => clearInterval(pollTimer), { once: true });
