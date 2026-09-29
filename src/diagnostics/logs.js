import { sessionIdFromHash } from './log-session.js';
import { aggregateCdnEvents } from './cdn.js';
import { writeEvents, writeSessions } from './export.js';
import { CDN_RANGE_MESSAGES, cdnPanelState } from './logs-view.js';

export { aggregateCdnEvents };

const MESSAGE_VERSION = 1;

const sessionSelect = document.querySelector('[data-session-filter]');
const exportButton = document.querySelector('[data-export]');
const statusElement = document.querySelector('[data-status]');
const sessionDetails = document.querySelector('[data-session-details]');
const cdnButton = document.querySelector('[data-cdn-refresh]');
const cdnStatusElement = document.querySelector('[data-cdn-status]');
const cdnSummaryElement = document.querySelector('[data-cdn-summary]');
const cdnRowsElement = document.querySelector('[data-cdn-rows]');

const currentSessionId = sessionIdFromHash(window.location.hash);

function display(value) {
  return value === undefined || value === null || value === '' ? '未提供' : String(value);
}

async function send(message) {
  const response = await chrome.runtime.sendMessage({ version: MESSAGE_VERSION, ...message });
  if (response?.ok !== true) {
    throw Object.assign(new Error(response?.error?.message || '日志服务拒绝请求'), {
      code: response?.error?.code || 'LOG_MESSAGE_FAILED',
    });
  }
  return response;
}

function selectedSessionId() {
  if (sessionSelect.value === 'current') {
    if (currentSessionId === undefined) throw new Error('当前活动页面没有可用日志 session');
    return currentSessionId;
  }
  return sessionSelect.value || undefined;
}

function renderDetails() {
  const value = sessionSelect.value === 'current' ? currentSessionId : sessionSelect.value;
  sessionDetails.textContent = value === undefined || value === '' ? '导出全部 session' : `筛选 session: ${value}`;
}

function ratioText(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function metricText(value, suffix = '') {
  return value === undefined ? '未提供' : `${value.toFixed(1)}${suffix}`;
}

function integerText(value) {
  return String(value);
}

export function renderCdnPanel(summary, summaryElement = cdnSummaryElement, rowsElement = cdnRowsElement) {
  summaryElement.textContent = [
    `配对覆盖率 ${summary.pairedChunks}/${summary.totalChunks} (${ratioText(summary.pairCoverage)})`,
    `浪费字节率 ${ratioText(summary.wastedByteRatio)}`,
  ].join('；');
  rowsElement.replaceChildren();
  for (const row of summary.rows) {
    const cells = [
      row.mirror,
      integerText(row.racesEntered),
      integerText(row.wins),
      ratioText(row.winRate),
      metricText(row.ttfbP50, ' ms'),
      metricText(row.ttfbP90, ' ms'),
      integerText(row.stalled),
      integerText(row.bytesDelivered),
    ];
    const tableRow = rowsElement.ownerDocument.createElement('tr');
    for (const value of cells) {
      const cell = rowsElement.ownerDocument.createElement('td');
      cell.textContent = String(value);
      tableRow.append(cell);
    }
    rowsElement.append(tableRow);
  }
}

async function exportLogs() {
  if (typeof window.showSaveFilePicker !== 'function') {
    throw new Error('当前 Chrome 不支持 File System Access，无法安全导出日志');
  }
  const sessionId = selectedSessionId();
  const handle = await window.showSaveFilePicker({
    suggestedName: `bilibili-development-logs-${Date.now()}.jsonl`,
    types: [{ description: 'JSON Lines', accept: { 'application/jsonl': ['.jsonl'] } }],
  });
  const writer = await handle.createWritable();
  try {
    const snapshot = await send({
      type: 'logs:max-event-id',
      ...(sessionId === undefined ? {} : { sessionId }),
    });
    await writeSessions(send, writer, sessionId, snapshot.maxEventId);
    await writeEvents(send, writer, sessionId, snapshot.maxEventId);
    await writer.close();
    statusElement.textContent = `导出完成，截止 eventId ${snapshot.maxEventId}。新事件仍继续保存。`;
  } catch (error) {
    try {
      await writer.abort();
    } catch (abortError) {
      console.error('[BilibiliBuffer] 日志导出 abort 失败', abortError);
    }
    throw error;
  }
}

// CDN 按钮的禁用有两个来源：范围选不到 session（cdnRangeUnavailable，来自
// logs-view.js 的范围语义）与一次读取在途（cdnReadInFlight）。两处都只经过
// renderCdnAvailability 写按钮，状态行在禁用期间保存（cdnSavedStatus）、
// 恢复启用时还原，读取期间切走范围时读取结果写入保存位而不是状态行。
let cdnReadInFlight = false;
let cdnRangeUnavailable = false;
let cdnSavedStatus = CDN_RANGE_MESSAGES.idle;

function renderCdnAvailability() {
  const unavailable = selectedSessionId() === undefined;
  if (unavailable !== cdnRangeUnavailable) {
    cdnRangeUnavailable = unavailable;
    if (unavailable && !cdnReadInFlight) cdnSavedStatus = cdnStatusElement.textContent;
    const state = cdnPanelState({
      sessionSelected: !unavailable,
      currentSessionAvailable: currentSessionId !== undefined,
      lastStatus: cdnSavedStatus,
    });
    cdnStatusElement.textContent = state.status;
  }
  cdnButton.disabled = cdnReadInFlight || cdnRangeUnavailable;
}

sessionSelect.addEventListener('change', () => {
  renderDetails();
  renderCdnAvailability();
});
exportButton.addEventListener('click', async () => {
  exportButton.disabled = true;
  statusElement.textContent = '正在固定 eventId 并流式导出…';
  try {
    await exportLogs();
  } catch (error) {
    if (error?.name === 'AbortError') {
      statusElement.textContent = '导出已取消，文件没有完成写入。';
    } else {
      statusElement.textContent = `导出失败: ${display(error?.message || error)}`;
    }
    console.error('[BilibiliBuffer] 日志导出失败', error);
  } finally {
    exportButton.disabled = false;
  }
});

cdnButton.addEventListener('click', async () => {
  // 范围选不到 session 时按钮是禁用的，点不到这里；万一走到，worker 的
  // sessionId 校验如实拍错，不再另设提示。
  const sessionId = selectedSessionId();
  cdnReadInFlight = true;
  renderCdnAvailability();
  cdnStatusElement.textContent = '正在读取 bank.fetch.chunk 事件…';
  try {
    const response = await send({ type: 'logs:cdn-summary', sessionId });
    renderCdnPanel(response.summary);
    const doneText = `读取完成，覆盖 ${response.sampleCount} 条事件，截止 eventId ${response.maxEventId}。`;
    if (selectedSessionId() === sessionId) cdnStatusElement.textContent = doneText;
    else cdnSavedStatus = doneText;
  } catch (error) {
    const failureText = `读取失败: ${display(error?.message || error)}`;
    if (selectedSessionId() === sessionId) cdnStatusElement.textContent = failureText;
    else cdnSavedStatus = failureText;
    console.error('[BilibiliBuffer] CDN 面板读取失败', error);
  } finally {
    cdnReadInFlight = false;
    renderCdnAvailability();
  }
});

if (currentSessionId === undefined) {
  sessionSelect.querySelector('option[value="current"]').disabled = true;
} else {
  sessionSelect.value = 'current';
}
renderDetails();
renderCdnAvailability();
