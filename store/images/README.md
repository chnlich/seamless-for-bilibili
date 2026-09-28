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
| `popup-video.png` / `popup-live.png` | 744×828 / 744×718 | 弹窗特写原图（README 复用；2× 设备像素，完整弹窗：标题行开关、全部卡片、日志链接都在画内） |

## 再生步骤

1. 用捕获脚本得到原始截图到仓库根的 `store-images-raw/`（不提交，已在仓库 .gitignore 中忽略：页面截图含第三方内容）：
   需要 `video-popup-light.png`、`live-popup-light.png`、`video-page.png`、`live-page.png` 与 `report.json`。
2. `node store/images/src/compose.mjs` → 弹窗特写按原始捕获的完整尺寸原样导出（不做裁切），并渲染上表全部 PNG。
   每张图渲染前自检：弹窗、说明语和文字块不出画，说明语不压弹窗，标题只在词边界换行，背景页面截图必须加载成功；任一不满足即报错退出。
3. 文案修改直接改 `src/*.html`（截图说明语在 HTML 里；直播说明语按 `report.json` 的实际接管状态插值到渲染页面，源文件不改）。

## 捕获来源（2026-09-28）

- commit `9b98bf2`，buildId `src-a310e6b368da2fda35983525`，Chrome 154.0.8037.57（系统 Chrome，Windows），
  临时专用 profile，未登录。
- 视频：BV1esa36qEbN（播放量 < 10 的冷门视频）；直播：房间 27632810（首页候选里第一个真实进入
  FLV 接管的房间；gotcha07/07b 两条线路配对竞速，弹窗显示“正在按两条线路竞速下载”）。
- 捕获即验证：弹窗读数（缓冲条、120 秒申请状态、线路健康词与连接时间、直播接管行）来自真实运行，
  深色模式经 `prefers-color-scheme` 模拟逐像素核对（健康词整词着色，无半色缺陷）。
