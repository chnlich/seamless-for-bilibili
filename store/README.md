# 上架材料说明（先读这页）

Chrome Web Store 提交所需要的、不依赖新 popup 的内容都在这里：图标、隐私政策、双语商店草稿、打包命令。本目录不做任何提交动作；上传与提交由用户完成。

- 商店草稿：[listing.zh-CN.md](listing.zh-CN.md)（默认列表语言）、[listing.en.md](listing.en.md)（未来 `_locales` 英文列表）
- 隐私政策：仓库根目录 [PRIVACY.md](../PRIVACY.md)（双语；商店后台填它的 main 分支 URL）
- 图标源文件：[assets/icon.svg](../assets/icon.svg)，`npm run icons` 重新生成 PNG（128 保留 16px 透明边作商店图标；16/32/48 取 96×96 图形区铺满画布，保证工具栏 16px 下可辨认；已提交到 `src/extension/icons/`，构建会复制进 `dist/extension/`）
- 打包：`npm run package` → 构建 + 合同测试 → `release/smooth-bilibili-chrome-plugin-<版本>.zip`（`release/` 已加入 .gitignore）

## 名称决定（用户决定，本任务未改名）

现状「Bilibili 桌面网页抗卡」把第三方品牌放在名称主位。商店《冒充与知识产权》政策要求不得表示商品由他人授权、认可或出品，不得侵犯商标权，并写明“若认为商品可能侵犯知识产权，其可见度可能受影响”；计划政策另规定标题含误导信息的商品可被移除。品牌词放在主位容易被读成官方出品，保留现名的风险是：Bilibili 的商标投诉、审核拒绝，或上架后降低可见度乃至下架。另外「桌面网页」含义不明。

Chrome 的品牌规范对 Google 商标规定用“for …”（如 “for Google Chrome™”）指称兼容对象；这里类比采用同一模式指称 Bilibili。候选（zh ↔ en 同步）：

| 候选 | zh | en | 一句话点评 |
|---|---|---|---|
| 1（推荐） | 视频抗卡 for Bilibili | Anti-Stutter for Bilibili | 功能词在前、品牌以“for”指称，最稳妥；沿用已有的“抗卡”说法，覆盖视频与直播 |
| 2 | 流畅播放 for Bilibili | Smooth Playback for Bilibili | 强调体验结果，弱化技术机制 |
| 3 | 双线下载 for Bilibili | Dual-Mirror Download for Bilibili | 直接说出机制（两个镜像同时下载），对在意流量的用户最透明 |

风险对照：保留现名 → 上述商标投诉/拒审/下架风险；改用 “for Bilibili” 结构 → 风险低，属指称性使用，但名称仍含对方商标，配合详细说明首段的免责声明（无隶属、非官方）。

改名需要改 manifest `name`（以及同样带品牌的 `action.default_title`「Bilibili 抗卡设置」）并发新版本，PRIVACY.md 首行的适用名称随之更新；本任务未执行。中英文名在草稿中已按候选 1 预填，用户拍板后替换。

## 提交步骤（复制粘贴流程）

1. 注册开发者账号并支付一次性注册费（https://developer.chrome.com/docs/webstore/register ）。
2. 确认 PRIVACY.md 当前版本已在 main 分支（隐私政策 URL 用户可见；仓库是公开仓库，Issues 已开启）。
3. `npm run package` 生成 zip。
4. 后台 Items → New item，上传 zip。
5. Store listing 标签页：按 listing.zh-CN.md 逐字段粘贴；上传商店图标与图片（图标、小型宣传图、marquee、机制示意图已就绪；弹窗截图待重摄，见 [images/](images/README.md)）。
6. Privacy practices 标签页：单一用途、逐项权限用途说明、远程代码选“否”、数据使用勾选与认证、隐私政策 URL。
7. Test instructions 标签页留空；Distribution 标签页：公开、全部地区。
8. Submit for review。若审查要求补充源码，提供仓库 zip；发布 bundle 未压缩且带 source map。

