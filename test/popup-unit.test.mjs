import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  POPUP_ROUTE,
  applyPopupRoute,
  emptyLiveFacts,
  foldLiveEvents,
  liveServeClass,
  popupRouteForTabUrl,
  preferenceNames,
  savePreferenceChange,
  storedPreferences,
} from '../src/extension/popup-live.js';
import {
  NO_PAGE_MESSAGES,
  SWITCH_OFF_TEXT,
  applyPageAvailability,
  cdnLinesView,
  connectionText,
  lineHealth,
  liveTakeoverText,
  renderBuffer,
  renderCdnLines,
  renderLiveTakeover,
  renderVideoPanel,
  shortMirrorName,
  surfaceErrorText,
  targetStateText,
} from '../src/extension/popup-view.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const popupHtml = fs.readFileSync(path.join(root, 'src/extension/popup.html'), 'utf8');

function popupDocument() {
  return new JSDOM(popupHtml).window.document;
}

function popupRefs(document) {
  return {
    bar: document.querySelector('[data-buffer-bar]'),
    fill: document.querySelector('[data-buffer-fill]'),
    seconds: document.querySelector('[data-buffer-seconds]'),
    goal: document.querySelector('[data-buffer-goal]'),
    note: document.querySelector('[data-buffer-note]'),
    targetLabel: document.querySelector('[data-buffer-target-label]'),
    targetValue: document.querySelector('[data-target-value]'),
    stateLine: document.querySelector('[data-status-field="state"]'),
    errorLine: document.querySelector('[data-status-field="error"]'),
  };
}

test('popup route classification treats live.bilibili.com as live and everything else as video', () => {
  assert.equal(popupRouteForTabUrl('https://live.bilibili.com/21452505'), POPUP_ROUTE.LIVE);
  assert.equal(popupRouteForTabUrl('https://www.bilibili.com/video/BV1'), POPUP_ROUTE.VIDEO);
  assert.equal(popupRouteForTabUrl('https://search.bilibili.com/all'), POPUP_ROUTE.VIDEO);
  assert.equal(popupRouteForTabUrl(undefined), POPUP_ROUTE.VIDEO);
  assert.equal(popupRouteForTabUrl('not a url'), POPUP_ROUTE.VIDEO);
});

test('popup always shows both switches with their own labels, on either route', () => {
  for (const route of [POPUP_ROUTE.VIDEO, POPUP_ROUTE.LIVE]) {
    const document = popupDocument();
    applyPopupRoute(document, route);
    const labels = [...document.querySelectorAll('.switch-row span')].map((span) => span.textContent);
    assert.deepEqual(labels, ['视频增强', '直播增强']);
    for (const name of preferenceNames()) {
      const input = document.querySelector(`input[data-preference="${name}"]`);
      assert.notEqual(input, undefined, `缺少开关 input: ${name}`);
      assert.equal(input.closest('.switch-row').hidden, false);
    }
  }
});

test('popup on a video route shows the buffer card and hides the live takeover card', () => {
  const document = popupDocument();
  applyPopupRoute(document, POPUP_ROUTE.VIDEO);
  assert.equal(document.querySelector('[data-live-panel]').hidden, true);
  assert.equal(document.querySelector('[aria-label="缓冲"]').hidden, false);
  assert.equal(document.querySelector('[aria-label="下载线路"]').hidden, false);
});

test('popup on a live route hides the buffer card and shows the takeover card', () => {
  const document = popupDocument();
  applyPopupRoute(document, POPUP_ROUTE.LIVE);
  assert.equal(document.querySelector('[data-live-panel]').hidden, false);
  assert.equal(document.querySelector('[aria-label="缓冲"]').hidden, true);
  assert.equal(document.querySelector('[aria-label="下载线路"]').hidden, false);
});

test('stored preferences default both switches to on and treat only false as off', () => {
  assert.deepEqual(storedPreferences({}), { vodEnabled: true, liveEnabled: true });
  assert.deepEqual(
    storedPreferences({ vodEnabled: false, liveEnabled: false }),
    { vodEnabled: false, liveEnabled: false },
  );
  assert.deepEqual(
    storedPreferences({ vodEnabled: true, liveEnabled: 'no' }),
    { vodEnabled: true, liveEnabled: true },
  );
});

