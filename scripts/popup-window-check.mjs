// 弹窗窗口归属的确定性浏览器检查（headless，全程 fixture 页面，不访问真实 Bilibili）。
// 覆盖的缺陷（0e982f5，用户实测）：弹窗按 lastFocusedWindow 取标签页时，
// 两个普通窗口下弹窗会显示另一个窗口的页面。本检查让 lastFocusedWindow 固定落在直播
// 所在窗口，而弹窗开在视频页所在窗口，断言弹窗只报告自己窗口的活动标签页。
// 同时覆盖：非 Bilibili 活动标签页、扩展更新后打开弹窗、页面早于扩展安装打开；
// 这三种没有内容脚本可答的情形共享同一句如实提示（弹窗没有 tabs 权限、看不到地址，
// 无法区分三者，提示对三者都成立并给出刷新路径）。第三组覆盖两个开关：默认开启、
// 拨动后的保存提示、关闭并刷新页面后面板如实报开关已关闭（直播不空等数据、视频不
// 谎称申请过缓存目标）、拨回并刷新后面板恢复。第四组覆盖商店自动更新的真实时序：
// 视频页正在拉流时重载同一播放源，旧文档的内容脚本作废，但下载层跑在页面主世界里
// 不受影响：拉流必须续上、库存分片继续命中（网络零新增）、控制台只允许「日志持久化
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
// 第七组覆盖分 P 同文档导航（只动 query 的 pushState，真实站多 P 视频切分 P 的一种
// 走法）：地址轮询按完整 href 比较，?p=2 也必须换记录；GOAL.md 要求新分 P 独立成
// 一条记录，落库的 session 正好带 part、不带 query。断言链：内容侧换记录、开着的
// 弹窗保持如实视频布局、库里新旧记录各就各位、弹窗日志入口指向新记录。
// 第八组覆盖扩展更新前打开的日志页：商店更新随时可能落在它上面。实测（Chrome 154
// headless，Extensions.loadUnpacked 同源重载）：重载会把扩展自己的页面全部关掉，
// 更新前打开的日志页标签随之消失，没有失效页面留下来说错话；内容标签页保留。
// 本组断言这个关闭行为、内容页的保留，以及重开后日志页读同一 session 照常成功。
// 第九组覆盖直播接管产生真实 bank.serve 事实之后的弹窗填数态（商店截图
// popup-live.png 的同款面板区，此前只被真实站点截图看过、从未在浏览器里断言）：
// 双镜像竞速、单路接管、只拉播放列表的未接管、镜像全灭的接管失败，四种结局的
// 接管行与线路卡镜像行填数都要如实。竞速场景用生产版内嵌 playinfo blob
// （__NEPTUNE_IS_MY_WAIFU__，serveLiveSegment 配对查找 miss 时的兜底读取路径）
// 给出双镜像地址，首段身份门整体比对后放开竞速；失败场景两个镜像都答 502。
// fMP4 分片接管的接管行后接 FLV 后备状态：各房间的地址簿都没有同流名的 FLV 条目，
// 后备按设计记 unavailable，原因（no_flv_entry 或 no_hls_entry）从该标签页 session
// 的 live.flv.backup 事件读出核对，面板显示无后备后缀。
// 断言的期望值一律从 src 的既有导出（liveTakeoverText、cdnLinesView、
// shortMirrorName）推导，失败场景页面控制台的如实报错充当阳性对照。
// 第十组是第四组的直播对照组：商店自动更新落在正在拉流的直播页上。直播有自己
// 的接管机器（播放列表放行、整段身份门、配对地址簿），更新后能否继续双路竞速
// 不能由视频结论推出，必须实测。机器同样跑在页面主世界：预期拉流续上、两个
// 镜像的接管腿计数都继续前进（竞速不退化成单路）、带 Range 的直达分片请求保持
// 为零（页面拉取始终由接管应答，没有任何一次拉流绕过下载层走原生通道），控制台
// 只允许「日志持久化降级」这一类如实错误（必须出现，作阳性对照）。
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
  NO_PAGE_MESSAGES, SWITCH_OFF_TEXT, cdnLinesView, liveTakeoverText, shortMirrorName,
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
// 第九组的直播接管填数场景：四个房间四种接管结局，两个镜像主机由固定写法承担
// （e2e-live 与 e2e-live-b）。竞速与失败场景靠内嵌 playinfo blob 走生产版地址簿路径，
// url_info 组的 base_url 挂在 codec 层（详见 src/bank/live.js urlFromLiveUrlInfo）。
const LIVE_RACE_URL = 'https://live.bilibili.com/7-race-win-check';
const LIVE_SINGLE_URL = 'https://live.bilibili.com/7-single-win-check';
const LIVE_PLAYLIST_URL = 'https://live.bilibili.com/7-playlist-win-check';
const LIVE_FAIL_URL = 'https://live.bilibili.com/7-fail-win-check';
const LIVE_UPDATE_URL = 'https://live.bilibili.com/7-update-win-check';
const LIVE_MEDIA_ORIGINS = ['https://e2e-live.bilivideo.com', 'https://e2e-live-b.bilivideo.com'];
const LIVE_SEGMENT_BYTES = 256 * 1024;
const LIVE_TAKEOVER_STREAM_DIRS = Object.freeze({
  race: '/e2e/live-stream/',
  single: '/e2e/single-stream/',
  playlist: '/e2e/playlist-stream/',
  fail: '/e2e/fail-stream/',
  update: '/e2e/live-update-stream/',
});

function livePlayinfoBlob(streamDir) {
  return {
    playurl_info: {
      playurl: {
        stream: [{
          protocol_name: 'http_hls',
          format: [{
            codec: [{
              base_url: `${streamDir}index.m3u8`,
              url_info: [
                { host: LIVE_MEDIA_ORIGINS[0], extra: 'signature=live-a', stream_ttl: 1 },
                { host: LIVE_MEDIA_ORIGINS[1], extra: 'signature=live-b', stream_ttl: 1 },
              ],
            }],
          }],
        }],
      },
    },
  };
}

