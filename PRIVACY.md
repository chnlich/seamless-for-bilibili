# 隐私政策 / Privacy Policy

适用于：Bilibili 桌面网页抗卡（Chrome 扩展，版本 1.0.0）。
Applies to: Bilibili 桌面网页抗卡 (Chrome extension, version 1.0.0).

---

## 中文

### 扩展做什么

本扩展在 Bilibili 的视频页与直播页接管播放器的媒体下载。视频页：播放器请求一个媒体分片（音频/视频字节段）时，由扩展用内存中的缓存回应；未命中时由扩展同时向两个地址发出同样的 Range 请求（播放器自己请求的地址，以及 Bilibili 播放信息为同一文件给出的另一个镜像地址），先完整到达的一份存入内存后回应播放器，并向前预取后续分片；同时向原生播放器请求 120 秒稳定缓冲。直播页：接管播放器的 FLV 流，配对同一集群的主备两路地址，比对两路前缀一致后并发竞速、先到的字节先供给，查无配对或前缀不一致时退回播放器原地址单路供给；直播不预取、不设缓冲目标。无论在视频页还是直播页，扩展都不接管播放：不改变播放、暂停、拖动、倍速、画质、音量与音视频轨的任何决定。

### 处理哪些数据、放在哪里

1. **媒体分片（音频/视频字节）**：只保存在页面内存中（每个标签页上限 512 MiB），离开视频路由（转到非视频页或换到另一个视频）或关闭页面时释放；直播流字节只在内存中转交播放器。媒体字节不写入磁盘，也不进入诊断日志。
2. **开发诊断日志**：保存在扩展自身 origin 的本地 IndexedDB 数据库（`bilibili-development-logs`）中，只追加，不删除、不轮转、不设条数或容量上限。每打开一个 `www.bilibili.com` 或 `live.bilibili.com` 页面（包括非视频页）都会建立一条记录。日志字段只包括：时间戳、浏览器标签页编号、扩展版本与构建编号、页面地址中的站点与路径、视频编号（如 bvid）、分 P 编号、媒体编号、去除 query/hash 的媒体地址与镜像主机名、媒体请求的字节数/耗时/结果、播放器媒体事件（播放、暂停、拖动、倍速与音量变化等）及当时的媒体事实（buffered/seekable 区间、readyState、帧统计、清晰度等）、扩展动作和去除地址参数的错误文本。**不保存**：query/hash、签名 CDN 参数、Cookie、账号、标题、页面文字、弹幕/聊天、API body、音视频数据、帧或截图。无法安全读取的值记为“未提供”。
3. **偏好设置**：`chrome.storage.local` 中只保存一个开关（视频增强启用或关闭）。

### 数据不离开设备

扩展没有上传、遥测、统计或任何外部端点。扩展发出的网络请求只有一种：代替播放器发出的媒体请求，去向只有两类地址——播放器自己请求的媒体地址（扩展只拦截主机为 `*.bilivideo.com` 或 `*.akamaized.net` 的请求），以及 Bilibili 自己的播放信息（播放器收到的 playurl 响应或页面内嵌的播放信息）为同一文件列出的其他镜像地址。扩展不合成、不替换地址，不访问任何其他服务器。为求速度会进行竞速：同一段视频分片同时请求两个镜像地址（先完成先用，另一路取消），直播配对后两路流并发传输；下载流量因此可能高于不装扩展时（直播配对期间接近两倍）。诊断日志、媒体分片与偏好设置永不离开本机。扩展不读取、不存储、不上传 Cookie。

### 查看与导出

用户可以在扩展的日志页随时查看日志；导出只在用户主动点击导出并在浏览器文件对话框中选择保存文件时发生（JSONL 格式，由用户自行保管）。导出之外没有任何把数据带出设备的途径。

### 保留期限

诊断日志按设计不轮转、不删除，保留到用户卸载扩展为止，因此占用的磁盘空间随使用持续增长（开发者自用浏览器的一次实测：视频页每打开 1 小时约增加 7 MB）。卸载扩展会连同其 IndexedDB 与存储一起删除全部数据。日志不设“删除部分记录”的功能。