test('each switch saves its own preference and only the video switch affects the video panel', async () => {
  const writes = [];
  const storageObject = {
    async set(value) { writes.push(value); },
  };
  assert.equal(
    await savePreferenceChange({ name: 'liveEnabled', checked: false, storageObject }),
    false,
    '直播开关不得影响视频面板',
  );
  assert.deepEqual(writes, [{ liveEnabled: false }]);
  assert.equal(
    await savePreferenceChange({ name: 'vodEnabled', checked: false, storageObject }),
    true,
    '视频开关改动要刷新缓冲卡目标状态',
  );
  assert.deepEqual(writes, [{ liveEnabled: false }, { vodEnabled: false }]);
  await assert.rejects(
    savePreferenceChange({ name: 'other', checked: true, storageObject }),
    /未允许的偏好开关/,
  );
  assert.deepEqual(writes, [{ liveEnabled: false }, { vodEnabled: false }]);
});

test('mirror hosts shrink to readable line names that stay distinguishable', () => {
  assert.equal(shortMirrorName('upos-sz-mirrorcosov.bilivideo.com'), 'sz-mirrorcosov');
  assert.equal(shortMirrorName('upos-hz-mirrorakam.akamaized.net'), 'hz-mirrorakam');
  assert.equal(shortMirrorName('d1--ov-gotcha07.bilivideo.com'), 'ov-gotcha07');
  assert.equal(shortMirrorName('d1--ov-gotcha07b.bilivideo.com'), 'ov-gotcha07b');
  assert.equal(shortMirrorName('a.bilivideo.com'), 'a.bilivideo.com');
  assert.equal(shortMirrorName(undefined), '未知线路');
});

test('connection text names a typical value and a slow case in milliseconds', () => {
  assert.equal(connectionText(48.2, 131.6), '通常 48 毫秒 · 慢时 132 毫秒');
  assert.equal(connectionText(48, undefined), '通常 48 毫秒');
  assert.equal(connectionText(undefined, 131), undefined);
});

test('line health words come from stalls, failures, and delivered bytes', () => {
  assert.deepEqual(lineHealth({ stalled: 2, failures: 0, ttfbP50: 40, bytesDelivered: 10 }), { word: '有停滞', tone: 'warn' });
  assert.deepEqual(lineHealth({ stalled: 0, failures: 1, ttfbP50: 40, bytesDelivered: 10 }), { word: '有错误', tone: 'bad' });
  assert.deepEqual(lineHealth({ stalled: 0, failures: 0, ttfbP50: 40, bytesDelivered: 10 }), { word: '正常', tone: 'ok' });
  assert.deepEqual(lineHealth({ stalled: 0, failures: 0, ttfbP50: undefined, bytesDelivered: 0 }), { word: '尚无数据', tone: 'idle' });
});

test('cdn lines render every mirror with its health word and connection time', () => {
  const document = popupDocument();
  const container = document.querySelector('[data-cdn-lines]');
  renderCdnLines(document, container, {
    rows: [
      { mirror: 'upos-sz-mirrorcosov.bilivideo.com', ttfbP50: 48.2, ttfbP90: 131.6, stalled: 0, failures: 0, bytesDelivered: 4096 },
      { mirror: 'upos-hz-mirrorakam.akamaized.net', ttfbP50: 51, ttfbP90: 200, stalled: 3, failures: 0, bytesDelivered: 0 },
    ],
  });
  const lines = [...container.querySelectorAll('.cdn-line')];
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => line.querySelector('.cdn-name').textContent),
    ['sz-mirrorcosov', 'hz-mirrorakam'],
  );
  assert.deepEqual(
    lines.map((line) => line.querySelector('.cdn-health').textContent),
    ['正常', '有停滞'],
  );
  assert.deepEqual(
    lines.map((line) => line.querySelector('.cdn-conn').textContent),
    ['通常 48 毫秒 · 慢时 132 毫秒', '通常 51 毫秒 · 慢时 200 毫秒'],
  );
  assert.equal(container.textContent.includes('readyState'), false);
  assert.equal(container.textContent.includes('TTFB'), false);
});

test('cdn lines degrade to a plain message when there is no data or a read error', () => {
  const document = popupDocument();
  const container = document.querySelector('[data-cdn-lines]');
  renderCdnLines(document, container, { message: '还没有线路数据' });
  assert.equal(container.querySelector('.cdn-empty').textContent, '还没有线路数据');
  renderCdnLines(document, container, {});
  assert.equal(container.querySelector('.cdn-empty').textContent, '还没有线路数据');
});

