// 直播面板只读事实：路由判定、开关标签、直播事件聚合与层渲染。
// 数据全部来自 logs:max-event-id / logs:events-page（与开发日志同源），直播竞速
// 统计走既有 logs:cdn-summary，这里不做网络请求。

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
    pairMissCount: 0,
    stitchCount: 0,
    errorCount: 0,
    latestServe: undefined,
    latestStitch: undefined,
  };
}

export function foldLiveEvent(facts, event) {
  const code = event?.code;
  const data = event?.data !== null && typeof event?.data === 'object' ? event.data : {};
  if (code === 'bank.serve') {
    facts.serveCount += 1;
    if (typeof data.pairMiss === 'string' && data.pairMiss.length > 0) facts.pairMissCount += 1;
    facts.latestServe = {
      result: data.result,
      reason: data.reason,
      durationMs: data.durationMs,
      pairMiss: data.pairMiss,
      pairedAddressAvailable: data.pairedAddressAvailable,
      errorName: data.errorName,
    };
    return;
  }
  if (code === 'live.stream.stitch') {
    facts.stitchCount += 1;
    facts.latestStitch = {
      mismatch: data.mismatch,
      phase: data.phase,
      bytesChecked: data.bytesChecked,
    };
    return;
  }
  if (code === 'log.error') facts.errorCount += 1;
}

export function foldLiveEvents(facts, events) {
  for (const event of events || []) foldLiveEvent(facts, event);
  return facts;
}

function textValue(value) {
  return value === undefined || value === null || value === '' ? '未提供' : String(value);
}

export function liveServeText(latestServe) {
  if (latestServe === undefined) return '未提供';
  const parts = [textValue(latestServe.result), textValue(latestServe.reason)];
  if (latestServe.pairedAddressAvailable === true) parts.push('pairedAddressAvailable');
  if (latestServe.pairMiss !== undefined) parts.push(latestServe.pairMiss);
  if (latestServe.errorName !== undefined) parts.push(latestServe.errorName);
  return parts.join(' · ');
}

export function liveStitchText(latestStitch) {
  if (latestStitch === undefined) return '未提供';
  return `${textValue(latestStitch.phase)} · mismatch=${textValue(latestStitch.mismatch)} · bytesChecked=${textValue(latestStitch.bytesChecked)}`;
}

export function renderLiveFacts(documentObject, container, facts, { error, inFlight = false, hasSession = true } = {}) {
  container.replaceChildren();
  const append = (label, value) => {
    const row = documentObject.createElement('div');
    row.className = 'readout-row';
    const name = documentObject.createElement('dt');
    name.textContent = label;
    const valueElement = documentObject.createElement('dd');
    valueElement.textContent = textValue(value);
    row.append(name, valueElement);
    container.append(row);
  };
  if (!hasSession) {
    append('直播事实', '未提供');
    return;
  }
  if (error !== undefined) {
    append('直播事实', `读取失败: ${textValue(error)}`);
    return;
  }
  if (inFlight && facts.serveCount === 0 && facts.stitchCount === 0) {
    append('直播事实', '读取中');
    return;
  }
  append('接管状态', liveServeText(facts.latestServe));
  append('缝合门', liveStitchText(facts.latestStitch));
  append('应答计数', facts.serveCount);
  append('配对缺失', facts.pairMissCount);
  append('缝合计数', facts.stitchCount);
  append('错误计数', facts.errorCount);
}
