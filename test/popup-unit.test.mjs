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
  popupRouteForTabUrl,
  popupToggleLabel,
  renderLiveFacts,
} from '../src/extension/popup-live.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const popupHtml = fs.readFileSync(path.join(root, 'src/extension/popup.html'), 'utf8');

function popupDocument() {
  return new JSDOM(popupHtml).window.document;
}

test('popup route classification treats live.bilibili.com as live and everything else as video', () => {
  assert.equal(popupRouteForTabUrl('https://live.bilibili.com/21452505'), POPUP_ROUTE.LIVE);
  assert.equal(popupRouteForTabUrl('https://www.bilibili.com/video/BV1'), POPUP_ROUTE.VIDEO);
  assert.equal(popupRouteForTabUrl('https://search.bilibili.com/all'), POPUP_ROUTE.VIDEO);
  assert.equal(popupRouteForTabUrl(undefined), POPUP_ROUTE.VIDEO);
  assert.equal(popupRouteForTabUrl('not a url'), POPUP_ROUTE.VIDEO);
  assert.equal(popupToggleLabel(POPUP_ROUTE.LIVE), '直播增强');
  assert.equal(popupToggleLabel(POPUP_ROUTE.VIDEO), '视频增强');
});

test('popup on a video route keeps the video toggle label and all video blocks visible', () => {
  const document = popupDocument();
  applyPopupRoute(document, POPUP_ROUTE.VIDEO);
  assert.equal(document.querySelector('[data-vod-toggle-label]').textContent, '视频增强');
  assert.equal(document.querySelector('[data-live-panel]').hidden, true);
  for (const block of document.querySelectorAll('[data-vod-only]')) {
    assert.equal(block.hidden, false);
  }
  assert.equal(document.querySelector('[aria-label="下载层库存"]').hidden, false);
  assert.equal(document.querySelector('[aria-label="媒体缓冲"]').hidden, false);
});

test('popup on a live route relabels the toggle, hides video-only blocks, and shows the live panel', () => {
  const document = popupDocument();
  applyPopupRoute(document, POPUP_ROUTE.LIVE);
  assert.equal(document.querySelector('[data-vod-toggle-label]').textContent, '直播增强');
  assert.equal(document.querySelector('[data-live-panel]').hidden, false);
  assert.equal(document.querySelector('[aria-label="下载层库存"]').hidden, true);
  assert.equal(document.querySelector('[aria-label="媒体缓冲"]').hidden, true);
  assert.equal(document.querySelector('[aria-label="当前页面事实"]').hidden, true);
  assert.equal(document.querySelector('[aria-label="镜像竞速"]').hidden, false);
  assert.equal(document.querySelector('[aria-label="诊断"]').hidden, false);
});

test('live facts fold bank.serve, stitch, and error events into counts and latest rows', () => {
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream', pairedAddressAvailable: true } },
    { code: 'bank.serve', data: { result: 'hit', reason: 'live_stream_unpaired', pairMiss: 'no_book_entry' } },
    { code: 'bank.serve', data: { result: 'failed', reason: 'live_stream_failed', errorName: 'BankNetworkError' } },
    { code: 'live.stream.stitch', data: { mismatch: false, phase: 'prefix', bytesChecked: 64 } },
    { code: 'log.error', data: { errorName: 'BankNetworkError', code: 'LIVE_TAKEOVER' } },
    { code: 'media.sample', data: { currentTime: 1 } },
    null,
    { code: 'bank.fetch.chunk', data: { result: 'fetched' } },
  ]);
  assert.equal(facts.serveCount, 3);
  assert.equal(facts.pairMissCount, 1);
  assert.equal(facts.stitchCount, 1);
  assert.equal(facts.errorCount, 1);
  assert.deepEqual(facts.latestServe, {
    result: 'failed',
    reason: 'live_stream_failed',
    durationMs: undefined,
    pairMiss: undefined,
    pairedAddressAvailable: undefined,
    errorName: 'BankNetworkError',
  });
  assert.deepEqual(facts.latestStitch, { mismatch: false, phase: 'prefix', bytesChecked: 64 });
});

test('live facts render takeover status, stitch gate, and counts on a live route document', () => {
  const document = popupDocument();
  const container = document.querySelector('[data-live-panel-body]');
  const facts = emptyLiveFacts();
  foldLiveEvents(facts, [
    {
      code: 'bank.serve',
      data: { result: 'hit', reason: 'live_stream_unpaired', pairMiss: 'stale', durationMs: 3 },
    },
    { code: 'live.stream.stitch', data: { mismatch: true, phase: 'stream', bytesChecked: 128 } },
    { code: 'log.error', data: {} },
  ]);
  renderLiveFacts(document, container, facts, {});
  const rows = [...container.querySelectorAll('.readout-row')].map((row) =>
    [row.querySelector('dt').textContent, row.querySelector('dd').textContent]);
  assert.deepEqual(rows, [
    ['接管状态', 'hit · live_stream_unpaired · stale'],
    ['缝合门', 'stream · mismatch=true · bytesChecked=128'],
    ['应答计数', '1'],
    ['配对缺失', '1'],
    ['缝合计数', '1'],
    ['错误计数', '1'],
  ]);
});

test('live facts render degrades to placeholders without a session and shows read errors', () => {
  const document = popupDocument();
  const container = document.querySelector('[data-live-panel-body]');
  const facts = emptyLiveFacts();
  renderLiveFacts(document, container, facts, { hasSession: false });
  assert.equal(container.querySelector('dd').textContent, '未提供');
  renderLiveFacts(document, container, facts, { error: 'worker 挂了' });
  assert.equal(container.querySelector('dd').textContent, '读取失败: worker 挂了');
  renderLiveFacts(document, container, facts, { inFlight: true });
  assert.equal(container.querySelector('dd').textContent, '读取中');
});