test('cdn lines view picks rows, loading, empty, or failure wording', () => {
  const summary = { sampleCount: 2, summary: { rows: [{ mirror: 'a.bilivideo.com' }] } };
  assert.deepEqual(cdnLinesView(summary, undefined, false), { rows: [{ mirror: 'a.bilivideo.com' }] });
  assert.deepEqual(cdnLinesView(undefined, undefined, true), { message: '正在读取线路状态…' });
  assert.deepEqual(cdnLinesView(undefined, undefined, false), { message: '还没有线路数据' });
  assert.deepEqual(cdnLinesView({ sampleCount: 0, summary: { rows: [] } }, undefined, false), { message: '还没有线路数据' });
  assert.deepEqual(cdnLinesView(undefined, 'worker 挂了', false), { message: '线路状态读取失败' });
});

test('buffer renders seconds ahead against the 120-second target on a bar', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderBuffer(document, refs, { forwardSeconds: 80.4, targetSeconds: 120, stateText: '已生效', targetLabel: '已向播放器申请 120 秒缓存' });
  assert.equal(refs.seconds.textContent, '80 秒');
  assert.equal(refs.goal.textContent, '/ 目标 120 秒');
  assert.equal(refs.fill.style.width, '67%');
  assert.equal(refs.bar.classList.contains('reached'), false);
  assert.equal(refs.note.hidden, true);
  assert.equal(refs.targetValue.textContent, '已生效');
  assert.equal(refs.stateLine.hidden, false);
  assert.equal(refs.targetLabel.textContent, '已向播放器申请 120 秒缓存');
});

test('buffer bar fills fully and reports the reached state at or beyond the target', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderBuffer(document, refs, { forwardSeconds: 135.5, targetSeconds: 120, stateText: '已生效', targetLabel: 'x' });
  assert.equal(refs.seconds.textContent, '136 秒');
  assert.equal(refs.fill.style.width, '100%');
  assert.equal(refs.bar.classList.contains('reached'), true);
});

test('buffer without a playing video shows a plain note instead of numbers', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderBuffer(document, refs, { forwardSeconds: undefined, targetSeconds: 120, stateText: '', targetLabel: 'x' });
  assert.equal(refs.seconds.textContent, '—');
  assert.equal(refs.goal.textContent, '');
  assert.equal(refs.fill.style.width, '0%');
  assert.equal(refs.note.hidden, false);
  assert.equal(refs.note.textContent, '当前页面没有在播放的视频');
  assert.equal(refs.stateLine.hidden, true);
});

test('target state words cover applied, waiting, unsupported, failed, and toggle-off', () => {
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '已应用', enhancementEnabled: true }), '已生效');
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '等待', enhancementEnabled: true }), '等待生效');
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '不支持', enhancementEnabled: true }), '播放器不支持，未生效');
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '失败', enhancementEnabled: true }), '申请失败');
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '未提供', enhancementEnabled: false }), SWITCH_OFF_TEXT.videoOffValue);
  assert.equal(targetStateText({ hasVideo: true, stateLabel: '未提供', enhancementEnabled: true }), '等待增强启动');
  assert.equal(targetStateText({ hasVideo: false, stateLabel: '失败', enhancementEnabled: true }), '');
});

test('video panel shows an error only when the page reported one', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderVideoPanel(document, refs, {
    forwardSeconds: 30,
    snapshot: { state: '已应用', error: '未提供' },
    enhancementEnabled: true,
    targetSeconds: 120,
  });
  assert.equal(refs.errorLine.hidden, true);
  renderVideoPanel(document, refs, {
    forwardSeconds: 30,
    snapshot: { state: '失败', error: '原生缓存提示调用失败' },
    enhancementEnabled: true,
    targetSeconds: 120,
  });
  assert.equal(refs.errorLine.hidden, false);
  assert.equal(refs.errorLine.textContent, '原生缓存提示调用失败');
});

test('video panel with the switch off states the switch instead of claiming a buffer request', () => {
  // 开关关闭时从未向播放器申请缓存目标：目标后缀与「已向播放器申请」措辞一起收起，
  // 缓冲数字仍是观测事实（播放器自己的缓冲），只去掉关于扩展行为的假陈述。
  const document = popupDocument();
  const refs = popupRefs(document);
  renderVideoPanel(document, refs, {
    forwardSeconds: 30,
    snapshot: { state: '未提供', error: '未提供' },
    enhancementEnabled: false,
    targetSeconds: 120,
  });
  assert.equal(refs.stateLine.hidden, false);
  assert.equal(refs.targetLabel.textContent, SWITCH_OFF_TEXT.videoLabel);
  assert.equal(refs.targetValue.textContent, SWITCH_OFF_TEXT.videoOffValue);
  assert.equal(refs.seconds.textContent, '30 秒');
  assert.equal(refs.goal.textContent, '');
});

