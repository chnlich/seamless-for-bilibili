// 弹窗窗口归属的确定性浏览器检查（headless，全程 fixture 页面，不访问真实 Bilibili）。
// 覆盖的缺陷（0e982f5，2026-09-28 用户实测）：弹窗按 lastFocusedWindow 取标签页时，
// 两个普通窗口下弹窗会显示另一个窗口的页面。本检查让 lastFocusedWindow 固定落在直播
// 所在窗口，而弹窗开在视频页所在窗口，断言弹窗只报告自己窗口的活动标签页。
// 同时覆盖：非 Bilibili 活动标签页、扩展更新后打开弹窗、页面早于扩展安装打开；
// 这三种没有内容脚本可答的情形共享同一句如实提示（弹窗没有 tabs 权限、看不到地址，
// 无法区分三者，提示对三者都成立并给出刷新路径）。第三组覆盖两个开关：默认开启、
// 拨动后的保存提示、关闭并刷新页面后面板如实报开关已关闭（直播不空等数据、视频不
// 谎称申请过缓存目标）、拨回并刷新后面板恢复。第四组覆盖商店自动更新的真实时序：
// 视频页正在拉流时重载同一播放源，旧文档的内容脚本作废，但下载层跑在页面主世界里
// 不受影响——拉流必须续上、库存分片继续命中（网络零新增）、控制台只允许「日志持久化
// 降级」这一类如实错误（扩展上下文作废后写库失败的既有信号，且必须出现以作阳性对照）。
// 第五组覆盖商店用户最常走的路线：先开主页类（无媒体）Bilibili 页面，再点进视频页或
// 直播间，全程开着弹窗看它会不会说错话。断言无媒体页面如实报没有播放中的视频、不谎称
// 申请过缓存目标；弹窗日志入口落在零分片 session 上读取如实完成（NaN 与异常都算谎话）；
// 同一标签页跨路由导航后面板跟随；活动标签页是扩展自身日志页时如实退到合并提示；弹窗
// 控制台带阳性对照，全组零扩展错误才算通过。
// 第六组覆盖日志大库：一个重度用户的 72 小时窗口可装下几十万条记录（实测约 7 MB/小时，
// 窗口上界数百 MB）。按生产记录形状向扩展自己的 IndexedDB 播种 40 个 session 与 20 万条
// 事件（焦点 session 带 1000 组双腿竞速分片），之后全程走生产路径：快照如实读到播种数；
// 无 hash 的日志页按钮禁用且直说入口（与小库一致）；当前 session 点「读取 CDN racing」
// 两行镜像、覆盖率按 1000/1000 如实显示、无 NaN；全部 session 的导出行数恰好等于播种行数、
// writer 正常关闭、状态行如实报截止 eventId。导出与 browser-e2e 同手法把 showSaveFilePicker
// 桩成计数 writer（真实保存对话框要真实用户手势，headless 打不出来）。
//
//   node scripts/popup-window-check.mjs      （Windows；系统 Chrome 由 BILIBILI_E2E_CHROME 指定）
//
// 机制：直接 spawn chrome.exe（回避 Playwright 在浏览器待更新时的丢进程问题），
// 原始 CDP 做 Extensions.loadUnpacked、Fetch 域 fixture 拦截、弹窗 DOM 读取与
// Page.reload；窗口与标签页的编排全部在扩展页（launcher）里走生产版 chrome.windows/
// chrome.tabs API（不新增任何权限：windows/tabs 的创建、聚焦、激活均不受 tabs 权限
// 限制，只有读取地址字段受限）。浏览器只按 spawn 的 PID 结束。

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectToChrome } from './console-capture.mjs';
import { readProvenance } from './provenance.mjs';
import {
  NO_PAGE_MESSAGES, SWITCH_OFF_TEXT, cdnLinesView, liveTakeoverText,
} from '../src/extension/popup-view.js';
import { emptyLiveFacts } from '../src/extension/popup-live.js';
import { CDN_RANGE_MESSAGES } from '../src/diagnostics/logs-view.js';
import { EVENT_INDEX, EVENT_STORE, SESSION_STORE } from '../src/diagnostics/idb.js';
import { STATUS_MESSAGE_VERSION } from '../src/ui/panel.js';
import { VERSION, VOD_CONFIG } from '../src/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const chromeExecutablePath = process.env.BILIBILI_E2E_CHROME?.trim();
if (chromeExecutablePath === undefined || chromeExecutablePath.length === 0) {
  throw new Error('set BILIBILI_E2E_CHROME to the Chrome executable; no silent fallback');
}

const VIDEO_URL = 'https://www.bilibili.com/video/BVwin-check/';
const LIVE_URL = 'https://live.bilibili.com/6-win-check';
const OTHER_URL = 'https://example.com/popup-window-check';
const HOME_URL = 'https://www.bilibili.com/win-check-nomedia';
const UPDATE_VIDEO_URL = 'https://www.bilibili.com/video/BVwin-check-update/';
const UPDATE_SEGMENT_URL = 'https://e2e-video.bilivideo.com/e2e/update-video.m4s?signature=update';
const UPDATE_SEGMENT_TOTAL_SIZE = 4 * 1024 ** 2;
const UPDATE_PULL_SPAN = 64 * 1024;
const UPDATE_FIXTURE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>win-check update</title></head><body>
<video id="media" muted playsinline width="320" height="180"></video>
<script>
  const segmentUrl = ${JSON.stringify(UPDATE_SEGMENT_URL)};
  const totalSize = ${UPDATE_SEGMENT_TOTAL_SIZE};
  const span = ${UPDATE_PULL_SPAN};
  window.__updateFixture = { pulls: 0, errors: [] };
  let cursor = 0;
  async function pullOnce() {
    const start = cursor % totalSize;
    cursor += span;
    try {
      const response = await fetch(segmentUrl, { headers: { Range: 'bytes=' + start + '-' + (start + span - 1) } });
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== span) throw new Error('short read: ' + buffer.byteLength);
      const view = new Uint8Array(buffer);
      for (const probe of [0, span >> 1, span - 1]) {
        if (view[probe] !== (start + probe) % 251) throw new Error('byte mismatch at ' + (start + probe));
      }
      window.__updateFixture.pulls += 1;
    } catch (error) {
      window.__updateFixture.errors.push(String((error && error.message) || error));
    }
  }
  setInterval(pullOnce, 100);
  window.player = { __core() { return { setStableBufferTime() {} }; } };
</script></body></html>`;
const FIXTURE_HTML = (kind) => `<!doctype html><html><head><meta charset="utf-8"><title>win-check ${kind}</title></head><body>${kind === 'video' ? '<video id="v" muted playsinline></video>' : ''}popup-window-check ${kind} fixture</body></html>`;

const scenarios = [];
const markScenario = (name) => {
  scenarios.push(name);
  console.log('SCENARIO', name);
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 只按 spawn 回来的 PID 结束：进程命令行里带着本次自己的 --user-data-dir，
// 与用户日常 Chrome 天然区分；结束时等进程真正退出再删 profile。
async function stopChrome(chrome) {
  if (chrome.exitCode !== null) return;
  chrome.kill();
  const deadline = Date.now() + 15000;
  while (chrome.exitCode === null && Date.now() < deadline) await delay(150);
}

async function rmTree(directory) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      await fs.rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await delay(300);
    }
  }
}

async function spawnChrome(profileDirectory) {
  const chrome = execFile(chromeExecutablePath, [
    '--headless',
    '--mute-audio',
    '--enable-unsafe-extension-debugging',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profileDirectory}`,
    '--remote-debugging-port=0',
  ]);
  chrome.stderr.resume();
  chrome.stdout.resume();
  const portFile = path.join(profileDirectory, 'DevToolsActivePort');
  const deadline = Date.now() + 30000;
  for (;;) {
    let content = null;
    try {
      content = await fs.readFile(portFile, 'utf8');
    } catch (error) {
      content = null;
    }
    if (content !== null) {
      const port = Number(content.split('\n')[0]);
      if (Number.isInteger(port) && port > 0) return { chrome, port };
    }
    if (chrome.exitCode !== null) throw new Error(`Chrome exited before opening DevTools (code ${chrome.exitCode})`);
    if (Date.now() > deadline) throw new Error('Chrome DevToolsActivePort did not appear in time');
    await delay(200);
  }
}

// ---- 原始 CDP 便利封装（flatten 会话） ----