## unlimitedStorage 说明（诚实口径，按 3 天保留窗口写）

开发诊断日志按 GOAL.md 设计**只保留最近 3 天（72 小时）**：超过 72 小时的记录按其自身时间自动删除；窗口内的日志只追加、不压缩、不摘要、不设条数或容量上限。`unlimitedStorage` 移除浏览器默认配额，使 3 天窗口内的日志能连续写入而不因配额失败；后台答复与 PRIVACY.md 已如实写明“只保留 3 天、超期自动删除、仅在本机、卸载删除”。

**增长速度（实测，不是估算；用于估算 3 天窗口的占用上界）**：对开发者日常浏览器 profile 的日志库做只读离线解码（按 smooth-bilibili-plugin 技能的离线解码配方，复制后解码全部 349 个 LevelDB 文件）：

| 量 | 值 |
|---|---|
| 库在磁盘上的大小 | 453 MB |
| 覆盖时间 | 2026-09-18 至 2026-09-28，约 9.7 天；584 个 session，183 万条事件 |
| `media.sample`（1 Hz，只在视频路由挂着 video 元素时采样，暂停/后台也计） | 226,214 条 ≈ 62.8 小时视频页打开时长 |
| 磁盘增长 | 约 **7.2 MB / 视频页打开小时**（453 MB ÷ 62.8 h，含 LevelDB 与索引开销） |
| 导出 JSONL 体积 | 约 19 MB / 小时（事件 JSON 合计 1.22 GB ÷ 62.8 h） |
| 这个 profile 的实际速度 | 约 47 MB/天（453 MB ÷ 9.7 天），折合每月约 1.4 GB |

按事件 JSON 体积拆分：`media.append` 35%（每秒约 4.1 条，每条约 450 B）、`media.sample` 34%（每条约 1.8 KB：完整 buffered/seekable/分轨区间加 `frameTiming`）、`bank.serve` 13%（每秒约 1.9 条）、`media.progress` 7%、`bank.inventory` 7%。每条 `media.*` 事件都附带同样的媒体快照，所以单条就在 1.8 KB 左右。

**保留策略（用户已决定）**：

- 正式版采用 3 天（72 小时）保留：超期记录自动删除，不再无限增长。按实测速度，日志占用大致以最近 3 天的用量为上界（重度使用约数百 MB 量级）。该决定已落进 GOAL.md、PRIVACY.md 与两份商店草稿。
- 审查风险：`unlimitedStorage` 不触发安装警告，但审查员可能追问一个“减少卡顿”的扩展为何需要无限存储；答复口径就是上面的“只保留 3 天、超期自动删除 + 只在本机 + 卸载删除”。日志不上传，审查员看不到日志内容；若审查仍认为与单一用途不符，再评估去掉该权限。

## 待用户决定的其他事项

- 数据使用勾选：草稿建议勾选「网页历史」「用户活动」「网站内容」三项。「用户活动」的商店定义第一项就是“网络监控”，日志记录播放器每个媒体请求的耗时与结果、以及播放/暂停/拖动/倍速/音量事件，不勾会与实际行为矛盾（计划政策：隐私字段与扩展行为矛盾可被下架）。「网站内容」若只按“持久化才算收集”理解可不勾，但须与 PRIVACY.md 一致。
- 类别：建议 Entertainment（旧 Productivity 大类 2023 年已拆分），备选 Tools。
- 名称：见上表。
- 图片：商店图标已完成；440×280 小宣传图、1400×560 Marquee 已完成。**弹窗截图待重摄**：screenshot-01-popup-video.png 与 screenshot-02-popup-live.png 拍摄的是旧的单开关弹窗，popup 现在有两个常驻开关，需在 popup 改名任务中重摄（to recapture: popup now has two switches）；机制示意图 screenshot-03-racing-diagram.png 已随 3 天保留规则更新。
