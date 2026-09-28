// 面板视图层：所有人话文案与 DOM 渲染集中在这里，方便用 jsdom 直接测试。
// 输入全部来自既有只读事实（readouts、status snapshot、logs:cdn-summary），
// 这里不做任何网络请求，也不影响播放。

export const NO_PAGE_MESSAGES = Object.freeze({
  loading: '正在读取页面状态…',
  noTab: '请先打开一个 Bilibili 页面，再打开本面板。',
  noReceiver: '这个页面没有运行 Bilibili 增强。请打开 Bilibili 的视频或直播页面。',
  readFailed: '读取页面状态失败，请稍后重开面板。',
  preferenceFailed: '读取设置失败，请稍后重开面板。',
  preferenceSaved: '已保存，刷新页面后生效。',
});

const TARGET_STATE_WORDS = Object.freeze({
  已应用: '已生效',
  等待: '等待生效',
  不支持: '播放器不支持，未生效',
  失败: '申请失败',
});

// 镜像主机取可读短名：去掉泛用后缀两级域名与前缀装饰，保留能区分线路的骨干。
export function shortMirrorName(mirror) {
  if (typeof mirror !== 'string' || mirror.length === 0) return '未知线路';
  const labels = mirror.split('.').filter((label) => label.length > 0);
  const body = labels.length > 2 ? labels.slice(0, -2).join('.') : mirror;
  const trimmed = body.replace(/^upos-/, '').replace(/^[a-z]+\d*--/, '');
  // 太短的结果辨识不出线路，退回完整主机名。
  return trimmed.length >= 3 ? trimmed : mirror;
}

export function lineHealth(row) {
  const stalled = row?.stalled;
  const failures = row?.failures;
  if (Number.isFinite(stalled) && stalled > 0) return { word: '有停滞', tone: 'warn' };
  if (Number.isFinite(failures) && failures > 0) return { word: '有错误', tone: 'bad' };
  if (Number.isFinite(row?.ttfbP50) || (Number.isFinite(row?.bytesDelivered) && row.bytesDelivered > 0)) {
    return { word: '正常', tone: 'ok' };
  }
  return { word: '尚无数据', tone: 'idle' };
}

export function connectionText(ttfbP50, ttfbP90) {
  if (!Number.isFinite(ttfbP50)) return undefined;
  const typical = `${Math.round(ttfbP50)} 毫秒`;
  if (!Number.isFinite(ttfbP90)) return `通常 ${typical}`;
  return `通常 ${typical} · 慢时 ${Math.round(ttfbP90)} 毫秒`;
}

// stateLabel 来自 status snapshot 的映射值（已应用/等待/不支持/失败/未提供）。
export function targetStateText({ hasVideo, stateLabel, enhancementEnabled }) {
  if (hasVideo !== true) return '';
  const mapped = TARGET_STATE_WORDS[stateLabel];
  if (mapped !== undefined) return mapped;
  return enhancementEnabled === false ? '增强开关已关闭' : '等待增强启动';
}

// 没有内容脚本可问的页面上，卡片整体收起，只留一句友好提示。
export function applyPageAvailability(documentObject, available) {
  documentObject.querySelector('main')?.classList.toggle('no-page', available !== true);
}

export function surfaceErrorText(snapshot) {
  const error = snapshot?.error;
  return typeof error === 'string' && error.length > 0 && error !== '未提供' ? error : undefined;
}

export function cdnLinesView(summary, error, inFlight) {
  if (error !== undefined) return { message: '线路状态读取失败' };
  if (summary === undefined) return { message: inFlight === true ? '正在读取线路状态…' : '还没有线路数据' };
  if (summary.sampleCount === 0) return { message: '还没有线路数据' };
  return { rows: summary.summary.rows };
}

export function renderVideoPanel(
  documentObject,
  refs,
  { forwardSeconds, snapshot, enhancementEnabled, targetSeconds },
) {
  const hasVideo = Number.isFinite(forwardSeconds);
  renderBuffer(documentObject, refs, {
    forwardSeconds,
    targetSeconds,
    stateText: targetStateText({
      hasVideo,
      stateLabel: snapshot?.state,
      enhancementEnabled,
    }),
    targetLabel: `已向播放器申请 ${targetSeconds} 秒缓存`,
  });
  const error = surfaceErrorText(snapshot);
  refs.errorLine.hidden = error === undefined;
  refs.errorLine.textContent = error ?? '';
}

export function renderLiveTakeover(refs, { facts, error } = {}) {
  refs.takeover.textContent = error !== undefined ? '直播状态读取失败' : liveTakeoverText(facts);
}

export function renderBuffer(
  documentObject,
  refs,
  { forwardSeconds, targetSeconds, stateText, targetLabel },
) {
  const hasVideo = Number.isFinite(forwardSeconds) && Number.isFinite(targetSeconds) && targetSeconds > 0;
  if (hasVideo) {
    const percent = Math.max(0, Math.min(100, (forwardSeconds / targetSeconds) * 100));
    refs.fill.style.width = `${percent}%`;
    refs.bar.classList.toggle('reached', forwardSeconds >= targetSeconds);
    refs.seconds.textContent = `${Math.round(forwardSeconds)} 秒`;
    refs.goal.textContent = `/ 目标 ${Math.round(targetSeconds)} 秒`;
    refs.note.hidden = true;
    refs.note.textContent = '';
  } else {
    refs.fill.style.width = '0%';
    refs.bar.classList.remove('reached');
    refs.seconds.textContent = '—';
    refs.goal.textContent = '';
    refs.note.hidden = false;
    refs.note.textContent = '当前页面没有在播放的视频';
  }
  refs.targetLabel.textContent = targetLabel;
  refs.targetValue.textContent = stateText;
  refs.stateLine.hidden = stateText === undefined || stateText === '';
}

export function renderCdnLines(documentObject, container, { rows, message } = {}) {
  container.replaceChildren();
  if (Array.isArray(rows) && rows.length > 0) {
    for (const row of rows) {
      const health = lineHealth(row);
      const line = documentObject.createElement('div');
      line.className = 'cdn-line';
      line.dataset.tone = health.tone;
      const head = documentObject.createElement('div');
      head.className = 'cdn-line-head';
      const name = documentObject.createElement('span');
      name.className = 'cdn-name';
      name.textContent = shortMirrorName(row?.mirror);
      const healthWord = documentObject.createElement('span');
      healthWord.className = 'cdn-health';
      healthWord.textContent = health.word;
      head.append(name, healthWord);
      const connection = documentObject.createElement('div');
      connection.className = 'cdn-conn';
      connection.textContent = connectionText(row?.ttfbP50, row?.ttfbP90) || '还没有连接记录';
      line.append(head, connection);
      container.append(line);
    }
    return;
  }
  const empty = documentObject.createElement('p');
  empty.className = 'cdn-empty';
  empty.textContent = message === undefined || message === '' ? '还没有线路数据' : message;
  container.append(empty);
}

export function liveTakeoverText(facts) {
  if (!facts || facts.serveCount === 0) return '等待直播数据';
  if (facts.engagedCount > 0) {
    if (facts.pairedAddressAvailable && !facts.pairRejected) return '正在按两条线路竞速下载';
    // 未配到备用线路，或备用线路前缀比对不一致被撤销，都只剩播放器所名的一路。
    return '单路接管（无可用备用线路）';
  }
  if (facts.failedCount > 0) return '接管请求失败';
  // 只有放行事件（例如播放器未用 FLV 流）时，接管从未介入，不能谎报成接管。
  return '未接管（未发现 FLV 直播流）';
}