test('video panel with the switch on keeps the request label and goal suffix', () => {
  const document = popupDocument();
  const refs = popupRefs(document);
  renderVideoPanel(document, refs, {
    forwardSeconds: 30,
    snapshot: { state: '已应用', error: '未提供' },
    enhancementEnabled: true,
    targetSeconds: 120,
  });
  assert.equal(refs.targetLabel.textContent, '已向播放器申请 120 秒缓存');
  assert.equal(refs.targetValue.textContent, '已生效');
  assert.equal(refs.goal.textContent, '/ 目标 120 秒');
});

test('surface error text ignores placeholders and empty messages', () => {
  assert.equal(surfaceErrorText({ error: '原生缓存提示调用失败' }), '原生缓存提示调用失败');
  assert.equal(surfaceErrorText({ error: '未提供' }), undefined);
  assert.equal(surfaceErrorText({ error: '' }), undefined);
  assert.equal(surfaceErrorText(undefined), undefined);
});

test('live facts fold serve events into the takeover state only', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: false } },
    { code: 'media.sample', data: { currentTime: 1 } },
    null,
    { code: 'bank.fetch.chunk', data: { result: 'fetched' } },
  ]);
  assert.equal(facts.serveCount, 1);
  assert.equal(facts.engagement, 'engaged');
  assert.equal(facts.pairedAddressAvailable, true);
});

test('serve classification separates engaged takeovers from passes', () => {
  assert.equal(liveServeClass('hit'), 'engaged');
  assert.equal(liveServeClass('failed'), 'failed');
  assert.equal(liveServeClass('pass'), 'pass');
  assert.equal(liveServeClass(undefined), 'pass');
});

test('a passed-through live stream never reads as a takeover', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'pass', reason: 'non_media_host' } },
    { code: 'bank.serve', data: { result: 'pass', reason: 'live_hls_playlist' } },
  ]);
  assert.equal(facts.serveCount, 2);
  assert.equal(facts.engagement, undefined);
  assert.equal(liveTakeoverText(facts), '未接管（未发现直播媒体流）');
});

test('an engaged takeover stays engaged even when other requests pass through', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'bank.serve', data: { result: 'pass', reason: 'non_media_host' } },
    { code: 'bank.serve', data: { result: 'pass', reason: 'live_hls_playlist' } },
  ]);
  assert.equal(liveTakeoverText(facts), '正在按两条线路竞速下载');
});

test('a prefix mismatch withdraws the racing claim down to single leg', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: true, phase: 'prefix' } },
  ]);
  assert.equal(liveTakeoverText(facts), '单路接管（无可用备用线路）');
  const cleanPair = emptyLiveFacts();
  foldLiveEvents(cleanPair, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: false, phase: 'prefix' } },
  ]);
  assert.equal(liveTakeoverText(cleanPair), '正在按两条线路竞速下载');
});

test('a stream that dies after engaging reports the failure instead of racing', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'bank.serve', data: { result: 'failed', reason: 'live_stream_failed' } },
  ]);
  assert.equal(liveTakeoverText(facts), '接管请求失败');
});

test('a retried takeover resets the state to the new takeover facts', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: true, phase: 'prefix' } },
    { code: 'bank.serve', data: { result: 'failed', reason: 'live_stream_failed' } },
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream' } },
    { code: 'bank.serve', data: { result: 'pass', reason: 'live_hls_playlist' } },
  ]);
  assert.equal(facts.pairedAddressAvailable, false);
  assert.equal(facts.pairRejected, false);
  assert.equal(liveTakeoverText(facts), '单路接管（无可用备用线路）');
});

test('live takeover wording covers racing, single line, failure, pass-through, and waiting', () => {
  assert.equal(liveTakeoverText({ serveCount: 2, engagement: 'engaged', pairedAddressAvailable: true }), '正在按两条线路竞速下载');
  assert.equal(liveTakeoverText({ serveCount: 2, engagement: 'engaged', pairedAddressAvailable: false }), '单路接管（无可用备用线路）');
  assert.equal(liveTakeoverText({ serveCount: 3, engagement: 'failed' }), '接管请求失败');
  assert.equal(liveTakeoverText({ serveCount: 3 }), '未接管（未发现直播媒体流）');
  assert.equal(liveTakeoverText(emptyLiveFacts()), '等待直播数据');
  assert.equal(liveTakeoverText(undefined), '等待直播数据');
});