function makeDriver(transport) {
  const driver = {
    eventHandlers: new Map(),
    on(method, handler) {
      if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, new Set());
      this.eventHandlers.get(method).add(handler);
    },
    send(method, params, sessionId) {
      return transport.send(method, params, sessionId);
    },
    async attach(targetId) {
      const { sessionId } = await transport.send('Target.attachToTarget', { targetId, flatten: true });
      await transport.send('Runtime.enable', {}, sessionId);
      return sessionId;
    },
    async evaluate(sessionId, expression) {
      const response = await transport.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      }, sessionId);
      if (response.exceptionDetails !== undefined) {
        throw new Error(`evaluate failed: ${JSON.stringify(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)}`);
      }
      return response.result.value;
    },
    async targets() {
      const { targetInfos } = await transport.send('Target.getTargets');
      return targetInfos;
    },
    async findPageByUrl(urlPrefix) {
      const candidates = (await this.targets())
        .filter((info) => info.type === 'page' && info.url.startsWith(urlPrefix));
      if (candidates.length !== 1) {
        throw new Error(`expected exactly one page target for ${urlPrefix}, got ${candidates.length}`);
      }
      return candidates[0];
    },
  };
  transport.onMessage((message) => {
    const handlers = driver.eventHandlers.get(message.method);
    if (handlers !== undefined) for (const handler of [...handlers]) handler(message);
  });
  return driver;
}

const FIXTURE_CORS_HEADERS = [
  { name: 'Access-Control-Allow-Origin', value: '*' },
  { name: 'Access-Control-Allow-Headers', value: 'Range, Content-Type' },
  { name: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' },
  { name: 'Access-Control-Expose-Headers', value: 'Content-Range, Content-Length' },
];

async function installFixtureInterception(driver) {
  const stats = { updateSegmentGets: 0 };
  const keyFor = (url) => {
    if (url.startsWith(VIDEO_URL)) return 'video';
    if (url.startsWith(LIVE_URL)) return 'live';
    if (url.startsWith(OTHER_URL)) return 'other';
    if (url.startsWith(HOME_URL)) return 'nomedia';
    if (url.startsWith(UPDATE_VIDEO_URL)) return 'update';
    if (url.startsWith(UPDATE_SEGMENT_URL)) return 'segment';
    return undefined;
  };
  await driver.send('Fetch.enable', {
    patterns: [
      { urlPattern: `${VIDEO_URL}*`, requestStage: 'Request' },
      { urlPattern: `${LIVE_URL}*`, requestStage: 'Request' },
      { urlPattern: `${OTHER_URL}*`, requestStage: 'Request' },
      { urlPattern: `${HOME_URL}*`, requestStage: 'Request' },
      { urlPattern: `${UPDATE_VIDEO_URL}*`, requestStage: 'Request' },
      { urlPattern: `${UPDATE_SEGMENT_URL}*`, requestStage: 'Request' },
    ],
  });
  driver.on('Fetch.requestPaused', (event) => {
    const params = event.params;
    const kind = keyFor(params.request.url);
    assert.ok(kind !== undefined, `fixture interception saw an unmatched URL: ${params.request.url}`);
    if (kind === 'segment') {
      if (params.request.method === 'OPTIONS') {
        void driver.send('Fetch.fulfillRequest', {
          requestId: params.requestId, responseCode: 204, responseHeaders: FIXTURE_CORS_HEADERS,
        }, event.sessionId);
        return;
      }
      const rangeHeader = (params.request.headers.Range ?? params.request.headers.range ?? '');
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
      assert.ok(match !== null, `update segment request has no closed range: ${params.request.url}`);
      stats.updateSegmentGets += 1;
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), UPDATE_SEGMENT_TOTAL_SIZE - 1);
      const body = Buffer.alloc(end - start + 1);
      for (let index = 0; index < body.length; index += 1) body[index] = (start + index) % 251;
      void driver.send('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 206,
        responseHeaders: [
          ...FIXTURE_CORS_HEADERS,
          { name: 'Content-Type', value: 'video/mp4' },
          { name: 'Content-Length', value: String(body.length) },
          { name: 'Content-Range', value: `bytes ${start}-${end}/${UPDATE_SEGMENT_TOTAL_SIZE}` },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: body.toString('base64'),
      }, event.sessionId);
      return;
    }
    void driver.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: Buffer.from(kind === 'update' ? UPDATE_FIXTURE_HTML : FIXTURE_HTML(kind), 'utf8').toString('base64'),
    }, event.sessionId);
  });
  return stats;
}

async function findInitialPage(driver) {
  const deadline = Date.now() + 15000;
  for (;;) {
    const page = (await driver.targets()).find((info) => info.type === 'page');
    if (page !== undefined) return page;
    if (Date.now() > deadline) throw new Error('no initial page target appeared');
    await delay(200);
  }
}

async function waitForState(read, predicate, { timeoutMs = 20000, intervalMs = 250, what = 'popup state' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastState;
  for (;;) {
    lastState = await read();
    const verdict = predicate(lastState);
    if (verdict === true) return lastState;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last state: ${JSON.stringify(lastState)} (${verdict})`);
    }
    await delay(intervalMs);
  }
}

// 弹窗 DOM 与窗口归属的探针（在弹窗目标里 evaluate；归属判定走生产版 chrome API）。
const POPUP_STATE_EXPRESSION = `(async () => {
  const ownWindow = await chrome.windows.getCurrent();
  const ownActive = await chrome.tabs.query({ active: true, windowId: ownWindow.id });
  const lastFocused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const q = (selector) => document.querySelector(selector);
  return {
    ownWindowId: ownWindow.id,
    ownActiveTabIds: ownActive.map((tab) => tab.id),
    lastFocusedTabIds: lastFocused.map((tab) => tab.id),
    switches: document.querySelectorAll('input[data-preference]').length,
    switchStates: Object.fromEntries([...document.querySelectorAll('input[data-preference]')].map((input) => [input.dataset.preference, input.checked])),
    ready: document.body.dataset.ready ?? null,
    noPage: q('main').classList.contains('no-page'),
    notice: q('[data-notice]').textContent,
    livePanelHidden: q('[data-live-panel]').hidden,
    bufferCardHidden: q('[aria-label="缓冲"]').hidden,
    takeover: q('[data-live-takeover]').textContent,
    stateLineHidden: q('[data-status-field="state"]').hidden,
    targetLabel: q('[data-buffer-target-label]').textContent,
    targetValue: q('[data-target-value]').textContent,
    bufferSeconds: q('[data-buffer-seconds]').textContent,
    bufferGoal: q('[data-buffer-goal]').textContent,
    bufferNoteHidden: q('[data-buffer-note]').hidden,
    bufferNote: q('[data-buffer-note]').textContent,
    cdnCard: q('[data-cdn-lines]').textContent,
  };
})()`;

async function reloadPageByUrl(driver, url) {
  const target = await driver.findPageByUrl(url);
  const sessionId = await driver.attach(target.targetId);
  await driver.send('Page.enable', {}, sessionId);
  await driver.send('Page.reload', {}, sessionId);
}

async function popupStateReader(driver, popupUrl) {
  const target = await driver.findPageByUrl(popupUrl);
  const sessionId = await driver.attach(target.targetId);
  return () => driver.evaluate(sessionId, POPUP_STATE_EXPRESSION);
}

// launcher（logs.html 扩展页）：所有 chrome.windows/tabs 编排的生产 API 入口。
async function openLauncher(driver, extensionId) {
  const { targetId } = await driver.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/logs.html`,
  });
  return driver.attach(targetId);
}

async function setupBrowser(profileTag) {
  const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), profileTag));
  const { chrome, port } = await spawnChrome(profileDirectory);
  const transport = await connectToChrome(port);
  const driver = makeDriver(transport);
  const fixtures = await installFixtureInterception(driver);
  const cleanup = async () => {
    await transport.close();
    await stopChrome(chrome);
    await rmTree(profileDirectory);
  };
  return { driver, cleanup, fixtures };
}

