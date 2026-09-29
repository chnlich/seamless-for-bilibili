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
   npm ci && npm run build && npm run capture:store-images -- --headed
   ```

   脚本在 `scripts/capture-store-images.mjs`：在 Windows 上用系统 Chrome（`BILIBILI_E2E_CHROME` 指定路径）
   起一个临时专用 profile，打开一个冷门视频与一个直播间，等真实读数出现（视频页缓冲条到达 120 秒目标、
   两张线路卡都带连接时间；直播页出现「正在按两条线路竞速下载」），用 `chrome.action.openPopup()` 打开真实弹窗，
   捕获明暗两态（暗色经 `prefers-color-scheme` 模拟）与弹窗背后的页面，写出上表输入
   `video-popup-light.png`、`live-popup-light.png`、`video-page.png`、`live-page.png` 与 `report.json`
   （含 commit、buildId、Chrome 版本、视频与房间号、直播格式 FLV/HLS、明暗两态弹窗读数）。
   读数迟迟不出现就报错退出，绝不静默截一张空弹窗；`--headed` 必须显式带上（不带则 headless 的虚拟屏幕装不下弹窗，见下方教训）；弹窗截图前断言弹窗视口装下整个文档，写出后再解码 PNG
   断言「打开开发日志」区域有墨迹，任一不满足即报错退出；测试浏览器只按 PID 结束（其命令行含本次临时 profile 路径）。
2. `node store/images/src/compose.mjs` → 弹窗特写按原始捕获的完整尺寸原样导出（不做裁切），并渲染上表全部 PNG。
   每张图渲染前自检：弹窗、说明语和文字块不出画，说明语不压弹窗，标题只在词边界换行，背景页面截图必须加载成功；任一不满足即报错退出。
3. 文案修改直接改 `src/*.html`（截图说明语在 HTML 里；直播说明语按 `report.json` 的实际接管状态插值到渲染页面，源文件不改）。

## 捕获来源（2026-09-29 第五次）

- commit `1bd14a00945c3e3120cfd1a73f6b2878c84f13d4`，buildId `src-ea4c271a08046814f82bff50`（与 `report.json`
  的 `provenance` 一致，随捕获自动写入）；Chrome 154.0.8037.57（系统 Chrome，Windows），`--headed` 可见窗口模式，
  临时专用 profile，未登录，`--force-device-scale-factor=2`，浏览器窗口顶到屏幕上沿（`--window-position=0,0`）。
- 视频：BV1esa36qEbN（播放量 < 10 的冷门视频），缓冲 125 秒 / 目标 120 秒已生效，两条线路卡均正常且带连接时间；
  直播：房间 1746709913（赛事房 6 仍是特殊直播形态、顶层文档等不到 video 元素，31368705 同样等不到；直播列表 API
  被风控（-352），按要求最少请求改为打开直播分区页取候选房间再逐个验证顶层播放器；按 `BILIBILI_STORE_LIVE_URL`
  覆盖到这个普通在播房间），播放器走 FLV（gotcha07 与 gotcha07b 两路竞速，`report.json` 的 `liveFormat` 为
  `FLV`），弹窗显示「正在按两条线路竞速下载」。
- 本次有一次废跑：视频弹窗的线路卡出现瞬时「有错误」健康词（红色），按「特写不得带红色健康像素」的标准整组
  重拍；上图这组四张线路卡健康词均为「正常」（绿色）。
- 捕获即验证：弹窗读数（双开关、缓冲条、120 秒申请状态、线路健康词与连接时间、直播接管行）来自真实运行，
  深色模式经 `prefers-color-scheme` 模拟逐像素核对（健康词整词着色，无半色缺陷；两路健康词均为「正常」，
  无红色健康像素）。
- 弹窗完整性的教训与自检：2× 缩放把 Chrome 感知到的屏幕减半（1920×1080 读作 960×540、可用 516），浏览器窗口
  在 y=40 时弹窗锚点落在屏幕 y≈116，Chrome 把弹窗窗口钳到 396 CSS px 而文档高 435，日志链接（y 400.5-423）
  落在未绘制区，第二次捕获的特写里因此是一段空白；窗口顶到 y=0 后锚点升到 y≈76，弹窗窗口装下整个文档。
  `--headless` 的虚拟屏幕约 800×600（物理），2× 缩放下 CSS 高只有 300，弹窗窗口同样装不下 435 高的文档，
  因此捕获只能在 `--headed` 的真实屏幕上跑（脚本对装不下直接报错退出，不会产出被裁的图）。
  每张弹窗截图写出的 PNG 都会解码并断言链接区域有墨迹（对照：第二次的视频弹窗该区域 0 个墨迹像素，本次
  1612 个，与直播弹窗一致），视口与文档尺寸连同链接坐标写入 `report.json` 供复核。