### 第三方与广告

扩展不包含第三方代码或脚本的执行（无远程代码）、不投放广告、不做分析统计、不与任何第三方共享数据。

### 联系方式

GitHub Issues：https://github.com/chnlich/smooth-bilibili-chrome-plugin/issues

---

## English

### What the extension does

On Bilibili video pages and live pages, the extension takes over the player's media downloads. Video pages: a segment request from the player is answered from an in-memory cache; on a miss, the extension issues the same Range request to two addresses at once (the address the player itself requested, and another mirror address that Bilibili's playback info lists for the same file), stores the first complete response in memory, answers the player, and prefetches further segments; it also asks the native player to keep a 120-second stable buffer. Live pages: the extension takes over the player's FLV stream, pairs the primary/backup addresses of the same cluster, checks that their common prefix matches, then delivers whichever bytes arrive first; with no pair or a prefix mismatch it falls back to a single leg on the player's own URL. Live has no prefetch and no buffer target. On neither page type does the extension take over playback: it never changes play, pause, seeking, playback rate, quality, volume, or audio/video track decisions.

### What data is handled, and where it stays

1. **Media segments (audio/video bytes)**: held in page memory only (up to 512 MiB per tab), released when the video route is left (moving to a non-video page or to another video) or the page is closed; live stream bytes only pass through memory to the player. Media bytes are never written to disk and never written to the diagnostic log.
2. **Development diagnostic log**: stored in the extension's own local IndexedDB database (`bilibili-development-logs`), append-only — never deleted, rotated, or capped by count or size. Every `www.bilibili.com` or `live.bilibili.com` page that is opened (non-video pages included) gets a record. Log fields are limited to: timestamps, browser tab number, extension version and build id, site and path of the page address, video identifiers (such as bvid), part number, media identifier, media URLs with query/hash removed and mirror host names, byte counts/timings/results of media requests, player media events (play, pause, seeking, rate and volume changes, and so on) with the media facts at that moment (buffered/seekable ranges, readyState, frame statistics, quality), extension actions, and error text with URL parameters removed. **Not stored**: query/hash, signed CDN parameters, cookies, account information, titles, page text, danmaku/chat, API bodies, audio/video data, frames, or screenshots. Values that cannot be read safely are recorded as “未提供” (not provided).
3. **Preferences**: a single on/off switch (video enhancement enabled or disabled) in `chrome.storage.local`.

### Data never leaves the device

The extension has no upload, telemetry, analytics, or any external endpoint. The only network requests it issues are media requests made on the player's behalf, to exactly two kinds of address: the media address the player itself requested (the extension intercepts only requests to `*.bilivideo.com` or `*.akamaized.net` hosts), and other mirror addresses that Bilibili's own playback info (the playurl response the player receives, or the playback info embedded in the page) lists for the same file. The extension never synthesizes or substitutes addresses and contacts no other server. For speed it races: the same video segment is requested from two mirror addresses at once (first complete response wins, the other leg is cancelled), and a paired live stream is transferred on both legs concurrently. Download traffic can therefore exceed what the player would use without the extension (close to double while a live pair is racing). Diagnostic logs, media segments, and preferences never leave the device. The extension does not read, store, or upload cookies.

### Viewing and export

Users can inspect the log at any time on the extension's log page. Export happens only when the user clicks export and picks a file in the browser's save dialog (JSONL format, kept by the user). There is no other path that takes data off the device.

### Retention

By design the diagnostic log is never rotated or deleted; it is kept until the user uninstalls the extension, so its disk use keeps growing with use (one measurement on the developer's own browser: about 7 MB per hour a video page is open). Uninstalling deletes the extension's IndexedDB and storage together with all data. There is no "delete part of the log" feature.

### Third parties and advertising

The extension executes no third-party or remote code, shows no advertising, performs no analytics, and shares no data with any third party.

### Contact

GitHub Issues: https://github.com/chnlich/smooth-bilibili-chrome-plugin/issues
