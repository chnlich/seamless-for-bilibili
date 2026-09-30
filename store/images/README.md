# 商店图片（Chrome Web Store 上传件）

全部图片由 `src/` 里的源文件再生：HTML/SVG 排版 + `compose.mjs` 渲染（需要 Node 与系统 Chrome，
`BILIBILI_E2E_CHROME` 指定可执行文件；渲染不需要 Playwright 浏览器下载）。

| 文件 | 尺寸 | 内容 |
|---|---|---|
| `screenshot-01-popup-video.png` | 1280×800 | 视频页上的真实弹窗（背景为真实页面截图，整体模糊以隐藏第三方内容） |
| `screenshot-02-popup-live.png` | 1280×800 | 直播页上的真实弹窗（同上） |
| `screenshot-03-racing-diagram.png` | 1280×800 | 机制示意图：双镜像竞速、120 秒缓冲、流量代价 |
| `promo-tile-440x280.png` | 440×280 | 小型宣传图（必需项） |
| `marquee-1400x560.png` | 1400×560 | Marquee 宣传图（可选项） |
| `popup-video.png` / `popup-live.png` | 744×870 / 744×758 | 弹窗特写原图（README 复用；2× 设备像素，完整弹窗：标题行双开关、全部卡片、日志链接都在画内） |

## 再生步骤

1. 用捕获脚本得到原始截图到仓库根的 `store-images-raw/`（不提交，已在仓库 .gitignore 中忽略：页面截图含第三方内容）：

   ```sh
   npm ci && npm run build && npm run capture:store-images
   ```

   脚本在 `scripts/capture-store-images.mjs`：在 Windows 上用系统 Chrome（`BILIBILI_E2E_CHROME` 指定路径）
   起一个临时专用 profile，打开一个冷门视频与一个直播间，等真实读数出现（视频页缓冲条到达 120 秒目标、
   两张线路卡都带连接时间；直播页出现「正在按两条线路竞速下载」），用 `chrome.action.openPopup()` 打开真实弹窗，
   捕获明暗两态（暗色经 `prefers-color-scheme` 模拟）与弹窗背后的页面，写出上表输入
   `video-popup-light.png`、`live-popup-light.png`、`video-page.png`、`live-page.png` 与 `report.json`
   （含 commit、buildId、Chrome 版本、视频与房间号、直播格式 FLV/HLS、明暗两态弹窗读数）。
   读数迟迟不出现就报错退出，绝不静默截一张空弹窗。默认无窗口运行（完整 Chrome 的 `--headless`），不再需要 `--headed`：headless 的虚拟屏幕默认 800×600 设备像素，2× 缩放下只剩 400×300 CSS px，弹窗锚在 y=76 处被钳到 220 CSS px 视口；脚本加 `--screen-info={0,0 3840x2400}` 后实测（Chrome 154）可用屏幕为 1920×1200 CSS px，同一弹窗长到 Chrome 自身 600 CSS px 的弹窗高度上限，高于视频弹窗 435 CSS px 的文档；启动后先读 `screen.availWidth`/`availHeight` 断言该开关生效。弹窗截图前断言弹窗视口装下整个文档，写出后再解码 PNG
   断言「打开开发日志」区域有墨迹，任一不满足即报错退出；测试浏览器只按 PID 结束（其命令行含本次临时 profile 路径）。
2. `node store/images/src/compose.mjs` → 弹窗特写按原始捕获的完整尺寸原样导出（不做裁切），并渲染上表全部 PNG。
   每张图渲染前自检：弹窗、说明语和文字块不出画，说明语不压弹窗，标题只在词边界换行，背景页面截图必须加载成功；任一不满足即报错退出。
   WSL 上的 Linux Chromium 系统字体既无 Segoe UI 也无任何中文字体（缺字体时中文全部成空框），
   compose.mjs 在 Linux 上启动 Chrome 时经 `src/fonts.conf` 挂上 `/mnt/c/Windows/Fonts` 并优先使用
   Segoe UI 与 Microsoft YaHei，渲染与 Windows 首捕同字体；环境里已设 `FONTCONFIG_FILE` 时以环境的为准。
   另有字体自检：经 CDP 询问 Chrome 每段文字实际画在哪个字体上，出现 Segoe UI、Microsoft YaHei
   （外加示意图勾号 U+2713 回退到的 Noto Sans SC）以外的字体即判该页渲染失败退出。
3. 文案修改直接改 `src/*.html`（截图说明语在 HTML 里；直播说明语按 `report.json` 的实际接管状态插值到渲染页面，源文件不改）。

## 已提交图片的捕获来源

- commit `0fe2108deb1854b6791a1b23bc1a78e059d8895a`（工作区于 Windows scratch 按此提交内容运行，scratch 内无 git，`report.json` 的 `commitSha` 由环境变量如实记入并注明原因；`src/` 与 `dist/` 与 `6410ad6` 相同），buildId `src-320b6f176a4377a3036f5ba7`（与 `report.json` 的 `provenance` 一致，随捕获自动写入）；Chrome 154.0.8037.57（系统 Chrome，Windows），无窗口模式（`--headless`，`report.json` 的 `launchMode` 为 `spawn+connectOverCDP headless`），`--screen-info={0,0 3840x2400}`（启动后读得可用屏幕 1920×1200 CSS px），临时专用 profile，未登录，`--force-device-scale-factor=2`，`--window-position=0,0`。
- 视频：BV1zpaL6sEWj（播放量 828 的冷门视频，时长 11 分 35 秒；上一组捕获里 BV1esa36qEbN 的线路卡两次带红，故沿用上一组验证过的这个视频），缓冲 121 秒 / 目标 120 秒已生效，两条线路卡均「正常」且带连接时间（hz-mirrorakam 通常 147 毫秒、sz-mirrorcosov 通常 131 毫秒）；直播：房间 1907449398（按 `BILIBILI_STORE_LIVE_URL` 覆盖；从 live.bilibili.com/all 的房间链接里逐个探测顶层 video 选出，默认的赛事房 6 把播放器装进独立 iframe，顶层文档等不到 video 元素），播放器走 HLS（`report.json` 的 `liveFormat` 为 `HLS`），弹窗显示「正在按两条线路竞速下载」，两条线路（ov-gotcha207 与 ov-gotcha207b）均「正常」。
- 本组一次捕获即通过，无废跑；捕获期间控制台错误 0 条。弹窗读数（双开关、缓冲条、120 秒申请状态、线路健康词与连接时间、直播接管行）来自真实运行，深色模式经 `prefers-color-scheme` 模拟；两张弹窗明暗两态的四张线路卡健康词均为「正常」（`tone` 为 `ok`，健康词为绿色）。弹窗视口与文档等大（视频 372×435 CSS px、直播 372×379 CSS px，2× 设备像素即 744×870 与 744×758），链接区墨迹与上一组逐项一致（明 1612 / 暗 1623，两张弹窗同数），视口与文档尺寸连同链接坐标写入 `report.json` 供复核。
- 本组捕获时三张确定性渲染图（机制示意图、小宣传图、Marquee）与上一组逐字节一致；四张随运行取数的图（两张弹窗特写与两张 1280x800 截图）为本组新图。
- 图标换成带速度线的字母 B 后，小宣传图与 Marquee 用同一组原始捕获经 `compose.mjs` 本地重渲染（只换 `tile.html`/`marquee.html` 的图标字形，徽章样式、文字与版式不变），提交件不再与本组捕获时的像素一致；其余五张（机制示意图、两张弹窗特写、两张 1280x800 截图）仍是本组捕获的提交内容，未重捕、逐字节未动。
