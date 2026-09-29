# 商店上架草稿（中文 / zh-CN）

面向 Chrome Web Store 开发者后台的逐字段草稿。名称已定为 Seamless for Bilibili，决定与理由见 [README.md](README.md)；用户复制粘贴后自行提交。全部字段与图片已按现状预填（见 [images/README.md](images/README.md)）。

## Store listing（商店信息）标签页

- **名称（item name）**：Seamless for Bilibili（来自 manifest `name`，商店后台与 manifest 保持一致；决定与理由见 README.md）。
- **简短说明 / 简介摘要**：后台不单独填写，直接取 manifest `description`（118 字符 ≤ 132，按 Unicode 字符计）：
  减少海外党看 Bilibili 视频与直播的卡顿：同一内容同时从 Bilibili 自带的两个镜像地址下载，先到先用；视频页另请播放器保持 120 秒缓冲。代价是多用流量（直播双路约 1.3 到 2 倍）。数据不离开本机，不改播放操作。
- **详细说明**（粘贴即用）：

  ```text
  海外党在 Bilibili 看视频或直播时经常卡，而自己的测速并不慢，本扩展为这种场景设计，减少 Bilibili 视频与直播的播放卡顿。视频在 1080p 画质、2 倍速播放下保持流畅。独立第三方工具，与 Bilibili 无隶属或合作关系；Bilibili 及相关名称归其权利人所有。

  【前提与局限】
  本扩展基于三个前提：卡顿常来自 Bilibili 个别 CDN 节点慢或不稳定，而不是您自己的网络；Bilibili 自己的播放信息已经为同一份内容给出主备多个镜像地址；您的带宽高于视频码率、有余量同时下载两份（2 倍速播放时播放器消耗数据的速度加倍，余量按两倍码率计）。它救的是“慢节点”，救不了“慢线路”：家庭带宽本身不足时帮不上忙；浏览器解码跟不上造成的卡顿（缓冲已满仍然卡住，例如硬件解码断供）也不在它的能力范围内。

  【视频页怎么做】
  接管播放器的媒体分片下载（fetch 与 XHR 两条通道）：每个 1 MiB 分片同时向 Bilibili 提供的两个镜像地址请求，先完整到达的生效，另一路取消；向前预取（窗口最多 48 个分片、并发 4）；分片只存内存（每个标签页上限 512 MiB），离开页面即释放，不写磁盘；每个视频向 Bilibili 原生播放器请求一次 120 秒缓冲。

  【直播页怎么做】
  接管播放器的直播媒体下载：FLV 直播流与 HLS 直播分片（.m4s 与 .ts，.m3u8 播放列表照常放行）。地址只配对同一集群的主备两路：FLV 流先比对两路开头的字节一致，再两路同时下载、先到的字节先交给播放器；HLS 分片先完整比对首个竞速分片对，一致后每个分片两路同时下载、先完成的交给播放器并取消另一路。查无配对或比对不一致时退回播放器原地址单路下载。直播不预取、不设缓冲目标。播放器若未使用这些媒体格式，或页面把播放器装进扩展的页面脚本进不去的独立 iframe（部分赛事活动页），接管不介入，弹窗会如实显示「未接管」。

  【两者都不做的事】
  不使用第三方地址，不改写、不替换 Bilibili 的地址；不接管播放：播放、暂停、拖动、倍速、画质、音量与轨道选择仍由您和 Bilibili 播放器决定。

  【代价：请按流量套餐衡量】
  视频：竞速中落败一路已下载的字节被丢弃，一次实测稳态浪费约 12.6%（每场播放不同，扩展日志页的 CDN 竞速面板显示当场实际浪费率）；120 秒缓冲与预取会提前下载，提前离开视频会比原生播放器多下载未观看的数据。直播：FLV 配对后两路一直同时下载，流量接近单路的两倍；HLS 分片按分片取舍，一次实测（11 分钟直播，668 个分片）竞速浪费约 28%，即总流量约为单路的 1.3 倍。内存：每个标签页的媒体缓存最多约 512 MiB。磁盘：本地诊断日志只保留最近 3 天（72 小时），超期记录自动删除（开发者自用浏览器实测：视频页每打开 1 小时约 7 MB，占用大致以最近 3 天的用量为上界），卸载扩展即全部删除。
  开关：弹窗里有两个开关，都在刷新页面后生效：“视频增强”只作用于视频页，“直播增强”只作用于直播页。不想承担直播的多用流量，把“直播增强”关掉即可；关闭后播放器按原样自己下载，扩展在直播页不接管、不竞速，视频页的增强不受影响。

  【数据】
  媒体分片只驻留内存。开发诊断日志只存扩展本地 IndexedDB：记录每个 Bilibili 页面的路径、视频编号、去掉参数的媒体地址、媒体请求耗时与结果、播放器事件（播放、暂停、拖动等）和缓冲状态；不记录 Cookie、账号、标题、页面文字、弹幕、签名参数或音视频字节。不上传、无遥测；导出仅在您主动选择文件时发生。权限只有 storage（记住两个开关：视频增强与直播增强）与 unlimitedStorage（写入 3 天窗口内的本地诊断日志），没有 host_permissions。全部源码开源：https://github.com/chnlich/seamless-for-bilibili
  ```