// race：内嵌双镜像 playinfo 后整段拉流（页面视角闭合 Range，接管腿不带 Range 取整段）；
// single：无地址簿，只有播放器所名地址单腿；playlist：只拉播放列表（pass）；fail：
// 拉流不断重试但镜像全灭（502），用作接管失败与控制台如实报错的场景。
const LIVE_TAKEOVER_FIXTURE_HTML = (variant) => `<!doctype html><html><head><meta charset="utf-8"><title>win-check live ${variant}</title></head><body>
<script>
  ${variant === 'race' || variant === 'fail' || variant === 'update' ? `window.__NEPTUNE_IS_MY_WAIFU__ = ${JSON.stringify(livePlayinfoBlob(LIVE_TAKEOVER_STREAM_DIRS[variant]))};` : ''}
  window.__liveTakeover = { responses: 0, errors: [] };
  const streamDir = ${JSON.stringify(LIVE_TAKEOVER_STREAM_DIRS[variant])};
  const mediaOrigin = ${JSON.stringify(LIVE_MEDIA_ORIGINS[0])};
  const totalBytes = ${LIVE_SEGMENT_BYTES};
  async function pullSegment(index) {
    const url = mediaOrigin + streamDir + 'seg-' + index + '.m4s?signature=live';
    try {
      const response = await fetch(url, { headers: { Range: 'bytes=0-' + (totalBytes - 1) } });
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength !== totalBytes) throw new Error('short read: ' + buffer.byteLength);
      const view = new Uint8Array(buffer);
      for (const probe of [0, totalBytes >> 1, totalBytes - 1]) {
        if (view[probe] !== probe % 251) throw new Error('byte mismatch at ' + probe);
      }
      window.__liveTakeover.responses += 1;
    } catch (error) {
      window.__liveTakeover.errors.push(String((error && error.message) || error));
    }
  }
  async function pullPlaylist(index) {
    try {
      const response = await fetch(mediaOrigin + streamDir + 'index.m3u8?signature=live&n=' + index);
      await response.text();
      window.__liveTakeover.responses += 1;
    } catch (error) {
      window.__liveTakeover.errors.push(String((error && error.message) || error));
    }
  }
  ${variant === 'update' ? `
  // 更新组：页面像 hls.js 一样按自己的定时器不停拉新分片（下标单调递增）。扩展
  // 重载不刷新页面文档，这个定时器必须继续驱动拉流，断流即下载层随上下文死掉。
  let updatePullIndex = 0;
  setInterval(() => {
    updatePullIndex += 1;
    void pullSegment(updatePullIndex);
  }, 250);
