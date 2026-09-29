// 弹窗窗口归属的确定性浏览器检查（headless，全程 fixture 页面，不访问真实 Bilibili）。
// 覆盖的缺陷（0e982f5，2026-09-28 用户实测）：弹窗按 lastFocusedWindow 取标签页时，
// 两个普通窗口下弹窗会显示另一个窗口的页面。本检查让 lastFocusedWindow 固定落在直播
// 所在窗口，而弹窗开在视频页所在窗口，断言弹窗只报告自己窗口的活动标签页。
// 同时覆盖：非 Bilibili 活动标签页、扩展更新后打开弹窗、页面早于扩展安装打开；
// 这三种没有内容脚本可答的情形共享同一句如实提示（弹窗没有 tabs 权限、看不到地址，
// 无法区分三者，提示对三者都成立并给出刷新路径）。第三组覆盖两个开关：默认开启、
// 拨动后的保存提示、关闭并刷新页面后面板如实报开关已关闭（直播不空等数据、视频不
// 谎称申请过缓存目标）、拨回并刷新后面板恢复。
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
import { NO_PAGE_MESSAGES, SWITCH_OFF_TEXT } from '../src/extension/popup-view.js';
import { STATUS_MESSAGE_VERSION } from '../src/ui/panel.js';
import { VOD_CONFIG } from '../src/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const chromeExecutablePath = process.env.BILIBILI_E2E_CHROME?.trim();
if (chromeExecutablePath === undefined || chromeExecutablePath.length === 0) {
  throw new Error('set BILIBILI_E2E_CHROME to the Chrome executable; no silent fallback');
}

const VIDEO_URL = 'https://www.bilibili.com/video/BVwin-check/';
const LIVE_URL = 'https://live.bilibili.com/6-win-check';
const OTHER_URL = 'https://example.com/popup-window-check';
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

async function installFixtureInterception(driver) {
  const keyFor = (url) => {
    if (url.startsWith(VIDEO_URL)) return 'video';
    if (url.startsWith(LIVE_URL)) return 'live';
    if (url.startsWith(OTHER_URL)) return 'other';
    return undefined;
  };
  await driver.send('Fetch.enable', {
    patterns: [
      { urlPattern: `${VIDEO_URL}*`, requestStage: 'Request' },
      { urlPattern: `${LIVE_URL}*`, requestStage: 'Request' },
      { urlPattern: `${OTHER_URL}*`, requestStage: 'Request' },
    ],
  });
  driver.on('Fetch.requestPaused', (event) => {
    const params = event.params;
    const kind = keyFor(params.request.url);
    assert.ok(kind !== undefined, `fixture interception saw an unmatched URL: ${params.request.url}`);
    void driver.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: Buffer.from(FIXTURE_HTML(kind), 'utf8').toString('base64'),
    }, event.sessionId);
  });
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
  await installFixtureInterception(driver);
  const cleanup = async () => {
    await transport.close();
    await stopChrome(chrome);
    await rmTree(profileDirectory);
  };
  return { driver, cleanup };
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
  fixtures: { video: VIDEO_URL, live: LIVE_URL, other: OTHER_URL },
}));

await runMultiWindowPack();
await runPreExistingPagePack();
await runSwitchPack();

console.log(`popup window check passed: ${scenarios.length} scenarios`);
for (const scenario of scenarios) console.log(`- ${scenario}`);