async function runMultiWindowPack() {
  const { driver, cleanup } = await setupBrowser('popup-window-check-a-');
  try {
    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const launcher = await openLauncher(driver, extensionId);

    // 编排：窗口 B 视频页、窗口 A 直播页（focused）、弹窗作为窗口 B 的后台标签页，
    // 再把窗口 A 拉回焦点。readouts 应答作对账（视频页=video、直播页=live）。
    const world = await driver.evaluate(launcher, `(async () => {
      const videoTab = await chrome.tabs.create({ url: ${JSON.stringify(VIDEO_URL)}, active: true });
      const liveWindow = await chrome.windows.create({ url: ${JSON.stringify(LIVE_URL)}, focused: true });
      const liveTab = liveWindow.tabs[0];
      const popupTab = await chrome.tabs.create({ url: ${JSON.stringify(popupUrl)}, windowId: videoTab.windowId, active: false });
      await chrome.tabs.update(videoTab.id, { active: true });
      await chrome.windows.update(liveWindow.id, { focused: true });
      const readout = async (tabId) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            const response = await chrome.tabs.sendMessage(tabId, { version: ${STATUS_MESSAGE_VERSION}, type: 'readouts:get' });
            return response.routeKind ?? null;
          } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        throw new Error(\`content script never answered readouts for tab \${tabId}\`);
      };
      const videoKind = await readout(videoTab.id);
      const liveKind = await readout(liveTab.id);
      return {
        videoTabId: videoTab.id,
        liveTabId: liveTab.id,
        popupTabId: popupTab.id,
        videoWindowId: videoTab.windowId,
        liveWindowId: liveWindow.id,
        videoKind,
        liveKind,
      };
    })()`);
    console.log('window world:', JSON.stringify(world));
    assert.equal(world.videoKind, 'video');
    assert.equal(world.liveKind, 'live');
    assert.notEqual(world.videoWindowId, world.liveWindowId, '检查需要两个真实窗口');

    const readState = await popupStateReader(driver, popupUrl);

    // 前置条件收口：弹窗在窗口 B（活动标签页=视频页），lastFocusedWindow=A（直播）。
    const precondition = await waitForState(
      readState,
      (state) => state.ownWindowId === world.videoWindowId
        && state.ownActiveTabIds.length === 1
        && state.ownActiveTabIds[0] === world.videoTabId
        && state.lastFocusedTabIds.length === 1
        && state.lastFocusedTabIds[0] === world.liveTabId
        ? true
        : 'focus precondition unmet',
      { what: 'multi-window focus precondition' },
    );
    console.log('multi-window precondition:', JSON.stringify(precondition));

    const shown = await waitForState(
      readState,
      (state) => state.ready === 'true' && state.switches === 2 ? true : 'panel not ready',
      { what: 'popup showing the video tab of its own window' },
    );
    assert.equal(shown.notice, '', JSON.stringify(shown));
    assert.equal(shown.noPage, false, JSON.stringify(shown));
    assert.equal(shown.livePanelHidden, true, `popup 不得把 lastFocused 窗口的直播事实显示进来 ${JSON.stringify(shown)}`);
    assert.equal(shown.bufferCardHidden, false, JSON.stringify(shown));
    markScenario('两个窗口：弹窗只报告自己窗口的活动标签页，不理会 lastFocused 窗口的直播页');

    // 非 Bilibili 标签页成为窗口 B 的活动页：统一的未运行提示。
    const otherTabId = await driver.evaluate(launcher, `(async () => {
      const tab = await chrome.tabs.create({ url: ${JSON.stringify(OTHER_URL)}, windowId: ${world.videoWindowId}, active: true });
      return tab.id;
    })()`);
    const otherShown = await waitForState(
      readState,
      (state) => state.noPage === true && state.notice === NO_PAGE_MESSAGES.noReceiver
        ? true
        : 'expected the truthful merged not-running message',
      { what: 'popup on a non-Bilibili active tab' },
    );
    assert.equal(otherShown.livePanelHidden, true, JSON.stringify(otherShown));
    markScenario('非 Bilibili 活动标签页：如实提示未运行，不给别的窗口的运行事实');

    // 切回视频页，面板恢复。
    await driver.evaluate(launcher, `(async () => {
      await chrome.tabs.remove(${otherTabId});
      await chrome.tabs.update(${world.videoTabId}, { active: true });
      await chrome.windows.update(${world.liveWindowId}, { focused: true });
    })()`);
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.notice === '',
      { what: 'popup recovery after returning to the video tab' },
    );
    markScenario('活动标签页切回视频页：面板恢复');

    // 扩展更新（重载同一播放源）：旧文档的内容脚本作废（launcher 与旧弹窗同属旧
    // 上下文，先关掉并弃用），新弹窗如实提示；刷新页面后增强恢复。
    await driver.evaluate(launcher, `chrome.tabs.remove(${world.popupTabId})`);
    const { id: reloadedId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    assert.equal(reloadedId, extensionId, '同一播放源重载后扩展 id 不变');
    await delay(1000);
    const launcherAfter = await openLauncher(driver, extensionId);
    const popupAfterTabId = await driver.evaluate(launcherAfter, `(async () => {
      const tab = await chrome.tabs.create({ url: ${JSON.stringify(popupUrl)}, windowId: ${world.videoWindowId}, active: false });
      await chrome.tabs.update(${world.videoTabId}, { active: true });
      await chrome.windows.update(${world.liveWindowId}, { focused: true });
      return tab.id;
    })()`);
    void popupAfterTabId;
    const readAfterUpdate = await popupStateReader(driver, popupUrl);
    const updateShown = await waitForState(
      readAfterUpdate,
      (state) => state.noPage === true && state.notice === NO_PAGE_MESSAGES.noReceiver
        ? true
        : 'expected the truthful merged message after extension update',
      { what: 'popup after extension update with the tab left open' },
    );
    assert.equal(updateShown.livePanelHidden, true, JSON.stringify(updateShown));
    markScenario('扩展更新后旧页面无脚本可答：如实提示并给出刷新路径，不谎报不受支持');

    const videoTarget = await driver.findPageByUrl(VIDEO_URL);
    const videoSession = await driver.attach(videoTarget.targetId);
    await driver.send('Page.enable', {}, videoSession);
    await driver.send('Page.reload', {}, videoSession);
    await waitForState(
      readAfterUpdate,
      (state) => state.ready === 'true' && state.notice === '' && state.livePanelHidden === true,
      { what: 'popup recovery after reloading the video tab' },
    );
    markScenario('刷新页面后：增强恢复，弹窗恢复显示');
  } finally {
    await cleanup();
  }
}

async function runPreExistingPagePack() {
  const { driver, cleanup } = await setupBrowser('popup-window-check-b-');
  try {
    // 关键顺序：先有 Bilibili 页面，后装扩展（对应商店用户刚装好扩展时的真实状态）。
    const initialPage = await findInitialPage(driver);
    const initialSession = await driver.attach(initialPage.targetId);
    await driver.send('Page.enable', {}, initialSession);
    await driver.send('Page.navigate', { url: VIDEO_URL }, initialSession);
    await delay(1500);

    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const launcher = await openLauncher(driver, extensionId);
    const world = await driver.evaluate(launcher, `(async () => {
      const me = await chrome.tabs.getCurrent();
      const window = await chrome.windows.get(me.windowId, { populate: true });
      const videoTab = window.tabs.find((tab) => tab.id !== me.id);
      if (videoTab === undefined) throw new Error('video tab not found in the initial window');
      const popupTab = await chrome.tabs.create({ url: ${JSON.stringify(popupUrl)}, windowId: me.windowId, active: false });
      await chrome.tabs.update(videoTab.id, { active: true });
      return { videoTabId: videoTab.id, popupTabId: popupTab.id, windowId: me.windowId };
    })()`);
    console.log('pre-existing world:', JSON.stringify(world));
    const readState = await popupStateReader(driver, popupUrl);
    const shown = await waitForState(
      readState,
      (state) => state.noPage === true && state.notice === NO_PAGE_MESSAGES.noReceiver
        ? true
        : 'expected the truthful merged message on a pre-existing page',
      { what: 'popup on a page opened before install' },
    );
    assert.equal(shown.livePanelHidden, true, JSON.stringify(shown));
    markScenario('页面早于扩展安装打开：如实提示并给出刷新路径，不谎报成不受支持的页面');

    const videoTarget = await driver.findPageByUrl(VIDEO_URL);
    const videoSession = await driver.attach(videoTarget.targetId);
    await driver.send('Page.enable', {}, videoSession);
    await driver.send('Page.reload', {}, videoSession);
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.notice === '' && state.bufferCardHidden === false,
      { what: 'popup recovery after the pre-existing page reloads' },
    );
    markScenario('刷新后：内容脚本进入，弹窗恢复正常显示');
  } finally {
    await cleanup();
  }
}

