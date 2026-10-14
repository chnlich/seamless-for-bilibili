// 面板视图层：所有人话文案与 DOM 渲染集中在这里，方便用 jsdom 直接测试。
// 输入全部来自既有只读事实（readouts、status snapshot、logs:cdn-summary），
// 这里不做任何网络请求，也不影响播放。

// 活动标签页没有内容脚本可答时只有这一句提示。弹窗没有 tabs 权限、看不到标签页
// 地址（按 url 过滤也恒为空），分不出「页面不是 Bilibili」和「Bilibili 页面在扩展
// 安装或更新前就已打开」，所以这一句必须对两种情况都成立：给出未运行的事实、
// 打开视频或直播页的建议，以及早于扩展存在的页面需要刷新一次的事实，不谎称
// 页面不受支持（用户实测：刷新提示被谎报覆盖过）。
// 开关关闭时的面板措辞集中在这里（popup.js、检查脚本与单测共用）。
// 视频目标行换成「开关：已关闭」：申请措辞只在开关开着时成立；
// 直播接管行在没有接管事实时直说开关已关闭，不再停在「等待直播数据」
// （开关关闭时接管按设计永不介入，再报等待就是让面板空等）。
export const SWITCH_OFF_TEXT = Object.freeze({
  videoLabel: '视频增强开关',
  videoOffValue: '已关闭',
  liveOff: '直播增强开关已关闭',
});

