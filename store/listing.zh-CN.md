# 商店上架草稿（中文 / zh-CN）

面向 Chrome Web Store 开发者后台的逐字段草稿。名称候选与最终决定见 [README.md](README.md)；用户复制粘贴后自行提交。除注明“待做”的图片外，全部字段已按现状预填。

## Store listing（商店信息）标签页

- **名称（item name）**：来自 manifest（本任务不改）。建议改为「视频抗卡 for Bilibili」，决定见 README.md。
- **简短说明 / 简介摘要**（= manifest `description`，98 字符 ≤ 132）：
  接管 Bilibili 视频与直播页的媒体下载：视频分片同时向两个镜像地址取回、先完成先用，并请求播放器保持 120 秒缓冲；直播主备两路流并发供给、先到先用。全部在本机内存完成，不改动播放控制。
- **详细说明**（粘贴即用）：

  ```text
  减少 Bilibili 视频与直播的播放卡顿。独立第三方工具，与 Bilibili 无隶属或合作关系；Bilibili 及相关名称归其权利人所有。

  【思路与前提】
  卡顿常来自 Bilibili 个别 CDN 节点慢或不稳定，而不是您的带宽不够；Bilibili 自己为同一份内容提供主备多个镜像地址。本扩展同时向两个地址取数、先完成先用。它救的是“慢节点”，救不了“慢线路”：家庭带宽本身不足，或浏览器解码跟不上（缓冲已满仍然卡顿）时，本扩展帮不上忙。

  【视频页】
  接管播放器的媒体分片下载：每个 1 MiB 分片同时向 Bilibili 提供的主备两个镜像地址请求，先完整到达的生效；向前预取（窗口最多 48 个分片、并发 4）；分片只存内存（上限 512 MiB），离开页面即释放，不写磁盘；并向原生播放器请求 120 秒缓冲。不接管播放：播放、暂停、拖动、倍速、画质、音量与轨道选择仍由您和 Bilibili 播放器决定。

  【直播页】
  接管播放器的 FLV 流：只配对同一集群的主备两路地址，先比对两路前缀一致再并发竞速，先到的字节先供给；查无配对或前缀不一致时退回播放器原地址单路供给。直播不预取、不设缓冲目标。

  【代价——请按流量套餐衡量】
  视频：竞速中败腿已下载的字节被丢弃，一次实测稳态浪费约 12.6%（每场播放不同，扩展日志页的 CDN 竞速面板会显示当场实际浪费率）；120 秒缓冲与预取会提前下载，提前离开视频会比原生播放器多下载未观看的数据。直播：配对竞速期间两路同时下载，流量接近单路的两倍。此外每个标签页的媒体缓存最多占约 512 MiB 内存；本地诊断日志不轮转、随使用持续增长（只存本机，卸载即删）。

  【数据】
  媒体分片只驻留内存；开发诊断日志只存扩展本地 IndexedDB，不记录 Cookie、账号、标题、页面文字、弹幕、签名参数或音视频字节；不上传、无遥测；导出仅在您主动选择文件时发生。权限只有 storage（记住一个开关）与 unlimitedStorage（保存不轮转的本地日志），没有宽泛主机权限。全部源码开源：https://github.com/chnlich/smooth-bilibili-chrome-plugin
  ```

- **类别**：Productivity（效率）。商店的扩展分类里没有媒体/播放类目，这是最接近的一项；如后台分类列表不同，请就近选择。
- **语言**：中文（简体）。manifest 未声明 `_locales`，因此当前只有一个默认语言列表；英译稿（[listing.en.md](listing.en.md)）留给未来增加 `_locales` 后作为 locale 专属列表使用。
- **主页网址**：https://github.com/chnlich/smooth-bilibili-chrome-plugin
- **支持网址**：https://github.com/chnlich/smooth-bilibili-chrome-plugin/issues
- **官方网址（Official URL）**：留空（需先在 Google Search Console 验证站点，属可选字段）。

## Privacy practices（隐私规范）标签页

- **单一用途说明**：
  减少 Bilibili 视频与直播的播放卡顿：由扩展接管播放器的媒体下载、对 Bilibili 自带的主备地址做双路竞速，并在视频页向原生播放器请求 120 秒缓冲。
- **权限用途说明**（逐项，与 manifest 完全一致，不多不少）：

  | 后台列出的项 | 粘贴文本 |
  |---|---|
  | `storage` | 仅在 chrome.storage.local 保存一个用户开关（视频增强启用/关闭），用于记住用户在扩展弹窗中的选择；不保存任何其他数据。 |
  | `unlimitedStorage` | 开发诊断日志按设计不轮转、不设上限（见仓库 GOAL.md），保存在扩展自身 origin 的 IndexedDB 中，会随使用持续增长；unlimitedStorage 移除浏览器默认存储配额，使日志能持续追加而不打断下载与诊断。日志只在本机，用户可在日志页查看或导出，卸载扩展即全部删除。 |
  | 内容脚本 `https://www.bilibili.com/*` | 在视频页注入脚本：拦截播放器发起的媒体分片请求，由内存缓存应答或代为取回；同时记录本地媒体诊断，并向播放器请求 120 秒缓冲。 |
  | 内容脚本 `https://live.bilibili.com/*` | 在直播页对 FLV 媒体流做同样的下载接管与双路竞速（不预拉、不设缓冲目标）。 |
  | MAIN world 注入（`world: "MAIN"`） | 媒体请求拦截必须在页面自身的 JavaScript 环境中包装 fetch/XHR 才能覆盖播放器发出的请求，因此三个内容脚本运行在 MAIN world；MAIN world 不提供扩展的 chrome.* API，偏好读取由 ISOLATED world 的控制脚本完成。 |

  另注明：manifest 未申请任何 `host_permissions`（后台如有“主机访问权限”一栏，答复“无”）；对媒体地址的取数在页面上下文中、以与播放器完全相同的方式进行。
