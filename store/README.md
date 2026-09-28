# 上架材料说明（先读这页）

Chrome Web Store 提交所需要的、不依赖新 popup 的内容都在这里：图标、隐私政策、双语商店草稿、打包命令。本目录不做任何提交动作；上传与提交由用户完成。

- 商店草稿：[listing.zh-CN.md](listing.zh-CN.md)（默认列表语言）、[listing.en.md](listing.en.md)（未来 `_locales` 英文列表）
- 隐私政策：仓库根目录 [PRIVACY.md](../PRIVACY.md)（双语；商店后台填它的 main 分支 URL）
- 图标源文件：[assets/icon.svg](../assets/icon.svg)，`npm run icons` 重新生成 PNG（16/32/48/128，已提交到 `src/extension/icons/`，构建会复制进 `dist/extension/`）
- 打包：`npm run package` → 构建 + 合同测试 → `release/smooth-bilibili-chrome-plugin-<版本>.zip`（`release/` 已加入 .gitignore）

## 名称决定（用户决定，本任务未改名）

现状「Bilibili 桌面网页抗卡」把第三方品牌放在名称主位。商店的《冒充与知识产权》政策禁止暗示商品由他人授权、认可或出品；把品牌词放在主位容易被读成官方出品，存在被 Bilibili 商标投诉、拒绝上架或下架的风险（无需事先警告）。另外「桌面网页」含义不明。

按品牌规范中“for …”（如 “for Google Chrome™”）的指称模式，候选（zh ↔ en 同步）：

| 候选 | zh | en | 一句话点评 |
|---|---|---|---|
| 1（推荐） | 视频抗卡 for Bilibili | Anti-Stutter for Bilibili | 功能词在前、品牌以“for”指称，最稳妥；沿用已有的“抗卡”说法 |
| 2 | 流畅播放 for Bilibili | Smooth Playback for Bilibili | 强调体验结果，弱化技术机制 |
| 3 | 深缓冲播放 for Bilibili | Deep Buffer for Bilibili | 强调机制（120 秒深缓冲），对懂行用户更准确 |

风险对照：保留现名 → 冒充/商标投诉与下架风险（见上）；改用 “for Bilibili” 结构 → 风险低，属指称性使用，配合详细说明里的免责声明（无隶属、非官方）。

改名需要改 manifest `name` 并发新版本，本任务未执行；中英文名在草稿中已按候选 1 预填，用户拍板后替换。

## 提交步骤（复制粘贴流程）

1. 注册开发者账号并支付一次性注册费（https://developer.chrome.com/docs/webstore/register ）。
2. 确认 PRIVACY.md 已在 main 分支（隐私政策 URL 用户可见）。
3. `npm run package` 生成 zip。
4. 后台 Items → New item，上传 zip。
5. Store listing 标签页：按 listing.zh-CN.md 逐字段粘贴；上传商店图标；截图与宣传图待 popup 任务后补。
6. Privacy practices 标签页：单一用途、逐项权限用途说明、远程代码选“否”、数据使用勾选与认证、隐私政策 URL、支持 URL。
7. Distribution 标签页：公开、全部地区。
8. Submit for review。若审查要求补充源码（code readability），提供仓库 zip；发布 bundle 未压缩且带 source map。

## unlimitedStorage 说明（诚实口径，不改保留策略）

开发诊断日志按 GOAL.md 设计**永不轮转**：不删除、不压缩、不摘要、不设条数或容量上限，只受物理磁盘、浏览器资料损坏、卸载和实际存储失败影响。因此日志在普通用户的磁盘上会无上限增长；`unlimitedStorage` 移除浏览器默认配额是这一设计的直接前提。后台答复已如实写明“随使用持续增长、卸载删除、仅在本机”。

量级估算（由事件 schema 推导，非本机数据）：`media.sample` 以 1 Hz 记录完整 buffered/seekable 区间与帧统计，单行约 0.6–1.2 KB，即约 2–4 MB/小时观看；分片竞速事件（1 MiB 分块）再贡献约 0.3–0.7 MB/小时；合计约 3–5 MB/小时、每月约 30–50 MB（按每月 10 小时观看）。

**留给用户的取舍**：保持无上限保留（现设计，诊断价值最高）还是未来版本引入轮转/上限（会改 GOAL.md 行为，超出本任务范围）。商店审查风险：`unlimitedStorage` 属于少见的权限，审查员可能追问用途——上面给出的“日志不轮转设计 + 本机 + 卸载删除”口径即为答复；日志本身不上传，审查员看不到日志内容。

## 待用户决定的其他事项

- 数据使用勾选：草稿建议勾选「网页历史」与「网站内容」（依据 User Data Policy 对“处理的定义”包含本地内存中转；本地处理也必须披露）。若把“收集”理解为仅持久化，可不勾「网站内容」，但两选都需与 PRIVACY.md 一致。
- 类别：建议 Productivity（商店无媒体/播放类目）。
- 名称：见上表。
- 图片：商店图标已完成；截图、440×280 小宣传图、1400×560 Marquee 待 popup 重设计后的任务完成。