test('live takeover with the switch off and no takeover facts states the switch instead of waiting', () => {
  // 开关关闭时接管按设计永不介入（README 下载层让路规则不产生 bank.serve）：
  // 再说「等待直播数据」就是让面板空等，直说开关已关闭。
  assert.equal(liveTakeoverText(emptyLiveFacts(), { liveEnabled: false }), SWITCH_OFF_TEXT.liveOff);
  assert.equal(liveTakeoverText(undefined, { liveEnabled: false }), SWITCH_OFF_TEXT.liveOff);
  assert.equal(liveTakeoverText(emptyLiveFacts(), { liveEnabled: true }), '等待直播数据');
});

test('live takeover facts win over a switch-off that has not been refreshed yet', () => {
  // 改动在刷新页面后生效：刷新前接管仍在运行，面板继续报接管事实，不抢戏报开关。
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
  ]);
  assert.equal(liveTakeoverText(facts, { liveEnabled: false }), '正在按两条线路竞速下载');
});

test('hls segment takeover folds through the same live facts as the flv stream', () => {
  const racing = emptyLiveFacts();
  foldLiveEvents(racing, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_hls_segment', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { mismatch: false, phase: 'segment' } },
  ]);
  assert.equal(liveTakeoverText(racing), '正在按两条线路竞速下载');

  const mismatched = emptyLiveFacts();
  foldLiveEvents(mismatched, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_hls_segment', pairedAddressAvailable: true } },
    { code: 'live.stream.stitch', data: { streamPath: '/live-bvc/791488/live_x/', bytesChecked: 4, mismatch: true, phase: 'segment' } },
  ]);
  assert.equal(mismatched.pairRejected, true);
  assert.equal(liveTakeoverText(mismatched), '单路接管（无可用备用线路）');

  const single = emptyLiveFacts();
  foldLiveEvents(single, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_hls_segment_unpaired', pairMiss: 'no_book_entry' } },
  ]);
  assert.equal(single.pairedAddressAvailable, false);
  assert.equal(liveTakeoverText(single), '单路接管（无可用备用线路）');

  const failed = emptyLiveFacts();
  foldLiveEvents(failed, [
    { code: 'bank.serve', data: { result: 'failed', reason: 'live_hls_segment_failed' } },
  ]);
  assert.equal(liveTakeoverText(failed), '接管请求失败');

  const playlistOnly = emptyLiveFacts();
  foldLiveEvents(playlistOnly, [
    { code: 'bank.serve', data: { result: 'pass', reason: 'live_hls_playlist' } },
  ]);
  assert.equal(playlistOnly.engagement, undefined);
  assert.equal(liveTakeoverText(playlistOnly), '未接管（未发现直播媒体流）');
});

test('live takeover renders the plain line and degrades on read errors', () => {
  const document = popupDocument();
  const refs = { takeover: document.querySelector('[data-live-takeover]') };
  renderLiveTakeover(refs, { facts: { serveCount: 1, engagement: 'engaged', pairedAddressAvailable: true } });
  assert.equal(refs.takeover.textContent, '正在按两条线路竞速下载');
  renderLiveTakeover(refs, { facts: emptyLiveFacts(), error: '日志分页没有向前推进' });
  assert.equal(refs.takeover.textContent, '直播状态读取失败');
  renderLiveTakeover(refs, { facts: emptyLiveFacts(), liveEnabled: false });
  assert.equal(refs.takeover.textContent, SWITCH_OFF_TEXT.liveOff);
});

test('pages without the content script collapse the cards down to one friendly line', () => {
  const document = popupDocument();
  applyPageAvailability(document, false);
  assert.equal(document.querySelector('main').classList.contains('no-page'), true);
  applyPageAvailability(document, true);
  assert.equal(document.querySelector('main').classList.contains('no-page'), false);
  assert.equal(NO_PAGE_MESSAGES.noReceiver.includes('Bilibili'), true);
  assert.equal(NO_PAGE_MESSAGES.noTab.includes('Bilibili'), true);
});

// ---- 完整 popup 装配（jsdom + 假 chrome）：活动标签页换页后的探测行为 ----
const RECEIVER_MISSING = 'Could not establish connection. Receiving end does not exist.';

function liveReadouts(sessionId = 'session-live-1') {
  return {
    version: 2,
    routeKind: 'live',
    forwardSeconds: undefined,
    diagnostics: { sessionId },
  };
}