- **类别**：娱乐（Entertainment）。依据商店类目说明，旧“Productivity”大类已拆分，Entertainment 是面向影视观看者的类目，与本扩展只服务 Bilibili 看视频/直播最贴近；备选“工具（Tools）”。
- **语言**：中文（简体）。manifest 未声明 `_locales`，因此当前只有一个默认语言列表；英译稿（[listing.en.md](listing.en.md)）留给未来增加 `_locales` 后作为 locale 专属列表使用。
- **主页网址**：https://github.com/chnlich/seamless-for-bilibili
- **支持网址**：https://github.com/chnlich/seamless-for-bilibili/issues
- **官方网址（Official URL）**：留空（需先在 Google Search Console 验证站点，属可选字段）。
- **成人内容（Mature content）**：不勾选。

## Privacy practices（隐私规范）标签页

- **单一用途说明**：
  减少 Bilibili 视频页与直播页的播放卡顿：由扩展接管播放器的媒体下载、对 Bilibili 自带的主备镜像地址做双路竞速，并在视频页向原生播放器请求 120 秒缓冲。
- **权限用途说明**（逐项，与 manifest 完全一致，不多不少）：

  | 后台列出的项 | 粘贴文本 |
  |---|---|
  | `storage` | 仅在 chrome.storage.local 保存两个用户开关（视频增强、直播增强各自启用/关闭），用于记住用户在扩展弹窗中的选择；不保存任何其他数据。 |
  | `unlimitedStorage` | 开发诊断日志保存在扩展自身 origin 的 IndexedDB 中，只保留最近 3 天（72 小时），超期记录自动删除；窗口内的日志只追加、不设条数或容量上限（见仓库 GOAL.md）。实测视频页每打开 1 小时约产生 7 MB，3 天窗口的占用仍可能明显大于浏览器默认配额，unlimitedStorage 移除该配额，使窗口内的日志能连续写入而不因配额写入失败。日志只在本机，用户可在日志页查看或导出，卸载扩展即全部删除。 |
  | 内容脚本 `https://www.bilibili.com/*` | 下载接管只在视频路由（/video/* 与 /list/watchlater*）启动：拦截播放器的媒体分片请求，由内存缓存应答或代为向 Bilibili 提供的镜像地址取回，并向播放器请求 120 秒缓冲。匹配整个站点是因为扩展在页面内跟随路由变化，脚本须在页面开始时（document_start）就位；在其他路由上不拦截任何请求，只在本地诊断日志记录一条页面路径。 |
  | 内容脚本 `https://live.bilibili.com/*` | 在直播页接管播放器的直播媒体下载：FLV 直播流与 HLS 直播分片（.m4s 与 .ts，.m3u8 播放列表照常放行），对 Bilibili 给出的同集群主备两路地址比对后并发竞速（不预取、不设缓冲目标）。 |
  | MAIN world 注入（`world: "MAIN"`） | 三个脚本必须运行在页面自身的 JavaScript 环境中：bank.js 包装页面的 fetch/XMLHttpRequest 才能接住播放器发出的媒体请求；source-buffer-shim.js 观察页面的 MediaSource/SourceBuffer 追加与移除，用于本地诊断；main-bridge.js 调用 Bilibili 播放器对象自带的缓冲设置（setStableBufferTime）。MAIN world 不提供 chrome.* API；读取偏好与写日志由 ISOLATED world 的 controller.js 完成。 |

  若后台只给一个“主机权限（Host permission）”合并栏，粘贴：
  本扩展没有 host_permissions，只有两条内容脚本匹配：www.bilibili.com（仅在视频路由接管播放器的媒体分片下载并请求 120 秒缓冲，其他路由只记录本地诊断路径）与 live.bilibili.com（接管 FLV 直播流与 HLS 直播分片（.m3u8 播放列表照常放行），并对 Bilibili 自带的主备地址竞速）。媒体取数在页面上下文中进行，去向只有播放器自己请求的地址与 Bilibili 播放信息为同一文件列出的镜像地址。
- **远程代码（Remote Code）**：选择“否，我不使用远程代码”。全部 JavaScript 在构建时由 esbuild 从仓库源码打包；运行时不加载、不执行任何远程文件（源码中无 eval、无 new Function、无远程 script、无 importScripts）。
- **数据使用（Data usage，收集哪些数据）**：User Data Policy 明确要求“只在本机处理或存储的数据也必须披露”，因此按本机实际处理勾选。类别定义摘自商店公开页面的原文。

  | 复选框（商店定义） | 决定 | 理由 |
  |---|---|---|
  | 网页历史 / Web history（“用户访问过的网页列表及页面标题、访问时间等关联数据”） | ✅ 勾选 | 每打开一个 www.bilibili.com / live.bilibili.com 页面，日志都记录其路径（去掉 query/hash）、视频编号与时间戳；不记录标题。只在本机，用于缺陷诊断。 |
  | 用户活动 / User activity（“例如网络监控、点击、鼠标位置、滚动或击键记录”） | ✅ 勾选 | 日志记录播放器媒体请求的地址（去参数）、镜像主机、耗时、字节数与结果（属网络监控），以及播放、暂停、拖动、倍速、音量变化等播放器事件；不记录点击坐标、鼠标、滚动或击键。只在本机。 |
  | 网站内容 / Website content（“例如文字、图片、声音、视频或超链接”） | ✅ 勾选 | 媒体分片（音视频字节）在内存中中转以供给播放器；不落盘、不入日志、不外发。 |
  | 个人身份信息 / 健康 / 财务与支付 / 身份验证信息 / 个人通讯 / 位置 | ⬜ 不勾选 | 日志明确不保存 Cookie、账号、标题、页面文字、弹幕/聊天、API body、音视频字节、帧或截图；不读取位置或 IP；不接触表单与密码。 |

- **数据使用的合规认证（certifications）**：后台的三项认证全部勾选（商店公开页对应显示为：不出售给第三方（已批准用途除外）；不用于或转移至与核心功能无关的用途；不用于信用评估或借贷）。理由：扩展没有任何外部端点，数据根本不离开设备；唯一发出的网络请求是代替播放器向 Bilibili 自身媒体地址发出的媒体请求。如后台项数不同，逐项按同一理由勾选。
- **隐私政策网址**：https://github.com/chnlich/seamless-for-bilibili/blob/main/PRIVACY.md
  （仓库为公开仓库；提交前 PRIVACY.md 的当前版本必须已在 main 上，该 URL 是用户可见的。）
- **Limited Use 声明**：不适用。该要求针对“从 Google API 收到的数据”，本扩展不使用任何 Google API，PRIVACY.md 中不做此声明，以免暗示存在 Google API 数据。

## Test instructions（测试说明）标签页

留空。该标签页不是发布必需项，只用于需要受限账号或付费账号的扩展；Bilibili 视频与直播无需登录即可播放。

## Distribution（分发）标签页

- 可见性：公开。地区：全部（默认）。定价：免费。

## 图片清单

| 素材 | 规格 | 状态 |
|---|---|---|
| 商店图标 | 128×128 PNG（96×96 图形 + 16px 透明边） | ✅ 已完成：`assets/icon.svg` → `npm run icons` 生成四个尺寸（16/32/48 取图形区铺满画布以便工具栏辨认），已随包提交；后台上传 `src/extension/icons/icon128.png` |
| 截图 | 1280×800（或 640×400），至少 1 张、最多 5 张 | ✅ 已完成：`store/images/screenshot-01-popup-video.png`（视频页真实弹窗，双开关、新名称）与 `screenshot-02-popup-live.png`（直播页真实弹窗）；`screenshot-03-racing-diagram.png`（机制与流量代价示意图，不含名称）。由 `store/images/src/compose.mjs` 从真实运行捕获合成，页面背景整体模糊以隐藏第三方内容 |
| 小型宣传图（必需） | 440×280 PNG/JPEG | ✅ 已完成：`store/images/promo-tile-440x280.png`，画面上是新名称 Seamless for Bilibili |
| Marquee 宣传图（可选，入选推荐位需要） | 1400×560 PNG/JPEG | ✅ 已完成：`store/images/marquee-1400x560.png`，画面上是新名称 Seamless for Bilibili |
| YouTube 宣传视频 | 链接 | ⬜ 无。图片规范页写明只有图标、小型宣传图、截图是必需项；商店信息页的列表把视频与其他素材并列。若后台拦截提交，由后续任务补做 |

## 打包与上传

```sh
npm run package
```

构建 → 合同测试 → 生成 `release/seamless-for-bilibili-<版本>.zip`（manifest.json 位于 zip 根目录），后台 Items → New item 上传该 zip。源码审查如被要求补充材料，可另行提供仓库 zip；发布的 bundle 未压缩并带 source map。

## 依据文档（本草稿所依赖的政策与规范）

- 商店信息字段、本地化列表须对应 `_locales`：https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- 图片规格（图标 96×96 + 16px 透明边、截图、宣传图、必需项）：https://developer.chrome.com/docs/webstore/images
- 类目列表与类目调整：https://developer.chrome.com/docs/webstore/best-practices
- 隐私规范标签页（单一用途、权限用途说明、远程代码、数据使用、隐私政策网址）：https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- 测试说明标签页（非必需）：https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions
- 数据类别定义（商店公开页面上的披露原文，以任一扩展的 privacy 页为例）：https://chromewebstore.google.com/detail/crxmouse-mouse-gestures/jlgkpaicikihijadgifklkbpdajbkhjo/privacy
- 计划政策总览（隐私字段与实际行为矛盾可被下架；误导性标题/描述；无法判定完整功能可被拒）：https://developer.chrome.com/docs/webstore/program-policies/policies
- 列表要求（描述/图标/截图缺失会被拒；关键字堆砌）：https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
- 权限最小化：https://developer.chrome.com/docs/webstore/program-policies/permissions
- 权限清单（unlimitedStorage 覆盖 IndexedDB 配额）：https://developer.chrome.com/docs/extensions/reference/permissions-list
- User Data Policy 与 FAQ（本地处理也必须披露；网页浏览活动的定义）：https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Limited Use：https://developer.chrome.com/docs/webstore/program-policies/limited-use
- 隐私政策要求：https://developer.chrome.com/docs/webstore/program-policies/privacy
- 冒充与知识产权（第三方品牌命名依据）：https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property
- 品牌规范（Google 商标的“for …”指称模式，本草稿类比用于 Bilibili）：https://developer.chrome.com/docs/webstore/branding
- MV3 要求（不得执行远程托管代码）：https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
- manifest 字段长度（名称 75、描述 132）：https://developer.chrome.com/docs/extensions/reference/manifest
- 开发者注册：https://developer.chrome.com/docs/webstore/register
