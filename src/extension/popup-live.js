// 面板路由与直播只读事实：路由判定、开关标签、直播接管状态的事件折叠。
// 数据全部来自 logs:max-event-id / logs:events-page（与开发日志同源），
// 直播线路连接时间走既有 logs:cdn-summary，这里不做网络请求。

export const POPUP_ROUTE = Object.freeze({ VIDEO: 'video', LIVE: 'live' });

const TOGGLE_LABELS = Object.freeze({ video: '视频增强', live: '直播增强' });

export function popupRouteForTabUrl(urlString) {
  if (typeof urlString !== 'string' || urlString.length === 0) return POPUP_ROUTE.VIDEO;
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (error) {
    return POPUP_ROUTE.VIDEO;
  }
  return parsed.hostname === 'live.bilibili.com' ? POPUP_ROUTE.LIVE : POPUP_ROUTE.VIDEO;
}

export function popupToggleLabel(route) {
  return route === POPUP_ROUTE.LIVE ? TOGGLE_LABELS.live : TOGGLE_LABELS.video;
}

export function applyPopupRoute(documentObject, route) {
  const livePanel = documentObject.querySelector('[data-live-panel]');
  if (livePanel !== null) livePanel.hidden = route !== POPUP_ROUTE.LIVE;
  const label = documentObject.querySelector('[data-vod-toggle-label]');
  if (label !== null) label.textContent = popupToggleLabel(route);
  for (const block of documentObject.querySelectorAll('[data-vod-only]')) {
    block.hidden = route === POPUP_ROUTE.LIVE;
  }
}

export function emptyLiveFacts() {
  return {
    serveCount: 0,
    latestServe: undefined,
  };
}

export function foldLiveEvent(facts, event) {
  if (event?.code !== 'bank.serve') return facts;
  const data = event?.data !== null && typeof event?.data === 'object' ? event.data : {};
  facts.serveCount += 1;
  facts.latestServe = {
    result: data.result,
    pairedAddressAvailable: data.pairedAddressAvailable,
  };
  return facts;
}

export function foldLiveEvents(facts, events) {
  for (const event of events || []) foldLiveEvent(facts, event);
  return facts;
}