function videoReadouts(sessionId = 'session-video-1') {
  return {
    version: 2,
    routeKind: 'video',
    forwardSeconds: 80,
    diagnostics: { sessionId },
  };
}

// chrome.tabs.query 的 url 过滤语义（match pattern 子集：scheme://host/path，path 末尾 *）。
// 面板扩展没有 tabs 权限：地址只参与 Chrome 内部过滤，不会出现在返回的标签页对象上。
function urlMatchesPattern(url, pattern) {
  const match = /^(\*|https?|file|ftp):\/\/([^/]+)(\/.*)$/.exec(pattern);
  assert.ok(match !== null, `fixture 里遇到未支持的 match pattern: ${pattern}`);
  const [, scheme, host, pathPattern] = match;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (error) {
    return false;
  }
  if (scheme !== '*' && parsed.protocol !== `${scheme}:`) return false;
  const hostPattern = host.startsWith('*.') ? `*.${host.slice(2)}` : host;
  const hostMatches = hostPattern === '*'
    || parsed.hostname === host
    || (host.startsWith('*.') && parsed.hostname.endsWith(hostPattern.slice(1)));
  if (!hostMatches) return false;
  const escaped = pathPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*');
  return new RegExp(`^${escaped}$`).test(parsed.pathname);
}

// 假 Chrome 的窗口世界：windows 是 [{ id, tabs: [{ id, url, active }] }]。假
// chrome.tabs.query 复刻无 tabs 权限行为：url 过滤在 Chrome 内部判定，返回的标签页
// 不携带 url 字段。popupAttachedTab 需要的 windowId 字段始终可见，予以保留。
function popupChromeMock({ currentWindowId, lastFocusedWindowId, windows, tabBehaviors }) {
  const calls = { queries: [], tabMessages: [], runtimeMessages: [] };
  const tabsOfWindow = (windowId) => windows.find((w) => w.id === windowId)?.tabs ?? [];
  const stripUrl = (tab) => ({ id: tab.id, active: tab.active, windowId: tab.windowId });
  const windowed = (tab, windowId) => ({ ...tab, windowId });
  const allTabs = windows.flatMap((w) => w.tabs.map((tab) => windowed(tab, w.id)));
  const visibleTabs = (windowId) => tabsOfWindow(windowId).map((tab) => windowed(tab, windowId));
  const chrome = {
    windows: {
      getCurrent: async () => ({ id: currentWindowId }),
    },
    runtime: {
      lastError: undefined,
      getURL: (path) => `chrome-extension://test-extension-id/${path}`,
      sendMessage: async (message) => {
        calls.runtimeMessages.push(message);
        if (message.type === 'logs:live-summary') {
          return {
            ok: true,
            maxEventId: 10,
            sampleCount: 2,
            facts: { serveCount: 2, engagement: 'engaged', pairedAddressAvailable: true, pairRejected: false },
          };
        }
        if (message.type === 'logs:cdn-summary') {
          return {
            ok: true,
            maxEventId: 10,
            sampleCount: 1,
            summary: {
              totalChunks: 1,
              pairedChunks: 1,
              pairCoverage: 1,
              fetchedBytes: 16,
              wastedBytes: 0,
              wastedByteRatio: 0,
              byResult: { fetched: 1, lost_race: 0, stalled: 0, aborted: 0, superseded: 0, network_error: 0, http_error: 0, invalid_response: 0, gave_up: 0 },
              rows: [{ mirror: 'd1--ov-gotcha207.bilivideo.com', racesEntered: 1, wins: 1, winRate: 1, ttfbP50: 40, ttfbP90: 60, stalled: 0, failures: 0, bytesDelivered: 16 }],
            },
          };
        }
        throw new Error(`意外的日志读取消息 ${message.type}`);
      },
    },
    storage: { local: { get: async () => ({}) } },
    tabs: {
      query: async (options) => {
        calls.queries.push(options);
        if (options.active === true && options.windowId !== undefined) {
          return visibleTabs(options.windowId).filter((tab) => tab.active === true).map(stripUrl);
        }
        if (options.active === true && options.lastFocusedWindow === true) {
          return visibleTabs(lastFocusedWindowId).filter((tab) => tab.active === true).map(stripUrl);
        }
        if (Array.isArray(options.url)) {
          const candidates = options.windowId !== undefined ? visibleTabs(options.windowId) : allTabs;
          return candidates
            .filter((tab) => options.url.some((pattern) => urlMatchesPattern(tab.url, pattern)))
            .map(stripUrl);
        }
        return allTabs.map(stripUrl);
      },
      sendMessage: async (tabId, message) => {
        calls.tabMessages.push({ tabId, type: message.type });
        const behavior = tabBehaviors.get(tabId);
        if (behavior === undefined) throw new Error(RECEIVER_MISSING);
        if (behavior === 'reject') throw new Error(RECEIVER_MISSING);
        return behavior(message);
      },
      create: async () => ({}),
    },
  };
  return { chrome, calls };
}