// 第三组：两个开关的用户场景（全新 profile = 首次安装状态）。同一窗口里视频页、
// 直播页与后台弹窗并存，切活动标签页改变弹窗的报告对象；开关在弹窗 DOM 上点击，
// 与真实用户同一入口，之后走 CDP 刷新页面（开关改动在刷新后生效）。
async function runSwitchPack() {
  const { driver, cleanup } = await setupBrowser('popup-window-check-b-');
  try {
    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const launcher = await openLauncher(driver, extensionId);
    const world = await driver.evaluate(launcher, `(async () => {
      const me = await chrome.tabs.getCurrent();
      const videoTab = await chrome.tabs.create({ url: ${JSON.stringify(VIDEO_URL)}, windowId: me.windowId, active: false });
      const liveTab = await chrome.tabs.create({ url: ${JSON.stringify(LIVE_URL)}, windowId: me.windowId, active: false });
      const popupTab = await chrome.tabs.create({ url: ${JSON.stringify(popupUrl)}, windowId: me.windowId, active: false });
      await chrome.tabs.update(videoTab.id, { active: true });
      const readout = async (tabId) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            const response = await chrome.tabs.sendMessage(tabId, { version: ${STATUS_MESSAGE_VERSION}, type: 'readouts:get' });
            return response.routeKind ?? null;
          } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        throw new Error(\`content script never answered readouts for tab \${tabId}\`);
      };
      const videoKind = await readout(videoTab.id);
      const liveKind = await readout(liveTab.id);
      return { windowId: me.windowId, videoTabId: videoTab.id, liveTabId: liveTab.id, popupTabId: popupTab.id, videoKind, liveKind };
    })()`);
    assert.equal(world.videoKind, 'video', JSON.stringify(world));
    assert.equal(world.liveKind, 'live', JSON.stringify(world));
    console.log('switch world:', JSON.stringify(world));

    const readState = await popupStateReader(driver, popupUrl);
    const popupTarget = await driver.findPageByUrl(popupUrl);
    const popupSession = await driver.attach(popupTarget.targetId);
    const flipSwitch = async (name) => {
      await driver.evaluate(popupSession, `document.querySelector('input[data-preference="${name}"]').click()`);
    };
    const activate = async (tabId) => {
      await driver.evaluate(launcher, `chrome.tabs.update(${tabId}, { active: true })`);
    };

    const readyVideo = await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.bufferCardHidden === false,
      { what: 'popup on the video fixture after first install' },
    );
    assert.deepEqual(readyVideo.switchStates, { vodEnabled: true, liveEnabled: true });
    markScenario('首次安装：两个开关默认开启，面板正常显示');

    await flipSwitch('liveEnabled');
    await waitForState(
      readState,
      (state) => state.switchStates.liveEnabled === false && state.notice === NO_PAGE_MESSAGES.preferenceSaved,
      { what: 'live switch toggle acknowledgement' },
    );
    // 确认必须留足可读时间：跨越几个 500 ms 轮询周期仍然在场，不被轮询随手清掉。
    await delay(1600);
    const heldNotice = await readState();
    assert.equal(heldNotice.notice, NO_PAGE_MESSAGES.preferenceSaved, JSON.stringify(heldNotice));
    markScenario('拨动直播开关：保存确认停留可读，并提示刷新后生效');

    await reloadPageByUrl(driver, LIVE_URL);
    await activate(world.liveTabId);
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.livePanelHidden === false && state.takeover === SWITCH_OFF_TEXT.liveOff
        ? true
        : 'expected the takeover line to state the off switch instead of waiting for data',
      { what: 'live takeover line with the live switch off' },
    );
    markScenario('关闭直播增强并刷新页面后：接管行直说开关已关闭，不再空报等待直播数据');

    await flipSwitch('vodEnabled');
    await waitForState(
      readState,
      (state) => state.switchStates.vodEnabled === false && state.notice === NO_PAGE_MESSAGES.preferenceSaved,
      { what: 'video switch toggle acknowledgement' },
    );
    markScenario('拨动视频开关：保存成功并提示刷新后生效');

    await reloadPageByUrl(driver, VIDEO_URL);
    await activate(world.videoTabId);
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.bufferCardHidden === false
        && state.stateLineHidden === false
        && state.targetLabel === SWITCH_OFF_TEXT.videoLabel
        && state.targetValue === SWITCH_OFF_TEXT.videoOffValue
        && state.bufferGoal === ''
        ? true
        : 'expected the switch-off state line without a claimed buffer target',
      { what: 'video panel with the video switch off' },
    );
    markScenario('关闭视频增强并刷新页面后：状态行只报开关已关闭，不再谎称已申请缓存目标');

    await flipSwitch('liveEnabled');
    await flipSwitch('vodEnabled');
    await reloadPageByUrl(driver, VIDEO_URL);
    await activate(world.videoTabId);
    const goalText = `/ 目标 ${VOD_CONFIG.stableBufferSeconds} 秒`;
    const requestLabel = `已向播放器申请 ${VOD_CONFIG.stableBufferSeconds} 秒缓存`;
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.bufferCardHidden === false
        && state.targetLabel === requestLabel
        && state.bufferGoal === goalText
        ? true
        : 'expected the request label and goal to come back',
      { what: 'video panel after switching back on' },
    );
    await reloadPageByUrl(driver, LIVE_URL);
    await activate(world.liveTabId);
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.livePanelHidden === false && state.takeover === '等待直播数据'
        ? true
        : 'expected the takeover line back to waiting for live data',
      { what: 'live takeover line after switching back on' },
    );
    markScenario('两个开关拨回开启并刷新页面后：面板恢复申请措辞与等待直播数据');

    // 日志页打开时没有任何读取在进行，初始状态行不得谎称「正在读取」。
    const launcherStatus = await driver.evaluate(launcher, `document.querySelector('[data-status]').textContent`);
    assert.equal(launcherStatus.includes('正在读取'), false, JSON.stringify({ launcherStatus }));
    markScenario('日志页初始状态行如实，不谎称正在读取');

    // 直接打开的日志页（launcher 无 #sessionId）选不出任何 session：CDN 按钮
    // 必须禁用并直说弹窗入口，不许报「请选择一个 session」这种页面上无项可选的
    // 死路（先按裸 DOM 断言再对文案：未修复的旧构建在第一条裸断言上就已失败）。
    const cdnNoSession = await driver.evaluate(launcher, `({
      buttonDisabled: document.querySelector('[data-cdn-refresh]').disabled,
      currentOptionDisabled: document.querySelector('[data-session-filter] option[value="current"]').disabled,
      status: document.querySelector('[data-cdn-status]').textContent,
      exportDisabled: document.querySelector('[data-export]').disabled,
    })`);
    assert.equal(cdnNoSession.currentOptionDisabled, true, JSON.stringify(cdnNoSession));
    assert.equal(cdnNoSession.buttonDisabled, true, JSON.stringify(cdnNoSession));
    assert.equal(cdnNoSession.exportDisabled, false, JSON.stringify(cdnNoSession));
    const { CDN_RANGE_MESSAGES } = await import('../src/diagnostics/logs-view.js');
    assert.equal(cdnNoSession.status, CDN_RANGE_MESSAGES.noSessionEntry, JSON.stringify(cdnNoSession));
    markScenario('日志页没有可选 session 时：CDN 按钮禁用并直说弹窗入口，不给死路');

    // 商店用户的真实路径：弹窗底部「打开开发日志」带当前 session 进日志页，
    // CDN 面板立即可读、读取完成；范围切到 全部 session 再切回时，按钮与
    // 状态行跟着范围走，不残留谎话。
    await driver.evaluate(popupSession, `document.querySelector('[data-open-logs]').click()`);
    const logsPrefix = `chrome-extension://${extensionId}/logs.html#sessionId=`;
    const foundLogs = await waitForState(
      () => driver.targets(),
      (targets) => targets.filter((info) => info.type === 'page' && info.url.startsWith(logsPrefix)).length === 1,
      { what: 'logs page opened from the popup footer with the current session' },
    );
    const logsTarget = foundLogs.find((info) => info.type === 'page' && info.url.startsWith(logsPrefix));
    console.log('popup-opened logs page:', logsTarget.url);
    const logsSession = await driver.attach(logsTarget.targetId);
    const readCdnPanel = () => driver.evaluate(logsSession, `({
      filterValue: document.querySelector('[data-session-filter]').value,
      buttonDisabled: document.querySelector('[data-cdn-refresh]').disabled,
      status: document.querySelector('[data-cdn-status]').textContent,
    })`);
    const fragmentState = await waitForState(
      readCdnPanel,
      (state) => state.filterValue === 'current' && state.buttonDisabled === false
        && state.status === CDN_RANGE_MESSAGES.idle,
      { what: 'CDN panel ready on the popup-opened logs page' },
    );
    assert.equal(fragmentState.filterValue, 'current', JSON.stringify(fragmentState));
    await driver.evaluate(logsSession, `document.querySelector('[data-cdn-refresh]').click()`);
    await waitForState(
      readCdnPanel,
      (state) => state.buttonDisabled === false && state.status.startsWith('读取完成')
        ? true
        : `unexpected CDN status ${JSON.stringify(state)}`,
      { what: 'CDN read completes for the popup-opened session' },
    );
    markScenario('弹窗进日志页带上当前 session：CDN 面板立即可读并读取完成');

    await driver.evaluate(logsSession, `(() => {
      const select = document.querySelector('[data-session-filter]');
      select.value = '';
      select.dispatchEvent(new Event('change'));
    })()`);
    const allRangeState = await readCdnPanel();
    assert.equal(allRangeState.buttonDisabled, true, JSON.stringify(allRangeState));
    assert.equal(allRangeState.status, CDN_RANGE_MESSAGES.pickCurrent, JSON.stringify(allRangeState));
    await driver.evaluate(logsSession, `(() => {
      const select = document.querySelector('[data-session-filter]');
      select.value = 'current';
      select.dispatchEvent(new Event('change'));
    })()`);
    const restoredState = await readCdnPanel();
    assert.equal(restoredState.buttonDisabled, false, JSON.stringify(restoredState));
    assert.equal(restoredState.status.startsWith('读取完成'), true, JSON.stringify(restoredState));
    markScenario('范围切到 全部 session：CDN 按钮禁用并指向 当前 session，切回即恢复');
  } finally {
    await cleanup();
  }
}

