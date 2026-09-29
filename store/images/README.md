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

## 已提交图片的捕获来源

- commit `6410ad6367e92159f6002f5786256ecc21ae0e86`（工作区于 Windows scratch 按此提交内容运行，scratch 内无 git，`report.json` 的 `commitSha` 由环境变量如实记入并注明原因），buildId `src-320b6f176a4377a3036f5ba7`（与 `report.json` 的 `provenance` 一致，随捕获自动写入）；Chrome 154.0.8037.57（系统 Chrome，Windows），`--headed` 可见窗口模式，临时专用 profile，未登录，`--force-device-scale-factor=2`，浏览器窗口顶到屏幕上沿（`--window-position=0,0`）。
- 视频：BV1zpaL6sEWj（播放量约 800 的冷门视频，时长 11 分 35 秒），缓冲 121 秒 / 目标 120 秒已生效，两条线路卡均「正常」且带连接时间（hz-mirrorakam 通常 149 毫秒、sz-mirrorcosov 通常 63 毫秒）；直播：房间 1907449398（按 `BILIBILI_STORE_LIVE_URL` 覆盖；房间从 live.bilibili.com/all 的房间链接里逐个探测顶层 video 选出，默认的赛事房 6 与上一组用的 1746709913 现在都把播放器装进独立 iframe，顶层文档等不到 video 元素），播放器走 HLS（`report.json` 的 `liveFormat` 为 `HLS`），弹窗显示「正在按两条线路竞速下载」，两条线路（ov-gotcha207 与 ov-gotcha207b）均「正常」。
- 本次有三次废跑，如实记录：BV1esa36qEbN 两次、BV14Pas6bEu2 一次，三次捕获的视频弹窗都有线路卡健康词带红（「有错误」或「有停滞」），未采纳。归因（无头诊断会话读扩展日志）：本轮时段冷门视频在视频镜像上的开头几个分片普遍出错（空响应、停滞、HTTP 错误），对象被读取一次后开头分片恢复，但每个对象另有个固定的镜像缺陷区间（BV1cbaG69EB9 在第 3 分片、BV1ttaE6UEjF 在第 2 分片、BV14Pas6bEu2 在第 53 分片附近，同对象跨会话逐次复现），健康词如实反映，对同一对象重拍无效。因此视频改为先探测后捕获：候选连拍两个会话（预热、正式），正式会话缓冲到达目标的窗口内两条线路零失败才进入捕获；BV1zpaL6sEWj 两个会话均零失败，正式捕获一次通过。三次废跑与全部探测都没有为「等到竞速或健康词变绿」改动扩展行为。
- 捕获即验证：弹窗读数（双开关、缓冲条、120 秒申请状态、线路健康词与连接时间、直播接管行）来自真实运行，深色模式经 `prefers-color-scheme` 模拟逐像素核对（健康词整词着色，无半色缺陷；两张弹窗四张线路卡健康词均为「正常」，弹窗特写与 1280x800 截图内的弹窗区域按像素扫描均无红色健康像素）。弹窗特写链接区墨迹与上一组逐项一致（明 1612 / 暗 1623，两张弹窗同数），视口与文档尺寸连同链接坐标写入 `report.json` 供复核。
- 三张确定性渲染图（机制示意图、小宣传图、Marquee）因标题改为海外受众与 1080p 2 倍速声明而重新渲染；四张随运行取数的图（两张弹窗特写与两张 1280x800 截图）为本组新图。弹窗完整性的屏幕钳制教训（2× 缩放下的 435 CSS px 文档高、`--headed` 必要性、窗口 y=0）见脚本内注释与自检，本轮同名通过。