async function withPopupAssembly(chrome, run) {
  const dom = new JSDOM(popupHtml);
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousChrome = globalThis.chrome;
  globalThis.document = dom.window.document;
  globalThis.window = dom.window;
  globalThis.chrome = chrome;
  try {
    await import(`../src/extension/popup.js?case=${Date.now()}-${Math.random()}`);
    await run(dom.window);
  } finally {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'));
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
    globalThis.chrome = previousChrome;
  }
}

function settleMacrotasks(rounds = 4) {
  let remaining = rounds;
  return new Promise((resolve) => {
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else setImmediate(step);
    };
    setImmediate(step);
  });
}

test('popup reports the active tab of its own window, never the last-focused window\'s', async () => {
  // 回归锚（0e982f5 的缺陷，用户实测）：两个普通窗口时，弹窗开在视频页
  // 所在窗口，lastFocusedWindow 解析到另一窗口的直播房间；本装配下 lastFocusedWindow
  // 查询固定返回直播标签页（id 2），按旧取法面板会显示直播内容。
  const behaviors = new Map([
    [1, (message) => {
      if (message.type === 'readouts:get') return videoReadouts();
      if (message.type === 'status:get') return { version: 2, ok: true, state: '未提供' };
      if (message.type === 'diagnostics:session-id:get') return { version: 2, ok: true, sessionId: 'session-video-1' };
      throw new Error(`意外消息 ${message.type}`);
    }],
    [2, (message) => {
      if (message.type === 'readouts:get') return liveReadouts();
      throw new Error(`意外消息 ${message.type}`);
    }],
  ]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 20,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://www.bilibili.com/video/BV1', active: true }] },
      { id: 20, tabs: [{ id: 2, url: 'https://live.bilibili.com/6', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, 'true');
    assert.equal(document.querySelector('main').classList.contains('no-page'), false);
    assert.equal(document.querySelector('[data-notice]').textContent, '');
    // 本窗口是视频标签页：直播接管卡收起，缓冲卡保持可见，直播事实不得泄漏进来。
    assert.equal(document.querySelector('[data-live-panel]').hidden, true);
    assert.equal(document.querySelector('[aria-label="缓冲"]').hidden, false);
    // 只问本窗口的活动标签页；跨窗口的直播标签页一次都没有被询问过。
    assert.deepEqual(
      [...new Set(calls.tabMessages.filter((call) => call.type === 'readouts:get').map((call) => call.tabId))],
      [1],
    );
    assert.equal(calls.tabMessages.some((call) => call.tabId === 2), false, '不得询问另一个窗口的标签页');
    // 归属一律经 windowId：lastFocusedWindow 与全窗口扫描都不再出现。
    assert.equal(
      calls.queries.some((options) => options.lastFocusedWindow === true),
      false,
      '不得按 lastFocusedWindow 定位标签页',
    );
    assert.equal(
      calls.queries.every((options) => options.windowId !== undefined || Array.isArray(options.url)),
      true,
      '不得发起全窗口扫描查询',
    );
    // 打开日志按钮带的是本窗口视频标签页的 session。
    document.querySelector('[data-open-logs]').click();
    await settleMacrotasks();
    assert.deepEqual(
      calls.tabMessages.filter((call) => call.type === 'diagnostics:session-id:get').map((call) => call.tabId),
      [1],
    );
  });
});

test('popup never adopts another window\'s enhanced tab when its own active tab cannot answer', async () => {
  const behaviors = new Map([
    [1, 'reject'],
    [2, (message) => {
      if (message.type === 'readouts:get') return videoReadouts();
      if (message.type === 'status:get') return { version: 2, ok: true, state: '未提供' };
      throw new Error(`意外消息 ${message.type}`);
    }],
  ]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 20,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://example.com/', active: true }] },
      { id: 20, tabs: [{ id: 2, url: 'https://www.bilibili.com/video/BV1', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, undefined);
    assert.equal(document.querySelector('main').classList.contains('no-page'), true);
    assert.equal(document.querySelector('[data-notice]').textContent, NO_PAGE_MESSAGES.noReceiver);
    assert.equal(calls.runtimeMessages.some((message) => message.type === 'logs:live-summary'), false);
    assert.deepEqual(
      [...new Set(calls.tabMessages.map((call) => call.tabId))],
      [1],
      '另一个窗口仍在运行增强的标签页不得被询问或显示',
    );
  });
});

test('a pre-existing Bilibili page without the content script gets the truthful merged message', async () => {
  // 页面在扩展安装或更新前就已打开：旧文档没有内容脚本可答。弹窗没有 tabs 权限、
  // 看不到标签页地址，分不出这种情况与「非 Bilibili 页面」，统一的未运行提示对两种
  // 情况都成立：说明刷新后增强才会运行，不谎称页面不受支持。
  const behaviors = new Map([[1, 'reject']]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 10,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://www.bilibili.com/video/BV1', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, undefined);
    assert.equal(document.querySelector('main').classList.contains('no-page'), true);
    assert.equal(document.querySelector('[data-notice]').textContent, NO_PAGE_MESSAGES.noReceiver);
    assert.ok(NO_PAGE_MESSAGES.noReceiver.includes('刷新'), '提示必须给出刷新路径');
    assert.ok(NO_PAGE_MESSAGES.noReceiver.includes('视频或直播'), '提示不得谎称页面不受支持');
  });
});

test('a non-Bilibili active tab keeps the plain not-running message', async () => {
  const behaviors = new Map([[1, 'reject']]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 10,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://example.com/', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.querySelector('main').classList.contains('no-page'), true);
    assert.equal(document.querySelector('[data-notice]').textContent, NO_PAGE_MESSAGES.noReceiver);
    // 没必要且没有权限做的 url 过滤查询不得出现。
    assert.equal(calls.queries.some((options) => Array.isArray(options.url)), false);
  });
});