// 第四组：商店自动更新的真实时序——视频页拉流正酣时重载同一播放源。
// 重载作废旧文档的内容脚本（隔离世界），但下载层跑在页面主世界、不依赖扩展上下文，
// 所以接管与库存继续工作：拉流续上、已入库分片继续命中（段地址零新增网络请求）。
// 如实输掉的是日志持久化：旧上下文写库必败，只许出现「diagnostic persistence degraded」
// 这一类错误（全量报告是既有口径，且它必须出现以作控制台捕获的阳性对照）。
async function runUpdateMidPlaybackPack() {
  const { driver, cleanup, fixtures } = await setupBrowser('popup-window-check-c-');
  try {
    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const launcher = await openLauncher(driver, extensionId);
    const videoTabId = await driver.evaluate(launcher, `(async () => {
      const tab = await chrome.tabs.create({ url: ${JSON.stringify(UPDATE_VIDEO_URL)}, active: true });
      return tab.id;
    })()`);
    const videoTarget = await driver.findPageByUrl(UPDATE_VIDEO_URL);
    const videoSession = await driver.attach(videoTarget.targetId);

    const consoleErrors = [];
    driver.on('Runtime.consoleAPICalled', (message) => {
      if (message.sessionId !== videoSession || message.params.type !== 'error') return;
      const text = (message.params.args || [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      consoleErrors.push({ kind: 'console', text });
    });
    driver.on('Runtime.exceptionThrown', (message) => {
      if (message.sessionId !== videoSession) return;
      const details = message.params.exceptionDetails ?? {};
      consoleErrors.push({ kind: 'exception', text: details.exception?.description ?? details.text ?? '' });
    });

    // 拉流稳定、预取覆盖全部 4 个分片（之后每次拉取都应命中内存），并确认接管已生效。
    await waitForState(
      () => driver.evaluate(videoSession, `window.__updateFixture === undefined ? null : JSON.parse(JSON.stringify(window.__updateFixture))`),
      (state) => state !== null && state.errors.length === 0 && state.pulls >= 10
        ? true
        : 'waiting for steady segment pulls',
      { what: 'fixture pulling segments before the update' },
    );
    await waitForState(
      () => Promise.resolve(fixtures.updateSegmentGets),
      (count) => count >= UPDATE_SEGMENT_TOTAL_SIZE / (1024 ** 2)
        ? true
        : 'waiting for prefetch to cover every chunk',
      { what: 'prefetch covering the whole stream' },
    );
    const serveCount = await waitForState(
      () => driver.evaluate(launcher, `(async () => {
      const send = (message) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError !== undefined) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        });
      });
      const snapshot = await send({ version: 1, type: 'logs:max-event-id' });
      if (snapshot?.ok !== true) throw new Error('log snapshot was rejected');
      let afterEventId = 0;
      let count = 0;
      for (;;) {
        const page = await send({ version: 1, type: 'logs:events-page', limit: 250, afterEventId, maxEventId: snapshot.maxEventId });
        if (page?.ok !== true) throw new Error('log event page was rejected');
        for (const event of page.events) if (event.code === 'bank.serve') count += 1;
        if (!page.hasMore) return count;
        afterEventId = page.nextAfterEventId;
      }
    })()`),
      (count) => count > 0 ? true : 'no bank.serve event persisted yet',
      { what: 'takeover serving segments before the update' },
    );

    // 更新：重载同一播放源（扩展 id 不变）。旧 launcher 同属旧上下文，弃用并开新 launcher；
    // 旧视频页的内容脚本必须死掉，否则本组什么也证明不了。
    const { id: reloadedId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    assert.equal(reloadedId, extensionId, '同一播放源重载后扩展 id 不变');
    const launcherAfter = await openLauncher(driver, extensionId);
    await waitForState(
      () => driver.evaluate(launcherAfter, `chrome.tabs.sendMessage(
        ${videoTabId},
        { version: ${STATUS_MESSAGE_VERSION}, type: 'readouts:get' },
      ).then(() => 'alive', () => 'dead')`),
      (value) => value === 'dead' ? true : 'old content script still answering',
      { what: 'old content script orphaned by the update' },
    );
    // 新开的 launcher 抢走了活动标签位：后台标签页的 setInterval 被 Chrome 压到
    // 约 1 Hz，fixture 的拉流节奏会因此失真（实测 15 秒只剩 15 次）。把视频页激活
    // 回来，让定时器恢复，观察窗量到的才是扩展自己的速度。
    const activated = await driver.evaluate(launcherAfter, `chrome.tabs.update(${videoTabId}, { active: true }).then(() => true)`);
    assert.equal(activated, true, '视频页重新激活失败');

    // 观察窗：播放（分片拉取）必须续上，库存命中使段地址网络计数停在原值，
    // 控制台只许持久化降级这一类如实错误。
    const pullsBefore = await driver.evaluate(videoSession, `window.__updateFixture.pulls`);
    const getsBefore = fixtures.updateSegmentGets;
    await delay(15000);
    const post = await driver.evaluate(videoSession, `window.__updateFixture === undefined ? null : JSON.parse(JSON.stringify(window.__updateFixture))`);
    assert.deepEqual(post.errors, [], `更新后拉流出错 ${JSON.stringify(post.errors)}`);
    const pullsAfter = post.pulls - pullsBefore;
    assert.ok(pullsAfter >= 20, `更新后播放没有续上：15 秒只前进了 ${pullsAfter} 次拉取`);
    assert.equal(
      fixtures.updateSegmentGets,
      getsBefore,
      '更新后段地址出现新的网络请求：库存没有继续命中，下载层疑似随上下文一起死掉',
    );
    const persistenceErrorCount = consoleErrors
      .filter((entry) => entry.text.includes('diagnostic persistence degraded')).length;
    const unexpected = consoleErrors
      .filter((entry) => !entry.text.includes('diagnostic persistence degraded'));
    assert.deepEqual(unexpected, [], `更新后出现预期之外的扩展错误 ${JSON.stringify(unexpected)}`);
    assert.ok(
      persistenceErrorCount > 0,
      '更新后没有任何持久化降级错误：日志写库失败的如实信号缺席，控制台捕获通道存疑',
    );
    markScenario('扩展更新时视频页正在拉流：拉流续上、库存继续命中，控制台只如实报日志持久化降级');
  } finally {
    await cleanup();
  }
}

// 第五组：无媒体 Bilibili 页面与随导航变化的面板（见文件头说明）。
// 期望值一律从 src 的既有导出推导（cdnLinesView 的空态、liveTakeoverText 的事实折叠、
// NO_PAGE_MESSAGES 的合并提示）：本组检查的是浏览器里装配出来的面板，不是文案字面。
async function runNoMediaPagePack() {
  const { driver, cleanup } = await setupBrowser('popup-window-check-d-');
  try {
    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const logsPagePrefix = `chrome-extension://${extensionId}/logs.html`;
    const launcher = await openLauncher(driver, extensionId);
    const world = await driver.evaluate(launcher, `(async () => {
      const homeTab = await chrome.tabs.create({ url: ${JSON.stringify(HOME_URL)}, active: true });
      const popupTab = await chrome.tabs.create({ url: ${JSON.stringify(popupUrl)}, active: false });
      await chrome.tabs.update(homeTab.id, { active: true });
      const readout = async (tabId) => {
        for (let attempt = 0; attempt < 60; attempt += 1) {
          try {
            const response = await chrome.tabs.sendMessage(tabId, { version: ${STATUS_MESSAGE_VERSION}, type: 'readouts:get' });
            return response.routeKind ?? null;
          } catch (error) {
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        throw new Error(\`content script never answered readouts for tab \${tabId}\`);
      };
      const homeKind = await readout(homeTab.id);
      return { windowId: homeTab.windowId, homeTabId: homeTab.id, popupTabId: popupTab.id, homeKind };
    })()`);
    console.log('no-media world:', JSON.stringify(world));
    assert.equal(world.homeKind, 'other', JSON.stringify(world));

    const readState = await popupStateReader(driver, popupUrl);
    const popupTarget = await driver.findPageByUrl(popupUrl);
    const popupSession = await driver.attach(popupTarget.targetId);
    const consoleErrors = [];
    driver.on('Runtime.consoleAPICalled', (message) => {
      if (message.sessionId !== popupSession || message.params.type !== 'error') return;
      const text = (message.params.args || [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      consoleErrors.push({ kind: 'console', text });
    });
    driver.on('Runtime.exceptionThrown', (message) => {
      if (message.sessionId !== popupSession) return;
      const details = message.params.exceptionDetails ?? {};
      consoleErrors.push({ kind: 'exception', text: details.exception?.description ?? details.text ?? '' });
    });

    const cdnEmptyMessage = cdnLinesView(undefined, undefined, false).message;
    const liveWaitingText = liveTakeoverText(emptyLiveFacts(), { liveEnabled: true });

    // 主页类（无媒体）页面：缓冲如实报没有播放中的视频，申请状态行整体收起，
    // 线路如实报还没有数据，直播卡片不出现，提示句为空。
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.bufferCardHidden === false
        && state.bufferNoteHidden === false && state.bufferNote.length > 0
        && state.bufferSeconds === '—' && state.bufferGoal === ''
        && state.stateLineHidden === true && state.targetValue === ''
        && state.livePanelHidden === true
        && state.cdnCard === cdnEmptyMessage
        ? true
        : 'expected the honest no-media page state',
      { what: 'popup on a Bilibili page with no playing media' },
    );
    markScenario('无媒体 Bilibili 页面：缓冲如实报没有播放中的视频、不谎称已申请缓存，线路如实报还没有数据');

    // 弹窗日志入口落在零分片 session：读取如实完成，覆盖率按 0/0 如实显示，不出现 NaN。
    await driver.evaluate(popupSession, `document.querySelector('[data-open-logs]').click()`);
    const [fragmentLogsTarget] = await waitForState(
      async () => (await driver.targets())
        .filter((info) => info.type === 'page' && info.url.startsWith(`${logsPagePrefix}#sessionId=`)),
      (candidates) => candidates.length === 1 ? true : `expected 1 popup-opened logs page, got ${candidates.length}`,
      { what: 'popup-opened logs page for the no-media session' },
    );
    const logsSession = await driver.attach(fragmentLogsTarget.targetId);
    const readCdnPanel = () => driver.evaluate(logsSession, `({
      filterValue: document.querySelector('[data-session-filter]').value,
      buttonDisabled: document.querySelector('[data-cdn-refresh]').disabled,
      status: document.querySelector('[data-cdn-status]').textContent,
      summary: document.querySelector('[data-cdn-summary]').textContent,
    })`);
    await waitForState(
      readCdnPanel,
      (state) => state.filterValue === 'current' && state.buttonDisabled === false
        ? true
        : `unexpected CDN panel state ${JSON.stringify(state)}`,
      { what: 'CDN panel ready on the zero-chunk session' },
    );
    await driver.evaluate(logsSession, `document.querySelector('[data-cdn-refresh]').click()`);
    const zeroChunkRead = await waitForState(
      readCdnPanel,
      (state) => state.status.startsWith('读取完成')
        ? true
        : `unexpected CDN status ${JSON.stringify(state)}`,
      { what: 'CDN read on a session with zero chunk events' },
    );
    assert.equal(zeroChunkRead.status.includes('覆盖 0 条事件'), true, JSON.stringify(zeroChunkRead));
    assert.equal(zeroChunkRead.summary.includes('配对覆盖率 0/0'), true, JSON.stringify(zeroChunkRead));
    assert.equal(zeroChunkRead.summary.includes('NaN'), false, JSON.stringify(zeroChunkRead));
    markScenario('弹窗日志入口落在零分片 session：CDN 读取如实完成，覆盖率按 0/0 显示、无 NaN');

    // 关掉弹出的日志页，活动标签页回到无媒体页。
    await driver.evaluate(launcher, `(async () => {
      const me = await chrome.tabs.getCurrent();
      const active = await chrome.tabs.query({ active: true, windowId: me.windowId });
      if (active.length !== 1 || active[0].id === me.id
        || active[0].id === ${world.homeTabId} || active[0].id === ${world.popupTabId}) {
        throw new Error('expected the popup-opened logs page to be the only active tab');
      }
      await chrome.tabs.remove(active[0].id);
      await chrome.tabs.update(${world.homeTabId}, { active: true });
    })()`);

    const probeRoute = async (expected) => waitForState(
      () => driver.evaluate(launcher, `(async () => {
        try {
          const response = await chrome.tabs.sendMessage(${world.homeTabId}, { version: ${STATUS_MESSAGE_VERSION}, type: 'readouts:get' });
          return response.routeKind ?? null;
        } catch (error) {
          return null;
        }
      })()`),
      (kind) => kind === expected ? true : `routeKind ${JSON.stringify(kind)}`,
      { what: `readouts route after navigating to ${expected}` },
    );

    // 同一标签页导航到视频页：面板跟随，收起无媒体提示。
    const homeTarget = await driver.findPageByUrl(HOME_URL);
    const homeSession = await driver.attach(homeTarget.targetId);
    await driver.send('Page.enable', {}, homeSession);
    await driver.send('Page.navigate', { url: VIDEO_URL }, homeSession);
    await probeRoute('video');
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.livePanelHidden === true
        && state.bufferCardHidden === false
        && state.bufferNoteHidden === true
        && state.cdnCard === cdnEmptyMessage
        ? true
        : 'expected the popup to follow after the tab navigated to a video page',
      { what: 'popup after the tab navigates to a video page' },
    );
    markScenario('同一标签页导航到视频页：面板跟随，收起无媒体提示');

    // 同一标签页导航到直播页：切直播布局，如实报等待直播数据。
    await driver.send('Page.navigate', { url: LIVE_URL }, homeSession);
    await probeRoute('live');
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.livePanelHidden === false
        && state.takeover === liveWaitingText
        && state.bufferCardHidden === true
        && state.cdnCard === cdnEmptyMessage
        ? true
        : 'expected the popup to follow after the tab navigated to a live room',
      { what: 'popup after the tab navigates to a live room' },
    );
    markScenario('同一标签页导航到直播页：面板切直播布局，如实报等待直播数据');

    // 活动标签页切到扩展自身日志页：如实退到合并提示，不谎报读取失败。
    await driver.evaluate(launcher, `(async () => {
      const me = await chrome.tabs.getCurrent();
      await chrome.tabs.update(me.id, { active: true });
    })()`);
    await waitForState(
      readState,
      (state) => state.noPage === true && state.notice === NO_PAGE_MESSAGES.noReceiver
        ? true
        : 'expected the truthful merged message while the logs page is the active tab',
      { what: 'popup while the extension logs page is the active tab' },
    );
    markScenario('活动标签页切到扩展自身日志页：如实提示未运行，不谎报读取失败');

    // 控制台通道的阳性对照：探针必须被捕获。
    await driver.evaluate(popupSession, `console.error('[BilibiliBuffer] win-check-d 控制台探针 win-check-d-probe')`);
    await waitForState(
      () => Promise.resolve(consoleErrors.length),
      () => (consoleErrors.some((entry) => entry.text.includes('win-check-d-probe'))
        ? true
        : 'console probe not captured'),
      { what: 'popup console positive control' },
    );

    // 恢复：活动标签页回到直播页，面板恢复。
    await driver.evaluate(launcher, `chrome.tabs.update(${world.homeTabId}, { active: true })`);
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.livePanelHidden === false && state.takeover === liveWaitingText
        ? true
        : 'expected the popup to recover on the live tab',
      { what: 'popup recovery after the live tab is active again' },
    );
    const unexpected = consoleErrors.filter((entry) => !entry.text.includes('win-check-d-probe'));
    assert.deepEqual(unexpected, [], `本组场景出现预期之外的弹窗错误 ${JSON.stringify(unexpected)}`);
    markScenario('重新激活直播标签页：面板恢复，全组弹窗控制台零扩展错误（阳性对照通过）');
  } finally {
    await cleanup();
  }
}

// ---- 第六组：日志大库（72 小时窗口的重度使用规模）----

const SCALE_DB_NAME = 'bilibili-development-logs';
const SCALE_SESSION_COUNT = 40;
const SCALE_CHUNK_PAIRS = 1000;
const SCALE_FOCUS_CHUNKS = SCALE_CHUNK_PAIRS * 2;
const SCALE_FOCUS_SERVE = 200;
const SCALE_FOCUS_EVENTS = SCALE_FOCUS_CHUNKS + SCALE_FOCUS_SERVE;
const SCALE_EVENT_COUNT = 200000;
const SCALE_SEED_BATCH = 5000;
const SCALE_TX_BATCH = 2000;
const SCALE_WALL_SPAN_MS = 47 * 3600 * 1000;

function scaleSessionId(index) {
  return `scale-${String(index).padStart(2, '0')}`;
}

// 播种计划：焦点 session（索引 0）= 2000 条 bank.fetch.chunk（1000 组双腿竞速对）
// + 200 条 bank.serve；其余按 4 码轮转铺满，总量恰好 20 万。
function scaleSeedJobs() {
  const counts = new Array(SCALE_SESSION_COUNT).fill(0);
  counts[0] = SCALE_FOCUS_EVENTS;
  let remaining = SCALE_EVENT_COUNT - SCALE_FOCUS_EVENTS;
  for (let index = 1; index < SCALE_SESSION_COUNT; index += 1) {
    const share = Math.floor(remaining / (SCALE_SESSION_COUNT - index));
    counts[index] = share;
    remaining -= share;
  }
  assert.equal(counts.reduce((sum, value) => sum + value, 0), SCALE_EVENT_COUNT);
  const jobs = [];
  counts.forEach((count, sessionIndex) => {
    for (let fromSeq = 1; fromSeq <= count; fromSeq += SCALE_SEED_BATCH) {
      jobs.push({
        sessionId: scaleSessionId(sessionIndex),
        sessionIndex,
        fromSeq,
        toSeq: Math.min(count, fromSeq + SCALE_SEED_BATCH - 1),
        total: count,
        focus: sessionIndex === 0,
      });
    }
  });
  return jobs;
}

// 页内播种函数：按生产记录形状（client.js append / session.js createSessionIdentity 的字段）
// 直写扩展自己的 IndexedDB，schema 与 idb.js 完全一致、缺时才建；eventId 交给 autoIncrement，
// 播种顺序就是 eventId 递增序。分事务等待，避免单次请求风暴；每批回插计数与耗时。
function scaleSeedExpression(job, context) {
  return `(async () => {
    const job = ${JSON.stringify(job)};
    const ctx = ${JSON.stringify(context)};
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(${JSON.stringify(SCALE_DB_NAME)}, 1);
      request.onerror = () => reject(request.error || new Error('seed db open failed'));
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(${JSON.stringify(SESSION_STORE)})) {
          db.createObjectStore(${JSON.stringify(SESSION_STORE)}, { keyPath: 'sessionId' });
        }
        if (!db.objectStoreNames.contains(${JSON.stringify(EVENT_STORE)})) {
          const events = db.createObjectStore(${JSON.stringify(EVENT_STORE)}, { keyPath: 'eventId', autoIncrement: true });
          events.createIndex(${JSON.stringify(EVENT_INDEX)}, ['sessionId', 'sequence'], { unique: true });
        }
      };
      request.onsuccess = () => resolve(request.result);
    });
    const putAll = (storeName, records) => new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);
      for (const record of records) store.put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('seed tx failed'));
      transaction.onabort = () => reject(transaction.error || new Error('seed tx aborted'));
    });
    const started = Date.now();
    if (job.fromSeq === 1) {
      await putAll(${JSON.stringify(SESSION_STORE)}, [{
        schemaVersion: 1,
        sessionId: job.sessionId,
        startedAt: new Date(ctx.wallStartMs).toISOString(),
        extensionVersion: ctx.version,
        buildId: ctx.buildId,
        tabId: 1000 + job.sessionIndex,
        routeKind: 'video',
        origin: 'https://www.bilibili.com',
        pathname: '/video/BVscale' + String(job.sessionIndex).padStart(2, '0') + '/',
        bvid: 'BVscale' + String(job.sessionIndex).padStart(2, '0'),
      }]);
    }
    const wallTimeFor = (sequence) => new Date(Math.round(
      ctx.wallStartMs + ctx.wallSpanMs * (sequence - 1) / Math.max(1, job.total - 1),
    )).toISOString();
    const elapsedFor = (sequence) => Math.round(ctx.wallSpanMs * (sequence - 1) / Math.max(1, job.total - 1));
    const sampleData = {
      forwardSeconds: 87.25, readyState: 4, networkState: 1, currentTime: 321.123456,
      videoWidth: 1920, videoHeight: 1080, playbackRate: 2, paused: false, muted: false, volume: 0.8,
      bufferedRanges: [
        { start: 0.0, end: 87.2501, track: 'video bytes', bytes: 118111600, label: 'buffered video ahead of the play position' },
        { start: 87.2501, end: 160.75, track: 'video bytes', bytes: 73400320, label: 'buffered video ahead of the play position' },
        { start: 160.75, end: 233.875, track: 'audio bytes', bytes: 8388608, label: 'buffered audio ahead of the play position' },
        { start: 233.875, end: 361.5003, track: 'audio bytes', bytes: 12582912, label: 'buffered audio ahead of the play position' },
      ],
      seekableRanges: [{ start: 0.0, end: 3615.003 }],
      frameTiming: {
        presentedTotal: 12345, droppedTotal: 17, maxFrameGapMs: 33.333, processingMs: 2.5,
        displayLead: 0.833, mediaStep: 33.333, appendMs: 1.25, appendBytes: 1048576,
        sourceOpen: true, quiesce: false, degraded: false, degradedQueue: false,
        degradedAppend: false, presentationLagMs: 4.17, decodeQueueVideo: 12, decodeQueueAudio: 6,
      },
      tracksCount: 2, quality: 80, liveEdge: false, stepAsides: 0,
    };
    const buildRecord = (sequence) => {
      const base = { sessionId: job.sessionId, sequence, wallTime: wallTimeFor(sequence), elapsedMs: elapsedFor(sequence) };
      if (job.focus && sequence <= ctx.focusChunks) {
        const pair = (sequence - 1) >> 1;
        const leg = ((sequence - 1) % 2) + 1;
        const won = (pair % 2) === (leg - 1);
        const start = pair * 1048576;
        const host = 'upos-sz-mirror' + (leg === 1 ? 'a' : 'b') + '.bilivideo.com';
        return { ...base, code: 'bank.fetch.chunk', data: {
          source: 'https://' + host + '/scale-live/stream.flv',
          mirror: host,
          chunkIndex: pair,
          start,
          end: start + 1048575,
          bytes: 1048576,
          durationMs: 220 + (pair % 40),
          slot: leg,
          priority: 'foreground',
          result: won ? 'fetched' : 'lost_race',
          ttfbMs: 40 + (pair % 50),
        } };
      }
      if (job.focus) {
        return { ...base, code: 'bank.serve', data: {
          result: 'hit', mirror: 'upos-sz-mirrora.bilivideo.com', durationMs: 2.8, mode: 'memory',
        } };
      }
      const kind = sequence % 4;
      if (kind === 0) return { ...base, code: 'media.sample', data: sampleData };
      if (kind === 1) return { ...base, code: 'media.append', data: { track: 'video bytes', bytes: 1048576, ms: 3.4, queueLength: 2, bufferedAfter: 96.1 } };
      if (kind === 2) return { ...base, code: 'bank.serve', data: { result: 'hit', mirror: 'upos-sz-mirrorb.bilivideo.com', durationMs: 3.1, mode: 'memory' } };
      return { ...base, code: 'media.progress', data: { currentTime: 321.123, forwardSeconds: 95.5, readyState: 4, paused: false, playbackRate: 2 } };
    };
    let inserted = 0;
    let cursor = job.fromSeq;
    while (cursor <= job.toSeq) {
      const records = [];
      const end = Math.min(job.toSeq, cursor + ${SCALE_TX_BATCH} - 1);
      for (; cursor <= end; cursor += 1) records.push(buildRecord(cursor));
      await putAll(${JSON.stringify(EVENT_STORE)}, records);
      inserted += records.length;
    }
    database.close();
    return { inserted, seconds: (Date.now() - started) / 1000 };
  })()`;
}

async function runLogScalePack() {
  const { driver, cleanup } = await setupBrowser('popup-window-check-e-');
  try {
    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const logsPagePrefix = `chrome-extension://${extensionId}/logs.html`;
    const launcher = await openLauncher(driver, extensionId);

    const consoleErrors = [];
    for (const watched of [() => launcher]) {
      driver.on('Runtime.consoleAPICalled', (message) => {
        if (message.sessionId !== watched() || message.params.type !== 'error') return;
        const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
        consoleErrors.push({ kind: 'console', text });
      });
      driver.on('Runtime.exceptionThrown', (message) => {
        if (message.sessionId !== watched()) return;
        const details = message.params.exceptionDetails ?? {};
        consoleErrors.push({ kind: 'exception', text: details.exception?.description ?? details.text ?? '' });
      });
    }

    // 播种：全程直写扩展自己的 IndexedDB（生产 schema、生产记录形状）。
    const seedContext = {
      buildId: provenance.buildId,
      version: VERSION,
      wallStartMs: Date.now() - 48 * 3600 * 1000,
      wallSpanMs: SCALE_WALL_SPAN_MS,
      focusChunks: SCALE_FOCUS_CHUNKS,
    };
    let seeded = 0;
    let seedSeconds = 0;
    for (const job of scaleSeedJobs()) {
      const result = await driver.evaluate(launcher, scaleSeedExpression(job, seedContext));
      seeded += result.inserted;
      seedSeconds += result.seconds;
    }
    assert.equal(seeded, SCALE_EVENT_COUNT, `seeded ${seeded}`);

    // 快照如实读到播种数：eventId 从 1 连续递增，全部 20 万条都在。
    const snapshot = await driver.evaluate(launcher, `(async () => {
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ version: 1, type: 'logs:max-event-id' }, (response) => {
          if (chrome.runtime.lastError !== undefined) reject(new Error(chrome.runtime.lastError.message));
          else resolve(response);
        });
      });
    })()`);
    assert.equal(snapshot.maxEventId, SCALE_EVENT_COUNT, JSON.stringify(snapshot));
    markScenario('大库播种后快照如实读到全部 20 万条事件（eventId 连续无缺口）');

    // 无 hash 的日志页（launcher 本身就是）：大库下按钮依旧禁用、状态行直说入口。
    const idleCdn = await driver.evaluate(launcher, `({
      filterValue: document.querySelector('[data-session-filter]').value,
      currentDisabled: document.querySelector('[data-session-filter] option[value="current"]').disabled,
      buttonDisabled: document.querySelector('[data-cdn-refresh]').disabled,
      status: document.querySelector('[data-cdn-status]').textContent,
    })`);
    assert.equal(idleCdn.filterValue, '', JSON.stringify(idleCdn));
    assert.equal(idleCdn.currentDisabled, true, JSON.stringify(idleCdn));
    assert.equal(idleCdn.buttonDisabled, true, JSON.stringify(idleCdn));
    assert.equal(idleCdn.status, CDN_RANGE_MESSAGES.noSessionEntry, JSON.stringify(idleCdn));
    markScenario('大库下无 hash 打开日志页：CDN 按钮禁用且状态行直说从弹窗带入 session 的入口');

    // 当前 session 点「读取 CDN racing」：真实按钮路径，两行镜像、覆盖率如实、无 NaN。
    const focusUrl = `${logsPagePrefix}#sessionId=${scaleSessionId(0)}`;
    await driver.evaluate(launcher, `chrome.tabs.create({ url: ${JSON.stringify(focusUrl)}, active: true })`);
    const focusTarget = await waitForState(
      async () => (await driver.targets()).find((info) => info.type === 'page' && info.url.startsWith(`${logsPagePrefix}#sessionId=`)) ?? null,
      (target) => (target !== null ? true : 'focus logs page did not appear'),
      { what: 'focus logs page target' },
    );
    const focusSession = await driver.attach(focusTarget.targetId);
    driver.on('Runtime.consoleAPICalled', (message) => {
      if (message.sessionId !== focusSession || message.params.type !== 'error') return;
      const text = (message.params.args || []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
      consoleErrors.push({ kind: 'console', text });
    });
    driver.on('Runtime.exceptionThrown', (message) => {
      if (message.sessionId !== focusSession) return;
      const details = message.params.exceptionDetails ?? {};
      consoleErrors.push({ kind: 'exception', text: details.exception?.description ?? details.text ?? '' });
    });
    const readCdnPanel = () => driver.evaluate(focusSession, `({
      filterValue: document.querySelector('[data-session-filter]').value,
      buttonDisabled: document.querySelector('[data-cdn-refresh]').disabled,
      status: document.querySelector('[data-cdn-status]').textContent,
      summary: document.querySelector('[data-cdn-summary]').textContent,
      rows: [...document.querySelectorAll('[data-cdn-rows] tr')].map((row) => [...row.children].map((cell) => cell.textContent)),
    })`);
    const beforeClick = await waitForState(
      readCdnPanel,
      (panel) => (panel.filterValue === 'current' && panel.buttonDisabled === false
        ? true
        : `focus logs page not initialized: ${JSON.stringify(panel)}`),
      { what: 'focus logs page initial CDN state' },
    );
    const cdnStart = Date.now();
    await driver.evaluate(focusSession, `document.querySelector('[data-cdn-refresh]').click()`);
    const cdnPanel = await waitForState(
      readCdnPanel,
      (panel) => (panel.status.startsWith(`读取完成，覆盖 ${SCALE_FOCUS_CHUNKS} 条事件`) ? true : `CDN read not done: ${panel.status}`),
      { what: 'CDN racing read on the seeded focus session', timeoutMs: 60000 },
    );
    const cdnSeconds = (Date.now() - cdnStart) / 1000;
    // readCdnSummary 的 maxEventId 是本 session 自己的最大 eventId：焦点 session 的 2200 条最先入库。
    assert.ok(cdnPanel.status.includes(`截止 eventId ${SCALE_FOCUS_EVENTS}`), JSON.stringify(cdnPanel.status));
    assert.equal(cdnPanel.rows.length, 2, JSON.stringify(cdnPanel.rows));
    assert.ok(cdnPanel.summary.includes(`配对覆盖率 ${SCALE_CHUNK_PAIRS}/${SCALE_CHUNK_PAIRS}`), JSON.stringify(cdnPanel.summary));
    assert.ok(cdnPanel.summary.includes('浪费字节率 100.0%'), JSON.stringify(cdnPanel.summary));
    assert.ok(!JSON.stringify(cdnPanel).includes('NaN'), JSON.stringify(cdnPanel));
    markScenario('大库下当前 session 读取 CDN racing：两行镜像、覆盖率 1000/1000、无 NaN，状态行如实报截止快照');

    // 导出全部 session：行数恰好等于播种行数（40 sessions + 20 万事件），writer 正常关闭。
    await driver.evaluate(focusSession, `
      window.__scaleExport = { writes: 0, bytes: 0, lines: 0, closed: false, aborted: false };
      window.showSaveFilePicker = async () => ({
        createWritable: async () => ({
          write: async (chunk) => {
            window.__scaleExport.writes += 1;
            window.__scaleExport.bytes += chunk.length;
            window.__scaleExport.lines += 1;
          },
          close: async () => { window.__scaleExport.closed = true; },
          abort: async () => { window.__scaleExport.aborted = true; },
        }),
      });
      const select = document.querySelector('[data-session-filter]');
      select.value = '';
      select.dispatchEvent(new Event('change'));
      document.querySelector('[data-export]').click();
      'export-clicked'`);
    const exportStart = Date.now();
    await waitForState(
      () => driver.evaluate(focusSession, `document.querySelector('[data-status]').textContent`),
      (text) => (text.startsWith(`导出完成，截止 eventId ${SCALE_EVENT_COUNT}`) ? true : `export not done: ${text}`),
      { what: 'full-database export on the seeded corpus', timeoutMs: 240000, intervalMs: 1000 },
    );
    const exportSeconds = (Date.now() - exportStart) / 1000;
    const scaleExport = await driver.evaluate(focusSession, `window.__scaleExport`);
    assert.equal(scaleExport.lines, SCALE_EVENT_COUNT + SCALE_SESSION_COUNT, JSON.stringify(scaleExport));
    assert.equal(scaleExport.closed, true, JSON.stringify(scaleExport));
    assert.equal(scaleExport.aborted, false, JSON.stringify(scaleExport));
    assert.ok(scaleExport.bytes > 40 * 1024 ** 2 && scaleExport.bytes < 400 * 1024 ** 2, JSON.stringify(scaleExport));
    markScenario('大库导出全部 session：行数恰好等于 40 个 session 加 20 万条事件，writer 关闭，状态行如实报截止 eventId');
    console.log(`log-scale timings: seed ${seedSeconds.toFixed(1)}s, cdn ${cdnSeconds.toFixed(1)}s, export ${exportSeconds.toFixed(1)}s, bytes ${scaleExport.bytes}`);

    // 控制台通道阳性对照 + 全组零预期外错误。
    await driver.evaluate(focusSession, `console.error('[BilibiliBuffer] win-check-e 控制台探针 win-check-e-probe')`);
    await waitForState(
      () => Promise.resolve(consoleErrors.length),
      () => (consoleErrors.some((entry) => entry.text.includes('win-check-e-probe')) ? true : 'console probe not captured'),
      { what: 'log-scale console positive control' },
    );
    const unexpected = consoleErrors.filter((entry) => !entry.text.includes('win-check-e-probe'));
    assert.deepEqual(unexpected, [], `大库场景出现预期之外的控制台错误 ${JSON.stringify(unexpected)}`);
    markScenario('大库全组零扩展错误（控制台阳性对照通过）');
  } finally {
    await cleanup();
  }
}

const provenance = await readProvenance();

const commitSha = process.env.BILIBILI_E2E_COMMIT_SHA ?? provenance.commitSha ?? provenance.commitShaReason ?? 'unknown';
console.log('popup window check provenance:', JSON.stringify({
  commitSha,
  buildId: provenance.buildId,
  chrome: chromeExecutablePath,
  fixtures: { video: VIDEO_URL, live: LIVE_URL, other: OTHER_URL, nomedia: HOME_URL },
}));

await runMultiWindowPack();
await runPreExistingPagePack();
await runSwitchPack();
await runUpdateMidPlaybackPack();
await runNoMediaPagePack();
await runLogScalePack();

console.log(`popup window check passed: ${scenarios.length} scenarios`);
for (const scenario of scenarios) console.log(`- ${scenario}`);
