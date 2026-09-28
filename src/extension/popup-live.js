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
    engagement: undefined,
    pairedAddressAvailable: false,
    pairRejected: false,
  };
}

// 直播页 bank.serve 三类结果：hit=接管已供数，failed=接管尝试失败，pass=按原样放行
// （含 live_non_flv：播放器未使用 FLV 流，接管从未介入）。放行事件（心跳、非 FLV
// 附属请求）不改变接管事实，所以状态取最近一条接管类（hit/failed）结果，而非最近
// 一条 serve：供数后双腿全灭要显示失败，失败后播放器重试成功要回到接管。
export function liveServeClass(result) {
  if (result === 'hit') return 'engaged';
  if (result === 'failed') return 'failed';
  return 'pass';
}

export function foldLiveEvent(facts, event) {
  if (event?.code === 'live.stream.stitch') {
    if (event?.data?.mismatch === true) facts.pairRejected = true;
    return facts;
  }
  if (event?.code !== 'bank.serve') return facts;
  const data = event?.data !== null && typeof event?.data === 'object' ? event.data : {};
  facts.serveCount += 1;
  const klass = liveServeClass(data.result);
  if (klass === 'engaged') {
    // 每次接管只发一条 hit（先于本次接管的拼接裁决），新一轮接管以这条的配对事实重置。
    facts.engagement = 'engaged';
    facts.pairedAddressAvailable = data.pairedAddressAvailable === true;
    facts.pairRejected = false;
  } else if (klass === 'failed') {
    facts.engagement = 'failed';
  }
  return facts;
}

export function foldLiveEvents(facts, events) {
  for (const event of events || []) foldLiveEvent(facts, event);
  return facts;
}