` : `
  (async () => {
    const attempts = ${variant === 'fail' ? 8 : 3};
    for (let index = 0; index < attempts; index += 1) {
      await (${variant === 'playlist' ? 'pullPlaylist' : 'pullSegment'})(index + 1);
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  })();
`}
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

// 竞速败腿的请求在拦截里挂着被页面中止时，对应的 fulfill 会撞上 Invalid
// InterceptionId（-32602）：这是竞速 fixture 的正常时序，不是拦截故障。容忍
// 且只容忍这一种（其余参数错误照旧让进程死掉），每次发生都全量可见地记录。
// 请求真的没来时（路径/配对写错了）没有任何记录兜底：场景断言会按超时如实失败。
function fulfillLiveMedia(driver, sessionId, payload, label) {
  void driver.send('Fetch.fulfillRequest', payload, sessionId).catch((error) => {
    if (error?.code === -32602 && typeof error.message === 'string'
      && error.message.includes('InterceptionId')) {
      console.warn(`live media fulfill raced a page abort (${label})`);
      return;
    }
    throw error;
  });
}

async function installFixtureInterception(driver) {
  // liveMediaGetsByHost 按镜像主机分开计数（双镜像是否同时供数的直接证据）；
  // liveMediaRangeGets 数携带 Range 的分片请求：页面视角的拉取带闭合 Range，接管腿
  // 不带，任何带 Range 的直达请求都意味着分片绕过接管走了原生通道（更新组的判据）。
  const stats = {
    updateSegmentGets: 0,
    liveMediaGets: 0,
    liveMediaGetsByHost: { [LIVE_MEDIA_ORIGINS[0]]: 0, [LIVE_MEDIA_ORIGINS[1]]: 0 },
    liveMediaRangeGets: 0,
  };
  const keyFor = (url) => {
    if (url.startsWith(VIDEO_URL)) return 'video';
    if (url.startsWith(LIVE_RACE_URL)) return 'liverace';
    if (url.startsWith(LIVE_SINGLE_URL)) return 'livesingle';
    if (url.startsWith(LIVE_PLAYLIST_URL)) return 'liveplaylist';
    if (url.startsWith(LIVE_FAIL_URL)) return 'livefail';
    if (url.startsWith(LIVE_UPDATE_URL)) return 'liveupdate';
    if (url.startsWith(LIVE_URL)) return 'live';
    if (url.startsWith(OTHER_URL)) return 'other';
    if (url.startsWith(HOME_URL)) return 'nomedia';
    if (url.startsWith(UPDATE_VIDEO_URL)) return 'update';
    if (url.startsWith(UPDATE_SEGMENT_URL)) return 'segment';
    if (LIVE_MEDIA_ORIGINS.some((origin) => url.startsWith(`${origin}/e2e/`))) return 'livemedia';
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
      { urlPattern: `${LIVE_RACE_URL}*`, requestStage: 'Request' },
      { urlPattern: `${LIVE_SINGLE_URL}*`, requestStage: 'Request' },
      { urlPattern: `${LIVE_PLAYLIST_URL}*`, requestStage: 'Request' },
      { urlPattern: `${LIVE_FAIL_URL}*`, requestStage: 'Request' },
      { urlPattern: `${LIVE_UPDATE_URL}*`, requestStage: 'Request' },
      { urlPattern: 'https://e2e-live.bilivideo.com/e2e/*', requestStage: 'Request' },
      { urlPattern: 'https://e2e-live-b.bilivideo.com/e2e/*', requestStage: 'Request' },
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
    if (kind === 'livemedia') {
      if (params.request.method === 'OPTIONS') {
        fulfillLiveMedia(driver, event.sessionId, {
          requestId: params.requestId, responseCode: 204, responseHeaders: FIXTURE_CORS_HEADERS,
        }, 'OPTIONS');
        return;
      }
      const mediaUrl = new URL(params.request.url);
      if (mediaUrl.pathname.startsWith(LIVE_TAKEOVER_STREAM_DIRS.fail)) {
        // 镜像全灭场景：两条腿拿到相同的如实 502。
        fulfillLiveMedia(driver, event.sessionId, {
          requestId: params.requestId,
          responseCode: 502,
          responseHeaders: [
            ...FIXTURE_CORS_HEADERS,
            { name: 'Content-Type', value: 'video/mp4' },
            { name: 'Content-Length', value: '0' },
          ],
          body: '',
        }, 'fail mirror');
        return;
      }
      if (mediaUrl.pathname.endsWith('.m3u8')) {
        fulfillLiveMedia(driver, event.sessionId, {
          requestId: params.requestId,
          responseCode: 200,
          responseHeaders: [
            ...FIXTURE_CORS_HEADERS,
            { name: 'Content-Type', value: 'application/vnd.apple.mpegurl' },
            { name: 'Cache-Control', value: 'no-store' },
          ],
          body: Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:0\n', 'utf8').toString('base64'),
        }, 'playlist');
        return;
      }
      // 分片应答：接管腿不带 Range（整段取回），页面视角带闭合 Range。字节按绝对
      // 位移确定性生成，两个镜像主机天然一致，首段身份门的整体比对即通过。
      const rangeHeader = (params.request.headers.Range ?? params.request.headers.range ?? '');
      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
      const start = match === null ? 0 : Number(match[1]);
      stats.liveMediaGets += 1;
      stats.liveMediaGetsByHost[mediaUrl.origin] = (stats.liveMediaGetsByHost[mediaUrl.origin] ?? 0) + 1;
      if (match !== null) stats.liveMediaRangeGets += 1;
      assert.ok(start < LIVE_SEGMENT_BYTES, `live segment request out of range: ${params.request.url}`);
      const end = Math.min(match === null ? LIVE_SEGMENT_BYTES - 1 : Number(match[2]), LIVE_SEGMENT_BYTES - 1);
      const body = Buffer.alloc(end - start + 1);
      for (let index = 0; index < body.length; index += 1) body[index] = (start + index) % 251;
      const headers = [
        ...FIXTURE_CORS_HEADERS,
        { name: 'Content-Type', value: 'video/mp4' },
        { name: 'Content-Length', value: String(body.length) },
        { name: 'Cache-Control', value: 'no-store' },
      ];
      if (match !== null) headers.push({ name: 'Content-Range', value: `bytes ${start}-${end}/${LIVE_SEGMENT_BYTES}` });
      fulfillLiveMedia(driver, event.sessionId, {
        requestId: params.requestId,
        responseCode: match === null ? 200 : 206,
        responseHeaders: headers,
        body: body.toString('base64'),
      }, `${mediaUrl.origin}${mediaUrl.pathname}`);
      return;
    }
    void driver.send('Fetch.fulfillRequest', {
      requestId: params.requestId,
      responseCode: 200,
      responseHeaders: [
        { name: 'Content-Type', value: 'text/html; charset=utf-8' },
        { name: 'Cache-Control', value: 'no-store' },
      ],
      body: Buffer.from(fixtureHtmlFor(kind), 'utf8').toString('base64'),
    }, event.sessionId);
  });
  return stats;
}

// 页面 fixture 分发：四种直播接管结局各有自己的页面，其余沿用原样。
function fixtureHtmlFor(kind) {
  if (kind === 'update') return UPDATE_FIXTURE_HTML;
  if (kind === 'liverace') return LIVE_TAKEOVER_FIXTURE_HTML('race');
  if (kind === 'livesingle') return LIVE_TAKEOVER_FIXTURE_HTML('single');
  if (kind === 'liveplaylist') return LIVE_TAKEOVER_FIXTURE_HTML('playlist');
  if (kind === 'livefail') return LIVE_TAKEOVER_FIXTURE_HTML('fail');
  if (kind === 'liveupdate') return LIVE_TAKEOVER_FIXTURE_HTML('update');
  return FIXTURE_HTML(kind);
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

// 第四组：商店自动更新的真实时序：视频页拉流正酣时重载同一播放源。
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

// 第十组：扩展更新落在正在拉流的直播页上（第四组的直播对照组，见文件头说明）。
async function runLiveUpdateMidStreamPack() {
  const { driver, cleanup, fixtures } = await setupBrowser('popup-window-check-h-');
  try {
    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const launcher = await openLauncher(driver, extensionId);
    const liveTabId = await driver.evaluate(launcher, `(async () => {
      const tab = await chrome.tabs.create({ url: ${JSON.stringify(LIVE_UPDATE_URL)}, active: true });
      return tab.id;
    })()`);
    const liveTarget = await driver.findPageByUrl(LIVE_UPDATE_URL);
    const liveSession = await driver.attach(liveTarget.targetId);

    const consoleErrors = [];
    driver.on('Runtime.consoleAPICalled', (message) => {
      if (message.sessionId !== liveSession || message.params.type !== 'error') return;
      const text = (message.params.args || [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      consoleErrors.push({ kind: 'console', text });
    });
    driver.on('Runtime.exceptionThrown', (message) => {
      if (message.sessionId !== liveSession) return;
      const details = message.params.exceptionDetails ?? {};
      consoleErrors.push({ kind: 'exception', text: details.exception?.description ?? details.text ?? '' });
    });

    // 拉流稳定之后，两路证据都必须成立：fixture 侧两个镜像主机都已收到接管腿
    // （单路退化时备用镜像一个请求都不会有）；生产读出（logs:live-summary，弹窗
    // 接管行的数据来源）报告接管生效且双路竞速。
    await waitForState(
      () => driver.evaluate(liveSession, `window.__liveTakeover === undefined ? null : JSON.parse(JSON.stringify(window.__liveTakeover))`),
      (state) => state !== null && state.errors.length === 0 && state.responses >= 6
        ? true
        : 'waiting for steady live segment pulls',
      { what: 'live fixture pulling segments before the update' },
    );
    await waitForState(
      () => Promise.resolve({ ...fixtures.liveMediaGetsByHost }),
      (counts) => counts[LIVE_MEDIA_ORIGINS[0]] > 0 && counts[LIVE_MEDIA_ORIGINS[1]] > 0
        ? true
        : 'waiting for both mirrors to receive takeover legs',
      { what: 'both live mirrors receiving takeover legs before the update' },
    );
    await waitForState(
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
        const probe = await chrome.tabs.sendMessage(
          ${liveTabId},
          { version: ${STATUS_MESSAGE_VERSION}, type: 'diagnostics:session-id:get' },
        );
        if (probe?.ok !== true || typeof probe.sessionId !== 'string') {
          throw new Error('live session id probe failed: ' + JSON.stringify(probe));
        }
        const summary = await send({ version: 1, type: 'logs:live-summary', sessionId: probe.sessionId });
        if (summary?.ok !== true) throw new Error('live summary was rejected');
        return summary.facts;
      })()`),
      (facts) => facts.serveCount > 0 && facts.engagement === 'engaged'
        && facts.pairedAddressAvailable === true && facts.pairRejected === false
        ? true
        : `waiting for paired racing facts, got ${JSON.stringify(facts)}`,
      { what: 'live takeover with paired racing visible in the production readout before the update' },
    );
    markScenario('扩展更新前的直播页：接管与双镜像竞速已在运行（生产读出与镜像计数双证）');

    // 更新：重载同一播放源（扩展 id 不变，即商店更新对页面的形态）。旧 launcher
    // 同属旧上下文，弃用并开新 launcher；旧直播页的内容脚本必须死掉。
    const { id: reloadedId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    assert.equal(reloadedId, extensionId, '同一播放源重载后扩展 id 不变');
    const launcherAfter = await openLauncher(driver, extensionId);
    await waitForState(
      () => driver.evaluate(launcherAfter, `chrome.tabs.sendMessage(
        ${liveTabId},
        { version: ${STATUS_MESSAGE_VERSION}, type: 'readouts:get' },
      ).then(() => 'alive', () => 'dead')`),
      (value) => value === 'dead' ? true : 'old content script still answering',
      { what: 'old live content script orphaned by the update' },
    );
    // 与第四组同理：新 launcher 抢走活动标签位后，后台标签页的 setInterval 被压到
    // 约 1 Hz，先把直播页激活回来再开窗观察。
    const activated = await driver.evaluate(launcherAfter, `chrome.tabs.update(${liveTabId}, { active: true }).then(() => true)`);
    assert.equal(activated, true, '直播页重新激活失败');

    // 观察窗：直播拉流（新分片）必须续上；两个镜像的接管腿计数都继续前进（竞速
    // 没有随上下文退化成单路）；带 Range 的直达分片请求保持为零（页面拉取始终由
    // 接管应答，没有任何一次拉流绕过下载层走原生通道）；控制台只允许持久化降级
    // 这一类如实错误（扩展上下文作废后写库失败的既有信号，且必须出现作阳性对照）。
    const pullsBefore = await driver.evaluate(liveSession, `window.__liveTakeover.responses`);
    const getsBefore = { ...fixtures.liveMediaGetsByHost };
    await delay(15000);
    const post = await driver.evaluate(liveSession, `window.__liveTakeover === undefined ? null : JSON.parse(JSON.stringify(window.__liveTakeover))`);
    assert.deepEqual(post.errors, [], `更新后直播拉流出错 ${JSON.stringify(post.errors)}`);
    const pullsAfter = post.responses - pullsBefore;
    assert.ok(pullsAfter >= 12, `更新后直播拉流没有续上：15 秒只前进了 ${pullsAfter} 次拉取`);
    assert.ok(
      fixtures.liveMediaGetsByHost[LIVE_MEDIA_ORIGINS[0]] > getsBefore[LIVE_MEDIA_ORIGINS[0]]
        && fixtures.liveMediaGetsByHost[LIVE_MEDIA_ORIGINS[1]] > getsBefore[LIVE_MEDIA_ORIGINS[1]],
      `更新后双镜像不再同时供给（重载时 ${JSON.stringify(getsBefore)}，现在 ${JSON.stringify(fixtures.liveMediaGetsByHost)}）：竞速疑似随扩展上下文退化成单路`,
    );
    assert.equal(
      fixtures.liveMediaRangeGets,
      0,
      '出现携带 Range 的页面直达分片请求：分片拉取疑似绕过接管走了原生通道',
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
    markScenario('扩展更新时直播页正在拉流：拉流续上、双镜像继续竞速、分片拉取零直达，控制台只如实报日志持久化降级');
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

    // 站内单页导航（同文档 pushState，不重载页面，真实站最普遍的走法）：内容侧路由轮询
    // 发现地址变化后旧记录结束、新记录开始；全程开着的弹窗保持如实视频布局，不闪「未运行」。
    const sessionProbe = () => driver.evaluate(launcher, `(async () => {
      try {
        const response = await chrome.tabs.sendMessage(${world.homeTabId}, { version: ${STATUS_MESSAGE_VERSION}, type: 'diagnostics:session-id:get' });
        return response.sessionId ?? null;
      } catch (error) {
        return null;
      }
    })()`);
    const sessionBefore = await waitForState(
      sessionProbe,
      (value) => typeof value === 'string' ? true : `session ${JSON.stringify(value)}`,
      { what: 'content-side session on the video page before the in-page navigation' },
    );
    await driver.evaluate(homeSession, `history.pushState({}, '', '/video/BVwin-check-spa/')`);
    const sessionAfter = await waitForState(
      sessionProbe,
      (value) => typeof value === 'string' && value !== sessionBefore ? true : `session ${JSON.stringify(value)}`,
      { what: 'content-side session rotation after the in-page navigation' },
    );
    await probeRoute('video');
    const spaShown = await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.livePanelHidden === true
        && state.bufferCardHidden === false
        && state.bufferNoteHidden === true
        && state.cdnCard === cdnEmptyMessage
        ? true
        : 'expected the popup to stay truthful across the in-page navigation',
      { what: 'open popup across an in-page (pushState) navigation between video pages' },
    );
    assert.equal(spaShown.ownActiveTabIds[0], world.homeTabId, JSON.stringify(spaShown));
    markScenario('站内单页导航到另一视频地址（同文档不重载）：内容侧换新记录，弹窗如实跟随不闪未运行');

    // 弹窗的「打开开发日志」在点击时重新询问内容侧：换记录之后入口指向新 session。
    await driver.evaluate(popupSession, `document.querySelector('[data-open-logs]').click()`);
    const [spaLogsTarget] = await waitForState(
      async () => (await driver.targets())
        .filter((info) => info.type === 'page' && info.url.startsWith(`${logsPagePrefix}#sessionId=`)),
      (candidates) => candidates.length === 1 ? true : `expected 1 popup-opened logs page, got ${candidates.length}`,
      { what: 'popup-opened logs page after the in-page navigation' },
    );
    assert.equal(spaLogsTarget.url, `${logsPagePrefix}#sessionId=${sessionAfter}`,
      '弹窗的日志入口必须指向单页导航后的新记录');
    markScenario('单页导航换新记录后：弹窗日志入口指向新 session');

    // 关掉弹出的日志页，活动标签页回到视频页，弹窗面板恢复。
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
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.livePanelHidden === true && state.bufferCardHidden === false
        ? true
        : `expected the popup to recover after its logs page was closed`,
      { what: 'popup recovery after the popup-opened logs page closes' },
    );

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