test('popup asks only its own window\'s active tab while that tab answers', async () => {
  const behaviors = new Map([
    [1, (message) => {
      if (message.type === 'readouts:get') return liveReadouts();
      if (message.type === 'status:get') return { version: 2, ok: true, state: '未提供' };
      throw new Error(`意外消息 ${message.type}`);
    }],
  ]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 10,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://live.bilibili.com/6', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, 'true');
    assert.equal(document.querySelector('[data-notice]').textContent, '');
    assert.equal(document.querySelector('[data-live-panel]').hidden, false);
    assert.equal(document.querySelector('[data-live-takeover]').textContent, '正在按两条线路竞速下载');
    assert.deepEqual(
      [...new Set(calls.tabMessages.filter((call) => call.type === 'readouts:get').map((call) => call.tabId))],
      [1],
    );
    // 直播状态走 worker 摘要，不再按全局 eventId 分页扫全库。
    assert.equal(calls.runtimeMessages.some((message) => message.type === 'logs:live-summary'), true);
    assert.equal(calls.runtimeMessages.some((message) => message.type === 'logs:events-page'), false);
  });
});

test('video popup feeds the status:get snapshot to the target-state line', async () => {
  // 回归锚：status:get 拿到的 snapshot 必须进入 video 面板的申请状态行
  // （一度在面板装配里取回但未接上，状态行永远停在「等待增强启动」）。
  const behaviors = new Map([
    [1, (message) => {
      if (message.type === 'readouts:get') return videoReadouts();
      if (message.type === 'status:get') return { version: 2, ok: true, state: '已应用', error: '未提供' };
      if (message.type === 'diagnostics:session-id:get') return { version: 2, ok: true, sessionId: 'session-video-1' };
      throw new Error(`意外消息 ${message.type}`);
    }],
  ]);
  const { chrome, calls } = popupChromeMock({
    currentWindowId: 10,
    lastFocusedWindowId: 10,
    windows: [
      { id: 10, tabs: [{ id: 1, url: 'https://www.bilibili.com/video/BV1', active: true }] },
    ],
    tabBehaviors: behaviors,
  });
  await withPopupAssembly(chrome, async (domWindow) => {
    await settleMacrotasks();
    const document = domWindow.document;
    assert.equal(document.body.dataset.ready, 'true');
    assert.equal(document.querySelector('[data-target-value]').textContent, '已生效');
    assert.equal(document.querySelector('[data-status-field="state"]').hidden, false);
    assert.equal(document.querySelector('[data-status-field="error"]').hidden, true);
    assert.deepEqual(
      [...new Set(calls.tabMessages.filter((call) => call.type === 'status:get').map((call) => call.tabId))],
      [1],
    );
  });
});
