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
   读数迟迟不出现就报错退出，绝不静默截一张空弹窗；测试浏览器只按 PID 结束（其命令行含本次临时 profile 路径）。
2. `node store/images/src/compose.mjs` → 弹窗特写按原始捕获的完整尺寸原样导出（不做裁切），并渲染上表全部 PNG。
   每张图渲染前自检：弹窗、说明语和文字块不出画，说明语不压弹窗，标题只在词边界换行，背景页面截图必须加载成功；任一不满足即报错退出。
3. 文案修改直接改 `src/*.html`（截图说明语在 HTML 里；直播说明语按 `report.json` 的实际接管状态插值到渲染页面，源文件不改）。

## 捕获来源（2026-09-28 第二次）

- commit `1d18769625dbb8bd39bb1a1d66e1bd687b434613`，buildId `src-b6d327654134c77e866236ab`（与 `report.json`
  的 `provenance` 一致，随捕获自动写入）；Chrome 154.0.8037.57（系统 Chrome，Windows），临时专用 profile，
  未登录，`--force-device-scale-factor=2`。
- 视频：BV1esa36qEbN（播放量 < 10 的冷门视频），缓冲 123 秒 / 目标 120 秒已生效，两条线路卡均带连接时间；
  直播：房间 6，播放器走 HLS（fMP4 分片，gotcha207 与 gotcha207b 两路竞速，`report.json` 的 `liveFormat`
  为 `HLS`），弹窗显示「正在按两条线路竞速下载」。
- 捕获即验证：弹窗读数（双开关、缓冲条、120 秒申请状态、线路健康词与连接时间、直播接管行）来自真实运行，
  深色模式经 `prefers-color-scheme` 模拟逐像素核对（健康词整词着色，无半色缺陷）。