export const NO_PAGE_MESSAGES = Object.freeze({
  loading: '正在读取页面状态…',
  noTab: '请先打开一个 Bilibili 页面，再打开本面板。',
  noReceiver: '这个页面没有运行 Bilibili 增强。请打开 Bilibili 的视频或直播页面；如果页面在扩展安装或更新之前就已打开，刷新这个页面后增强才会运行。',
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

// 下载线路卡片的全部人话：第一行给此刻的结论，视频页第二行写提前下载到哪里，
// 每条线路一行。输入是 worker 折算好的下载状态（src/diagnostics/download-status.js
// 的文件头写了速度、15 秒活动窗口与重试轮数的口径）、页面读数（readouts v4）
// 与开关状态；这里只拼文字，不算记录。
// 线路自身失败的结果到人话的映射；superseded、aborted、gave_up 是扩展自己放弃的
// 请求，不算线路的失败。
export const LINE_FAILURE_TEXTS = Object.freeze({
  invalid_response: '数据没给全就断开',
  stalled: '10 秒没有收到数据',
  network_error: '连接失败',
  http_error: '服务器返回错误',
  address_expired: '地址已过期',
});

export const DOWNLOAD_CARD_TEXT = Object.freeze({
  noRecords: '还没有下载数据',
  noSession: '还没有线路数据',
  loading: '正在读取线路状态…',
  readFailed: '线路状态读取失败',
  videoSwitchOff: '视频增强开关已关闭',
  liveSwitchOff: SWITCH_OFF_TEXT.liveOff,
  pause: '已下载够，暂停下载',
  pauseWaitingForPlayer: '暂停下载，播放器要时再取',
  quietVideo: '正在下载，最近 5 秒没有收到数据',
  quietLive: '最近 5 秒没有收到数据',
  lineIdle: '空闲',
  lineLostRace: '另一条线路更快',
});

// 大于等于 10 Mbps 取整数，以下留一位小数：低速时小数位说明「不是零」，
// 高速时取整就够和测速结果对照。
export function speedText(bitsPerSecond) {
  const mbps = bitsPerSecond / 1e6;
  return `${mbps >= 10 ? String(Math.round(mbps)) : mbps.toFixed(1)} Mbps`;
}

export function clockText(seconds) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

// 播放器正在用的分轨：库存快照里 active 的视频与音频轨，且下载层给出了连续字节
// 终点。起点未知（还没发过播放器请求）的轨没有 contiguousEnd，进不了比较。
function playerResources(resources) {
  return (resources ?? []).filter((resource) => resource?.active === true
    && (resource.kind === 'video' || resource.kind === 'audio')
    && Number.isSafeInteger(resource.contiguousEnd)
    && Number.isFinite(resource.totalSize)
    && resource.totalSize > 0);
}

// 提前下载得最少的那条轨：第一行的重试轮数与第二行的位置都按它说，
// 卡住播放的一定是最缺的那条。
function lagResource(resources) {
  let picked;
  for (const resource of playerResources(resources)) {
    if (picked === undefined
      || resource.contiguousEnd / resource.totalSize < picked.contiguousEnd / picked.totalSize) {
      picked = resource;
    }
  }
  return picked;
}

function lineRowsOf(status, { live, inventoryQuiet }) {
  return status.lines.map((line) => {
    // 空闲优先：视频页看快照里在途与排队是否都已清零；直播页不看库存快照，
    // 看这条线路最近 15 秒还有没有下载记录。
    const idle = live ? !line.seenInActivityWindow : inventoryQuiet;
    if (idle) return { mirror: line.mirror, text: DOWNLOAD_CARD_TEXT.lineIdle, tone: 'idle' };
    if (line.fetchedEndsInWindow) {
      return { mirror: line.mirror, text: `下载中 · ${speedText(line.bitsPerSecond)}`, tone: 'ok' };
    }
    const failureText = LINE_FAILURE_TEXTS[line.lastResultInWindow];
    if (failureText !== undefined) {
      // 停滞是最轻的一档失败（黄色）；其余线路失败报红。
      const tone = line.lastResultInWindow === 'stalled' ? 'warn' : 'bad';
      return { mirror: line.mirror, text: failureText, tone };
    }
    if (line.lastResultInWindow === 'lost_race') {
      return { mirror: line.mirror, text: DOWNLOAD_CARD_TEXT.lineLostRace, tone: 'idle' };
    }
    return { mirror: line.mirror, text: DOWNLOAD_CARD_TEXT.lineIdle, tone: 'idle' };
  });
}

// 第一行从上往下取第一条成立的：一个时刻只落在一行。等待行的轮数只在该轨还有
// 播放器请求在等（outstanding > 0）且失败过至少一轮时出现：数据已在扩展手里、
// 播放器因别的原因在等时，请求会立刻答完，不写轮数。
function videoHeadline({ status, waitingNow, currentTime, lag }) {
  if (waitingNow) {
    const rounds = Number.isSafeInteger(lag?.outstanding) && lag.outstanding > 0
      && Number.isSafeInteger(lag.failedRounds) && lag.failedRounds >= 1
      ? lag.failedRounds
      : 0;
    return `正在等 ${clockText(currentTime)} 处的数据` + (rounds >= 1 ? `，已重试 ${rounds} 轮` : '');
  }
  const inventory = status.inventory;
  if (inventory?.inflight === 0 && inventory?.queued === 0) {
    return Number.isSafeInteger(lag?.failedRounds) && lag.failedRounds >= 1
      ? DOWNLOAD_CARD_TEXT.pauseWaitingForPlayer
      : DOWNLOAD_CARD_TEXT.pause;
  }
  if (status.anyLineBytesInWindow) return `正在下载 · 合计 ${speedText(status.totalBitsPerSecond)}`;
  return DOWNLOAD_CARD_TEXT.quietVideo;
}

// 第二行：连续字节终点按平均码率折算成秒，取音视频中较小的那个，再与播放器
// 自己的缓冲末端取较大者；两条轨都存到文件末尾时直说整个视频已下载。
function videoSubline({ status, waitingNow, lag, readouts }) {
  if (waitingNow) return undefined;
  const candidates = playerResources(status.inventory?.resources);
  const duration = readouts?.duration;
  if (candidates.length === 0 || !Number.isFinite(duration)) return undefined;
  if (candidates.every((resource) => resource.contiguousEnd === resource.totalSize)) {
    return `整个视频已下载（全长 ${clockText(duration)}）`;
  }
  const estimated = Math.min(...candidates.map((resource) => (resource.contiguousEnd / resource.totalSize) * duration));
  const bufferEnd = Number.isFinite(readouts?.currentTime) && Number.isFinite(readouts?.forwardSeconds)
    ? readouts.currentTime + readouts.forwardSeconds
    : 0;
  const ahead = Math.max(estimated, bufferEnd);
  const rounds = Number.isSafeInteger(lag?.failedRounds) && lag.failedRounds >= 1 ? lag.failedRounds : 0;
  return `已提前下载到约 ${clockText(ahead)}（全长 ${clockText(duration)}）`
    + (rounds >= 1 ? `，之后的数据已重试 ${rounds} 轮` : '');
}

// 组装一张卡片：{ message }（读取中、读取失败、没有 session）或
// { headline, subline, lines }。直播页没有第二行，也没有等待行与暂停行：
// 直播流没有固定的时间位置，下载也不按设计暂停。
export function downloadLinesView({ response, error, inFlight, live, readouts, vodEnabled, liveEnabled }) {
  if (error !== undefined) return { message: DOWNLOAD_CARD_TEXT.readFailed };
  if (response === undefined) return { message: inFlight === true ? DOWNLOAD_CARD_TEXT.loading : DOWNLOAD_CARD_TEXT.noSession };
  const status = response.downloadStatus;
  if (!status.hasRecords) {
    const switchOn = live === true ? liveEnabled !== false : vodEnabled !== false;
    const headline = switchOn
      ? DOWNLOAD_CARD_TEXT.noRecords
      : live === true ? DOWNLOAD_CARD_TEXT.liveSwitchOff : DOWNLOAD_CARD_TEXT.videoSwitchOff;
    return { headline, subline: undefined, lines: [] };
  }
  if (live === true) {
    const headline = status.anyLineBytesInWindow
      ? `正在下载 · 合计 ${speedText(status.totalBitsPerSecond)}`
      : DOWNLOAD_CARD_TEXT.quietLive;
    return { headline, subline: undefined, lines: lineRowsOf(status, { live: true, inventoryQuiet: false }) };
  }
  const waitingNow = readouts?.waiting === true && Number.isFinite(readouts?.currentTime);
  const lag = lagResource(status.inventory?.resources);
  return {
    headline: videoHeadline({ status, waitingNow, currentTime: readouts?.currentTime, lag }),
    subline: videoSubline({ status, waitingNow, lag, readouts }),
    lines: lineRowsOf(status, { live: false, inventoryQuiet: status.inventory?.inflight === 0 && status.inventory?.queued === 0 }),
  };
}

// stateLabel 来自 status snapshot 的映射值（已应用/等待/不支持/失败/未提供）。
export function targetStateText({ hasVideo, stateLabel, enhancementEnabled }) {
  if (hasVideo !== true) return '';
  const mapped = TARGET_STATE_WORDS[stateLabel];
  if (mapped !== undefined) return mapped;
  return enhancementEnabled === false ? SWITCH_OFF_TEXT.videoOffValue : '等待增强启动';
}

// 没有内容脚本可问的页面上，卡片整体收起，只留一句友好提示。
export function applyPageAvailability(documentObject, available) {
  documentObject.querySelector('main')?.classList.toggle('no-page', available !== true);
}

export function surfaceErrorText(snapshot) {
  const error = snapshot?.error;
  return typeof error === 'string' && error.length > 0 && error !== '未提供' ? error : undefined;
}

export function renderVideoPanel(
  documentObject,
  refs,
  { forwardSeconds, snapshot, enhancementEnabled, targetSeconds },
) {
  const hasVideo = Number.isFinite(forwardSeconds);
  // 开关关闭时从未向播放器申请缓存目标，申请措辞与目标后缀一起收起，
  // 只保留观测事实（缓冲数字是播放器自己的缓冲，仍然成立）。
  renderBuffer(documentObject, refs, {
    forwardSeconds,
    targetSeconds,
    stateText: targetStateText({
      hasVideo,
      stateLabel: snapshot?.state,
      enhancementEnabled,
    }),
    targetLabel: enhancementEnabled === false
      ? SWITCH_OFF_TEXT.videoLabel
      : `已向播放器申请 ${targetSeconds} 秒缓存`,
    goalSuffix: enhancementEnabled === false ? '' : undefined,
  });
  const error = surfaceErrorText(snapshot);
  refs.errorLine.hidden = error === undefined;
  refs.errorLine.textContent = error ?? '';
}

export function renderLiveTakeover(refs, { facts, error, liveEnabled } = {}) {
  refs.takeover.textContent = error !== undefined ? '直播状态读取失败' : liveTakeoverText(facts, { liveEnabled });
}

export function renderBuffer(
  documentObject,
  refs,
  { forwardSeconds, targetSeconds, stateText, targetLabel, goalSuffix },
) {
  const hasVideo = Number.isFinite(forwardSeconds) && Number.isFinite(targetSeconds) && targetSeconds > 0;
  if (hasVideo) {
    const percent = Math.max(0, Math.min(100, (forwardSeconds / targetSeconds) * 100));
    refs.fill.style.width = `${percent}%`;
    refs.bar.classList.toggle('reached', forwardSeconds >= targetSeconds);
    refs.seconds.textContent = `${Math.round(forwardSeconds)} 秒`;
    refs.goal.textContent = goalSuffix ?? `/ 目标 ${Math.round(targetSeconds)} 秒`;
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

export function renderCdnLines(documentObject, container, view = {}) {
  container.replaceChildren();
  if (typeof view.message === 'string' && view.message.length > 0) {
    const empty = documentObject.createElement('p');
    empty.className = 'cdn-empty';
    empty.textContent = view.message;
    container.append(empty);
    return;
  }
  const headline = documentObject.createElement('p');
  headline.className = 'cdn-headline';
  headline.textContent = view.headline;
  container.append(headline);
  if (typeof view.subline === 'string' && view.subline.length > 0) {
    const subline = documentObject.createElement('p');
    subline.className = 'cdn-subline';
    subline.textContent = view.subline;
    container.append(subline);
  }
  for (const row of view.lines ?? []) {
    const line = documentObject.createElement('div');
    line.className = 'cdn-line';
    line.dataset.tone = row.tone;
    const head = documentObject.createElement('div');
    head.className = 'cdn-line-head';
    const name = documentObject.createElement('span');
    name.className = 'cdn-name';
    name.textContent = shortMirrorName(row?.mirror);
    const status = documentObject.createElement('span');
    status.className = 'cdn-status';
    status.textContent = row.text;
    head.append(name, status);
    line.append(head);
    container.append(line);
  }
}

const FLV_BACKUP_TEXT = Object.freeze({
  connected: 'FLV 后备校准中',
  calibrated: 'FLV 后备已接上',
  reconnecting: 'FLV 后备重连中',
  given_up: 'FLV 后备已断开',
  unavailable: '无 FLV 后备',
});

export function liveTakeoverText(facts, { liveEnabled } = {}) {
  if (facts && facts.serveCount > 0) {
    if (facts.engagement === 'engaged') {
      const backup = FLV_BACKUP_TEXT[facts.flvBackup];
      const suffix = backup === undefined ? '' : `，${backup}`;
      if (facts.pairedAddressAvailable && !facts.pairRejected) return `正在按两条线路竞速下载${suffix}`;
      // 未配到备用线路，或备用线路前缀比对不一致被撤销，都只剩播放器所名的一路。
      return `单路接管（无可用备用线路）${suffix}`;
    }
    if (facts.engagement === 'failed') return '接管请求失败';
    // 只有放行事件（例如播放器未使用直播媒体流）时，接管从未介入，不能谎报成接管。
    return '未接管（未发现直播媒体流）';
  }
  // 没有任何接管事实：开关关闭就是接管不介入的原因（让路规则不产生 bank.serve），
  // 直说开关；开关开着时才有可能等到数据。
  if (liveEnabled === false) return SWITCH_OFF_TEXT.liveOff;
  return '等待直播数据';
}