// ---- 第七组：分 P 同文档导航（见文件头说明）----

async function runPartNavigationPack() {
  const { driver, cleanup } = await setupBrowser('popup-window-check-f-');
  try {
    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const logsPagePrefix = `chrome-extension://${extensionId}/logs.html`;
    const launcher = await openLauncher(driver, extensionId);
    const world = await driver.evaluate(launcher, `(async () => {
      const videoTab = await chrome.tabs.create({ url: ${JSON.stringify(VIDEO_URL)}, active: true });
      const popupTab = await chrome.tabs.create({ url: ${JSON.stringify(popupUrl)}, active: false });
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
      return { windowId: videoTab.windowId, videoTabId: videoTab.id, popupTabId: popupTab.id, videoKind };
    })()`);
    console.log('part-navigation world:', JSON.stringify(world));
    assert.equal(world.videoKind, 'video', JSON.stringify(world));

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
    const honestVideoLayout = (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
      && state.livePanelHidden === true
      && state.bufferCardHidden === false
      && state.bufferNoteHidden === true
      && state.cdnCard === cdnEmptyMessage;
    const videoTarget = await driver.findPageByUrl(VIDEO_URL);
    const videoSession = await driver.attach(videoTarget.targetId);
    const sessionProbe = () => driver.evaluate(launcher, `(async () => {
      try {
        const response = await chrome.tabs.sendMessage(${world.videoTabId}, { version: ${STATUS_MESSAGE_VERSION}, type: 'diagnostics:session-id:get' });
        return response.sessionId ?? null;
      } catch (error) {
        return null;
      }
    })()`);

    const sessionBefore = await waitForState(
      sessionProbe,
      (value) => typeof value === 'string' ? true : `session ${JSON.stringify(value)}`,
      { what: 'content-side session on the video page before the part navigation' },
    );
    const baselineShown = await waitForState(
      readState,
      (state) => honestVideoLayout(state) ? true : 'expected the honest video layout before the part navigation',
      { what: 'popup baseline on the video page' },
    );
    assert.equal(baselineShown.ownActiveTabIds[0], world.videoTabId, JSON.stringify(baselineShown));
    markScenario('分 P 导航前：弹窗如实视频布局，内容侧记录就绪');

    // 同文档切分 P：只动 query 的 pushState，不重载页面。
    await driver.evaluate(videoSession, `history.pushState({}, '', '/video/BVwin-check/?p=2')`);
    const sessionAfter = await waitForState(
      sessionProbe,
      (value) => typeof value === 'string' && value !== sessionBefore ? true : `session ${JSON.stringify(value)}`,
      { what: 'content-side session rotation after the ?p=2 navigation' },
    );
    const partShown = await waitForState(
      readState,
      (state) => honestVideoLayout(state) ? true : 'expected the popup to stay truthful across the part navigation',
      { what: 'open popup across the ?p=2 part navigation' },
    );
    assert.equal(partShown.ownActiveTabIds[0], world.videoTabId, JSON.stringify(partShown));
    markScenario('同文档切分 P（?p=2，不重载）：内容侧换新记录，弹窗如实跟随不闪未运行');

    // 落库的两条记录各就各位：旧记录不带 part，新记录 part 为 2 且 pathname 干净
    // （隐私契约：query 全剥，只留分 P 一个字段）。从 launcher 扩展页直读扩展自己的
    // IndexedDB，schema 与播种组同形、缺时才建。
    const readSessionRecord = (sessionId) => driver.evaluate(launcher, `(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(${JSON.stringify(SCALE_DB_NAME)}, 1);
        request.onerror = () => reject(request.error || new Error('session read db open failed'));
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
      const record = await new Promise((resolve, reject) => {
        const transaction = database.transaction(${JSON.stringify(SESSION_STORE)}, 'readonly');
        const request = transaction.objectStore(${JSON.stringify(SESSION_STORE)}).get(${JSON.stringify(sessionId)});
        request.onerror = () => reject(request.error || new Error('session get failed'));
        request.onsuccess = () => resolve(request.result ?? null);
      });
      database.close();
      return record;
    })()`);
    const recordAfter = await waitForState(
      () => readSessionRecord(sessionAfter),
      (record) => record !== null && record.part === '2'
        ? true
        : `rotated record ${JSON.stringify(record)}`,
      { what: 'rotated session record persisted with part 2' },
    );
    assert.equal(recordAfter.routeKind, 'video', JSON.stringify(recordAfter));
    assert.equal(recordAfter.bvid, 'BVwin-check', JSON.stringify(recordAfter));
    assert.equal(recordAfter.pathname, '/video/BVwin-check/', JSON.stringify(recordAfter));
    const recordBefore = await readSessionRecord(sessionBefore);
    assert.ok(recordBefore !== null, '原记录应当已落库');
    assert.equal('part' in recordBefore, false, JSON.stringify(recordBefore));
    markScenario('分 P 换记录后落库各就各位：新记录 part 为 2，旧记录无 part，pathname 不受 query 污染');

    // 弹窗的「打开开发日志」在点击时重新询问内容侧：换分 P 后入口指向新记录。
    await driver.evaluate(popupSession, `document.querySelector('[data-open-logs]').click()`);
    const [partLogsTarget] = await waitForState(
      async () => (await driver.targets())
        .filter((info) => info.type === 'page' && info.url.startsWith(`${logsPagePrefix}#sessionId=`)),
      (candidates) => candidates.length === 1 ? true : `expected 1 popup-opened logs page, got ${candidates.length}`,
      { what: 'popup-opened logs page after the part navigation' },
    );
    assert.equal(partLogsTarget.url, `${logsPagePrefix}#sessionId=${sessionAfter}`,
      '弹窗的日志入口必须指向分 P 导航后的新记录');
    markScenario('分 P 换记录后：弹窗日志入口指向新 session');

    // 关掉弹出的日志页，活动标签页回到视频页，弹窗面板恢复。
    await driver.evaluate(launcher, `(async () => {
      const me = await chrome.tabs.getCurrent();
      const active = await chrome.tabs.query({ active: true, windowId: me.windowId });
      if (active.length !== 1 || active[0].id === me.id
        || active[0].id === ${world.videoTabId} || active[0].id === ${world.popupTabId}) {
        throw new Error('expected the popup-opened logs page to be the only active tab');
      }
      await chrome.tabs.remove(active[0].id);
      await chrome.tabs.update(${world.videoTabId}, { active: true });
    })()`);
    await waitForState(
      readState,
      (state) => honestVideoLayout(state) ? true : 'expected the popup to recover after its logs page was closed',
      { what: 'popup recovery after the popup-opened logs page closes' },
    );

    // 控制台通道的阳性对照 + 全组零预期外错误。
    await driver.evaluate(popupSession, `console.error('[BilibiliBuffer] win-check-f 控制台探针 win-check-f-probe')`);
    await waitForState(
      () => Promise.resolve(consoleErrors.length),
      () => (consoleErrors.some((entry) => entry.text.includes('win-check-f-probe'))
        ? true
        : 'console probe not captured'),
      { what: 'popup console positive control' },
    );
    const unexpected = consoleErrors.filter((entry) => !entry.text.includes('win-check-f-probe'));
    assert.deepEqual(unexpected, [], `本组场景出现预期之外的弹窗错误 ${JSON.stringify(unexpected)}`);
    markScenario('分 P 组全组弹窗控制台零扩展错误（阳性对照通过）');
  } finally {
    await cleanup();
  }
}

// ---- 第八组：扩展更新前打开的日志页（见文件头说明）----

async function runStaleLogsPack() {
  const { driver, cleanup } = await setupBrowser('popup-window-check-g-');
  try {
    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const logsPagePrefix = `chrome-extension://${extensionId}/logs.html`;
    const launcher = await openLauncher(driver, extensionId);
    const world = await driver.evaluate(launcher, `(async () => {
      const tab = await chrome.tabs.create({ url: ${JSON.stringify(VIDEO_URL)}, active: true });
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          const response = await chrome.tabs.sendMessage(tab.id, { version: ${STATUS_MESSAGE_VERSION}, type: 'diagnostics:session-id:get' });
          if (typeof response.sessionId === 'string') return { videoTabId: tab.id, sessionId: response.sessionId };
        } catch (error) {
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      throw new Error('video tab content script never answered');
    })()`);
    console.log('stale-logs world:', JSON.stringify(world));

    const hashedLogsUrl = `${logsPagePrefix}#sessionId=${encodeURIComponent(world.sessionId)}`;
    const openLogsPage = async () => {
      const { targetId } = await driver.send('Target.createTarget', { url: hashedLogsUrl });
      return driver.attach(targetId);
    };
    const readCdnPanel = (session) => driver.evaluate(session, `(() => {
      const filter = document.querySelector('[data-session-filter]');
      const button = document.querySelector('[data-cdn-refresh]');
      const status = document.querySelector('[data-cdn-status]');
      if (filter === null || button === null || status === null) return null;
      return { filterValue: filter.value, buttonDisabled: button.disabled, status: status.textContent };
    })()`);
    const logsPageTargets = async () => (await driver.targets())
      .filter((info) => info.type === 'page' && info.url.startsWith(logsPagePrefix));

    const preUpdateLogs = await openLogsPage();
    // 更新前：当前 session 能读，先读成功一次作基线。
    await waitForState(
      () => readCdnPanel(preUpdateLogs),
      (state) => state !== null && state.filterValue === 'current' && state.buttonDisabled === false
        ? true
        : `unexpected CDN panel state ${JSON.stringify(state)}`,
      { what: 'CDN panel ready on the pre-update logs page' },
    );
    await driver.evaluate(preUpdateLogs, `document.querySelector('[data-cdn-refresh]').click()`);
    await waitForState(
      () => readCdnPanel(preUpdateLogs),
      (state) => state !== null && state.status.startsWith('读取完成')
        ? true
        : `unexpected CDN status ${JSON.stringify(state)}`,
      { what: 'CDN read succeeds on the logs page before the update' },
    );
    const logsTargetsBefore = (await logsPageTargets()).length;
    assert.equal(logsTargetsBefore, 2, `重载前应有 launcher 与带 hash 两个日志页，实为 ${logsTargetsBefore}`);
    markScenario('扩展更新前：日志页当前 session 读取成功（基线）');

    // 商店自动更新的形状：同一播放源重载（扩展 id 不变）。重载会关掉扩展自己的
    // 页面：launcher 与带 hash 的日志页标签一并消失，没有失效页面留下来说错话；
    // 内容标签页（视频页）保留。
    const { id: reloadedId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    assert.equal(reloadedId, extensionId, '同一播放源重载后扩展 id 不变');
    const survivors = await waitForState(
      async () => {
        const targets = await driver.targets();
        return {
          logsPages: targets.filter((info) => info.type === 'page' && info.url.startsWith(logsPagePrefix)).length,
          videoPages: targets.filter((info) => info.type === 'page' && info.url.startsWith(VIDEO_URL)).length,
        };
      },
      (state) => state.logsPages === 0 && state.videoPages === 1
        ? true
        : `unexpected target map ${JSON.stringify(state)}`,
      { what: 'pre-update extension pages torn down by the reload' },
    );
    console.log('post-reload target map:', JSON.stringify(survivors));
    markScenario('扩展重载后：更新前打开的日志页标签被关闭，没有失效页面留下，内容标签页保留');

    // 重载后重开日志页属于新上下文：读同一 session 照常成功（库与记录不受重载影响）。
    const freshSession = await openLogsPage();
    const consoleErrors = [];
    driver.on('Runtime.consoleAPICalled', (message) => {
      if (message.sessionId !== freshSession || message.params.type !== 'error') return;
      const text = (message.params.args || [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      consoleErrors.push({ kind: 'console', text });
    });
    driver.on('Runtime.exceptionThrown', (message) => {
      if (message.sessionId !== freshSession) return;
      const details = message.params.exceptionDetails ?? {};
      consoleErrors.push({ kind: 'exception', text: details.exception?.description ?? details.text ?? '' });
    });
    await waitForState(
      () => readCdnPanel(freshSession),
      (state) => state !== null && state.filterValue === 'current' && state.buttonDisabled === false
        ? true
        : `unexpected CDN panel state ${JSON.stringify(state)}`,
      { what: 'CDN panel ready on the post-update logs page' },
    );
    await driver.evaluate(freshSession, `document.querySelector('[data-cdn-refresh]').click()`);
    await waitForState(
      () => readCdnPanel(freshSession),
      (state) => state !== null && state.status.startsWith('读取完成')
        ? true
        : `unexpected CDN status ${JSON.stringify(state)}`,
      { what: 'CDN read succeeds on the post-update logs page' },
    );
    markScenario('扩展更新后重开日志页读同一 session 照常成功');

    // 控制台通道的阳性对照 + 全组零预期外错误。
    await driver.evaluate(freshSession, `console.error('[BilibiliBuffer] win-check-g 控制台探针 win-check-g-probe')`);
    await waitForState(
      () => Promise.resolve(consoleErrors.length),
      () => (consoleErrors.some((entry) => entry.text.includes('win-check-g-probe'))
        ? true
        : 'console probe not captured'),
      { what: 'post-update logs console positive control' },
    );
    const unexpected = consoleErrors.filter((entry) => !entry.text.includes('win-check-g-probe'));
    assert.deepEqual(unexpected, [], `本组场景出现预期之外的控制台错误 ${JSON.stringify(unexpected)}`);
    markScenario('更新前后日志页组全组零预期外错误（阳性对照通过）');
  } finally {
    await cleanup();
  }
}

// ---- 第九组：直播接管四态的弹窗填数与线路卡镜像行（见文件头说明） ----

async function runLiveTakeoverStatesPack() {
  const { driver, cleanup } = await setupBrowser('popup-window-check-e-');
  try {
    const { id: extensionId } = await driver.send('Extensions.loadUnpacked', { path: extensionDirectory });
    const popupUrl = `chrome-extension://${extensionId}/popup.html`;
    const launcher = await openLauncher(driver, extensionId);
    // 弹窗 tab 与直播 tab 同窗口（第五组同手法）：面板只报告自己窗口的活动标签页。
    const world = await driver.evaluate(launcher, `(async () => {
      const popupTab = await chrome.tabs.create({ url: ${JSON.stringify(popupUrl)}, active: false });
      return { windowId: popupTab.windowId };
    })()`);
    console.log('live-takeover world:', JSON.stringify(world));
    const activateLiveTab = (url) => driver.evaluate(launcher, `(async () => {
      const tab = await chrome.tabs.create({ url: ${JSON.stringify(url)}, windowId: ${world.windowId}, active: true });
      return tab.id;
    })()`);
    // 该标签页 session 落库的全部 live.flv.backup 事件（state 与 reason），走生产读取路径。
    const flvBackupEvents = (tabId) => driver.evaluate(launcher, `(async () => {
      const send = (message) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError !== undefined) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(response);
        });
      });
      const probe = await chrome.tabs.sendMessage(
        ${tabId},
        { version: ${STATUS_MESSAGE_VERSION}, type: 'diagnostics:session-id:get' },
      );
      if (probe?.ok !== true || typeof probe.sessionId !== 'string') {
        throw new Error('live session id probe failed: ' + JSON.stringify(probe));
      }
      const snapshot = await send({ version: 1, type: 'logs:max-event-id' });
      if (snapshot?.ok !== true) throw new Error('log snapshot was rejected');
      const found = [];
      let afterSequence = 0;
      for (;;) {
        const page = await send({
          version: 1, type: 'logs:session-events-page', sessionId: probe.sessionId,
          limit: 250, afterSequence, maxEventId: snapshot.maxEventId,
        });
        if (page?.ok !== true) throw new Error('session event page was rejected');
        for (const event of page.events) {
          if (event.code === 'live.flv.backup') found.push({ state: event.data.state, reason: event.data.reason });
        }
        if (!page.hasMore) return found;
        afterSequence = page.nextAfterSequence;
      }
    })()`);
    const readState = await popupStateReader(driver, popupUrl);
    const popupTarget = await driver.findPageByUrl(popupUrl);
    const popupSession = await driver.attach(popupTarget.targetId);
    const popupErrors = [];
    driver.on('Runtime.consoleAPICalled', (message) => {
      if (message.sessionId !== popupSession || message.params.type !== 'error') return;
      const text = (message.params.args || [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      popupErrors.push({ kind: 'console', text });
    });
    driver.on('Runtime.exceptionThrown', (message) => {
      if (message.sessionId !== popupSession) return;
      const details = message.params.exceptionDetails ?? {};
      popupErrors.push({ kind: 'exception', text: details.exception?.description ?? details.text ?? '' });
    });

    // 期望值全部从 src 的既有导出推导：liveTakeoverText 的事实折叠、cdnLinesView
    // 的空态、shortMirrorName 的线路短名。本组检查装配出来的面板，不是文案字面。
    // FLV 后备状态按各房间的地址簿推出（src/bank/main.js 的 flvBackupUrlsFor）：竞速与
    // 失败房间的内嵌 playinfo 只有本流目录的 .m3u8 条目、没有同流名的 .flv 条目，首个
    // .m4s 请求记一次 unavailable/no_flv_entry；单路房间没有地址簿（无内嵌 playinfo，
    // 也没有 getRoomPlayInfo 流量），记一次 unavailable/no_hls_entry；只拉播放列表的房间
    // 没有 .m4s 请求，后备从不打开，也没有 live.flv.backup 事件。
    const liveEnabledOn = { liveEnabled: true };
    const noFlvEntry = [{ state: 'unavailable', reason: 'no_flv_entry' }];
    const noHlsEntry = [{ state: 'unavailable', reason: 'no_hls_entry' }];
    const raceText = liveTakeoverText(
      { serveCount: 1, engagement: 'engaged', pairedAddressAvailable: true, pairRejected: false, flvBackup: 'unavailable' },
      liveEnabledOn,
    );
    const singleText = liveTakeoverText(
      { serveCount: 1, engagement: 'engaged', pairedAddressAvailable: false, pairRejected: false, flvBackup: 'unavailable' },
      liveEnabledOn,
    );
    const unhandledText = liveTakeoverText(
      { serveCount: 1, engagement: undefined, pairedAddressAvailable: false, pairRejected: false, flvBackup: undefined },
      liveEnabledOn,
    );
    const failedText = liveTakeoverText(
      { serveCount: 1, engagement: 'failed', pairedAddressAvailable: false, pairRejected: false, flvBackup: 'unavailable' },
      liveEnabledOn,
    );
    const emptyLinesMessage = cdnLinesView({ sampleCount: 0, summary: { rows: [] } }, undefined, false).message;
    const nameA = shortMirrorName('e2e-live.bilivideo.com');
    const nameB = shortMirrorName('e2e-live-b.bilivideo.com');
    const countMatches = (text, pattern) => (text.match(pattern) ?? []).length;

    // 竞速：内嵌 playinfo 给出双镜像地址簿，首段身份门比过（字节确定性一致）后放开
    // 竞速。接管行如实报双镜像竞速与无 FLV 后备；线路卡两行镜像如实报正常与连接时间，
    // 不出现 NaN。
    const raceTabId = await activateLiveTab(LIVE_RACE_URL);
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.livePanelHidden === false && state.bufferCardHidden === true
        && state.takeover === raceText
        && state.cdnCard.includes(nameA) && state.cdnCard.includes(nameB)
        && countMatches(state.cdnCard, /正常/g) === 2
        && countMatches(state.cdnCard, /通常 \d+ 毫秒/g) === 2
        && !state.cdnCard.includes('NaN')
        ? true
        : `expected the racing takeover state, got takeover=${JSON.stringify(state.takeover)} cdn=${JSON.stringify(state.cdnCard)}`,
      { timeoutMs: 30000, what: 'popup showing live racing takeover' },
    );
    assert.deepEqual(await flvBackupEvents(raceTabId), noFlvEntry, '竞速房间的 FLV 后备事件与地址簿不符');
    markScenario('直播接管竞速中：弹窗接管行如实报双镜像竞速与无 FLV 后备（no_flv_entry），线路卡两行镜像如实报健康状况与连接时间');

    // 单路：无地址簿，只有播放器所名地址，接管行如实报无可用备用线路与无 FLV 后备，
    // 线路卡只有一行。
    const singleTabId = await activateLiveTab(LIVE_SINGLE_URL);
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.livePanelHidden === false && state.bufferCardHidden === true
        && state.takeover === singleText
        && state.cdnCard.includes(nameA) && !state.cdnCard.includes(nameB)
        && countMatches(state.cdnCard, /正常/g) === 1
        && !state.cdnCard.includes('NaN')
        ? true
        : `expected the single-leg takeover state, got takeover=${JSON.stringify(state.takeover)} cdn=${JSON.stringify(state.cdnCard)}`,
      { timeoutMs: 30000, what: 'popup showing single-leg live takeover' },
    );
    assert.deepEqual(await flvBackupEvents(singleTabId), noHlsEntry, '单路房间的 FLV 后备事件与地址簿不符');
    markScenario('直播单路接管：弹窗接管行如实报无可用备用线路与无 FLV 后备（no_hls_entry），线路卡一行镜像如实');

    // 只拉播放列表：接管从未介入（只有 pass 事实），如实报未接管，线路卡如实报还没有数据。
    const playlistTabId = await activateLiveTab(LIVE_PLAYLIST_URL);
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.livePanelHidden === false && state.bufferCardHidden === true
        && state.takeover === unhandledText
        && state.cdnCard === emptyLinesMessage
        ? true
        : `expected the playlist-only state, got takeover=${JSON.stringify(state.takeover)} cdn=${JSON.stringify(state.cdnCard)}`,
      { timeoutMs: 30000, what: 'popup showing playlist-only live page' },
    );
    assert.deepEqual(await flvBackupEvents(playlistTabId), [], '只拉播放列表的房间不该打开 FLV 后备');
    markScenario('直播页面只拉播放列表：弹窗接管行如实报未接管，线路卡如实报还没有数据，FLV 后备从未打开');

    // 镜像全灭：两条腿的 502 如实落到面板（接管请求失败、线路卡有错误），页面控制台
    // 按既有口径全量如实报错，这份报错同时充当了本组捕获通道的阳性对照。
    const failTabId = await activateLiveTab(LIVE_FAIL_URL);
    const failTarget = await driver.findPageByUrl(LIVE_FAIL_URL);
    const failSession = await driver.attach(failTarget.targetId);
    const livePageErrors = [];
    driver.on('Runtime.consoleAPICalled', (message) => {
      if (message.sessionId !== failSession || message.params.type !== 'error') return;
      const text = (message.params.args || [])
        .map((arg) => arg.value ?? arg.description ?? '')
        .join(' ');
      livePageErrors.push({ kind: 'console', text });
    });
    driver.on('Runtime.exceptionThrown', (message) => {
      if (message.sessionId !== failSession) return;
      const details = message.params.exceptionDetails ?? {};
      livePageErrors.push({ kind: 'exception', text: details.exception?.description ?? details.text ?? '' });
    });
    await waitForState(
      readState,
      (state) => state.ready === 'true' && state.noPage === false && state.notice === ''
        && state.livePanelHidden === false && state.bufferCardHidden === true
        && state.takeover === failedText
        && countMatches(state.cdnCard, /有错误/g) === 2
        && state.cdnCard.includes('还没有连接记录')
        && !state.cdnCard.includes('NaN')
        ? true
        : `expected the failed takeover state, got takeover=${JSON.stringify(state.takeover)} cdn=${JSON.stringify(state.cdnCard)}`,
      { timeoutMs: 30000, what: 'popup showing failed live takeover' },
    );
    assert.deepEqual(await flvBackupEvents(failTabId), noFlvEntry, '失败房间的 FLV 后备事件与地址簿不符');
    markScenario('直播镜像全灭接管失败：弹窗接管行如实报接管请求失败，线路卡两行如实报有错误');
    await waitForState(
      () => Promise.resolve(livePageErrors),
      (errors) => errors.some((entry) => entry.text.includes('媒体分片前台取数失败') || entry.text.includes('BankNetworkError'))
        ? true
        : `no honest live failure error captured yet: ${JSON.stringify(errors)}`,
      { timeoutMs: 15000, what: 'honest full-rate live failure errors in the page console' },
    );
    assert.deepEqual(popupErrors, [], `直播组弹窗控制台出现预期外的扩展错误 ${JSON.stringify(popupErrors)}`);
    markScenario('直播接管失败如实报到页面控制台（阳性对照），全组弹窗控制台零预期外扩展错误');
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
  fixtures: { video: VIDEO_URL, live: LIVE_URL, liveUpdate: LIVE_UPDATE_URL, other: OTHER_URL, nomedia: HOME_URL, liveMedia: LIVE_MEDIA_ORIGINS },
}));

await runMultiWindowPack();
await runPreExistingPagePack();
await runSwitchPack();
await runUpdateMidPlaybackPack();
await runLiveUpdateMidStreamPack();
await runNoMediaPagePack();
await runLogScalePack();
await runPartNavigationPack();
await runStaleLogsPack();
await runLiveTakeoverStatesPack();

console.log(`popup window check passed: ${scenarios.length} scenarios`);
for (const scenario of scenarios) console.log(`- ${scenario}`);