- **远程代码（Remote Code）**：选择“否，我不使用远程代码”。全部 JavaScript 在构建时由 esbuild 从仓库源码打包；运行时不加载、不执行任何远程文件（源码中无 eval、无远程 script、无远程 importScripts）。
- **数据使用（Data usage）— 收集哪些数据**：

  | 复选框 | 建议 | 理由 |
  |---|---|---|
  | 网页历史 / Web history | ✅ 勾选 | 日志记录播放器请求的媒体地址与页面路径（仅保留站点和路径，去除 query/hash）。“浏览器与之交互的 URL”的本地记录，用于缺陷诊断；永不离开设备。 |
  | 网站内容 / Website content | ✅ 勾选 | 媒体分片（音视频字节）在内存中短暂中转以供给播放器；不落盘、不入日志、不外发。 |
  | 个人身份信息 / 身份验证信息 / 通讯 / 位置 / 财务 / 健康 / 用户活动 | ⬜ 不勾选 | 日志明确不保存 Cookie、账号、标题、页面文字、弹幕/聊天、API body、音视频字节、帧或截图；不读取位置；无表单数据。 |

- **数据使用 — 合规认证（certifications）**：四项全部勾选。理由：扩展没有任何外部端点，不存在向第三方出售/转移、无关用途、信用评估、定向广告这四种行为的物理可能；唯一发出的网络请求是代替播放器向 Bilibili 自身媒体地址发出的同一段媒体请求。
- **隐私政策网址**：https://github.com/chnlich/smooth-bilibili-chrome-plugin/blob/main/PRIVACY.md
  （提交前 PRIVACY.md 必须已合入 main——该 URL 是用户可见的。）
- **Limited Use 声明**：不适用。该要求针对“从 Google API 收到的数据”，本扩展不使用任何 Google API，PRIVACY.md 中不做此声明，以免暗示存在 Google API 数据。

## Distribution（分发）标签页

- 可见性：公开。地区：全部（默认）。定价：免费。内容分级：保持默认（无成人内容）。

## 图片清单

| 素材 | 规格 | 状态 |
|---|---|---|
| 商店图标 | 128×128 PNG（96×96 图形 + 16px 透明边） | ✅ 已完成：`assets/icon.svg` → `npm run icons` 生成四个尺寸，已随包提交 |
| 截图 | 1280×800（或 640×400），至少 1 张、最多 5 张 | ⬜ 待做：popup 重设计落地后截图（后续任务） |
| 小型宣传图（必需） | 440×280 PNG/JPEG | ⬜ 待做：后续任务 |
| Marquee 宣传图（可选，入选推荐位需要） | 1400×560 PNG/JPEG | ⬜ 待做：后续任务 |
| YouTube 宣传视频（可选） | — | ⬜ 无 |

## 打包与上传

```sh
npm run package
```

构建 → 合同测试 → 生成 `release/smooth-bilibili-chrome-plugin-<版本>.zip`（manifest.json 位于 zip 根目录），后台 Items → New item 上传该 zip。源码审查如被要求补充材料（code readability），可另行提供仓库 zip；发布的 bundle 未压缩并带 source map。

## 依据文档（本草稿所依赖的政策与规范）

- 商店列表字段与图片：https://developer.chrome.com/docs/webstore/cws-dashboard-listing 、https://developer.chrome.com/docs/webstore/images
- 隐私规范标签页（单一用途、权限用途说明、远程代码、数据使用、隐私政策网址）：https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- 列表要求（描述/图标/截图缺失会被拒；关键字堆砌）：https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
- 权限最小化：https://developer.chrome.com/docs/webstore/program-policies/permissions
- User Data Policy（本地处理也必须披露）：https://developer.chrome.com/docs/webstore/user_data
- Limited Use：https://developer.chrome.com/docs/webstore/program-policies/limited-use
- 隐私政策要求：https://developer.chrome.com/docs/webstore/program-policies/privacy
- 冒充与知识产权（第三方品牌命名依据）：https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property
- 品牌规范（“for …”引用第三方/Google 商标的模式）：https://developer.chrome.com/docs/webstore/branding
- manifest 字段长度（名称 75、描述 132）：https://developer.chrome.com/docs/extensions/reference/manifest
- 开发者注册：https://developer.chrome.com/docs/webstore/register
- locale 专属列表要求 `_locales`：https://developer.chrome.com/docs/webstore/cws-dashboard-listing#localize-your-listing
