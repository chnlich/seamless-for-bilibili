# 隐私政策 / Privacy Policy

适用于：Seamless for Bilibili（Chrome 扩展，版本 1.2.2）。
Applies to: Seamless for Bilibili (Chrome extension, version 1.2.2).

---

## 中文

### 扩展做什么

本扩展在 Bilibili 的视频页与直播页接管播放器的媒体下载。视频页：播放器请求一个媒体分片（音频/视频字节段）时，由扩展用内存中的缓存回应；未命中时由扩展取回覆盖请求范围的完整分片；有可用配对时，同时向播放器请求的地址和 Bilibili 播放信息为同一文件列出的另一个镜像地址取数，先完整到达的一份存入内存后回应播放器，并向前预取后续分片；同时向原生播放器请求 120 秒稳定缓冲。直播页：接管播放器的直播媒体下载（FLV 流与 HLS 分片），配对同一集群的主备两路地址，比对两路字节一致后并发竞速、先到的字节先供给（FLV 比对流开头的前缀，HLS 完整比对首个竞速分片对），查无配对或比对不一致时退回播放器原地址单路供给。fMP4 直播间另从 Bilibili 播放信息给出的同一直播间、同流名、同编码 FLV 地址开一条后备连接，从 FLV 帧拼出分片，字节数与 CRC32 都等于播放列表给出的值才参与竞速。直播不预取、不设缓冲目标。无论在视频页还是直播页，扩展都不接管播放：不改变播放、暂停、拖动、倍速、画质、音量与音视频轨的任何决定。

### 处理哪些数据、放在哪里

1. **媒体分片（音频/视频字节）**：视频分片只保存在页面内存中（每个标签页上限 512 MiB），离开视频路由（转到非视频页或换到另一个视频）或关闭页面时释放；直播流字节在内存中转交播放器，FLV 后备另在内存中保留约 30 秒的帧窗口用于拼接，换流或离开页面时释放。媒体字节不写入磁盘，也不进入诊断日志。
2. **开发诊断日志**：保存在扩展自身 origin 的本地 IndexedDB 数据库（`bilibili-development-logs`）中，只保留最近 3 天（72 小时）：超过 72 小时的记录按其自身时间自动删除，保留窗口内只追加，不设条数或容量上限。每打开一个 `www.bilibili.com` 或 `live.bilibili.com` 页面（包括非视频页）都会建立一条记录。日志字段只包括：时间戳、浏览器标签页编号、扩展版本与构建编号、页面地址中的站点与路径、视频编号（如 bvid）、分 P 编号、媒体编号、去除 query/hash 的媒体地址与镜像主机名、媒体请求的字节数/耗时/结果、直播流出现卡顿迹象（一个分片请求在途满 2 秒，或距上一个分片交付满 2 秒）时的在途请求快照（在途分片请求的流路径与已等待时间，每条下载线路的编号、镜像主机名、已收字节数与距上次收到字节的时间，以及播放列表与 FLV 后备已多久没有新数据）、播放器媒体事件（播放、暂停、拖动、倍速与音量变化等）及当时的媒体事实（buffered/seekable 区间、readyState、帧统计、清晰度等）、扩展动作和去除地址参数的错误文本。**不保存**：query/hash、签名 CDN 参数、Cookie、账号、标题、页面文字、弹幕/聊天、API body、音视频数据、帧或截图。无法安全读取的值记为“未提供”。
3. **偏好设置**：`chrome.storage.local` 中保存两个开关（视频增强、直播增强各自启用或关闭）。

### 数据不离开设备

扩展没有上传、遥测、统计或外部日志端点。扩展只发出媒体下载请求：去向是播放器自己请求的媒体地址，以及 Bilibili 自己的播放信息（播放器收到的 playurl 响应或页面内嵌的播放信息）为同一文件列出的其他镜像地址；fMP4 直播后备的 FLV 地址也来自同一直播间的播放信息。视频页上，扩展识别主机以 `.bilivideo.com` 或 `.akamaized.net` 结尾的请求，或路径与播放信息为该文件列出的某个音视频地址路径相同的请求（包括 PCDN 节点），并在请求带闭合单段 Range 时接管。直播页仍只在上述已知主机后缀上接管 FLV 流与 HLS 媒体分片。视频竞速的每个地址携带自己的签名原样请求，两路路径可以不同；直播 HLS 备用分片地址由播放信息中的备用主机和该地址自己的签名参数，加上播放器请求的流路径与分片名组成。扩展不猜测主机，也不访问这些媒体目的地之外的服务器。为求速度会进行竞速：同一段视频分片同时请求两个镜像地址（先完成先用，另一路取消），直播配对后两路流并发传输，fMP4 直播还可能另开 FLV 后备连接；下载流量因此可能高于不装扩展时（实测直播约为单路的 1 到 2.3 倍）。诊断日志、媒体分片与偏好设置永不离开本机。扩展不读取、不存储、不上传 Cookie。

### 查看与导出

用户可以在扩展的日志页随时查看日志；导出只在用户主动点击导出并在浏览器文件对话框中选择保存文件时发生（JSONL 格式，由用户自行保管）。导出之外没有任何把数据带出设备的途径。

### 保留期限

诊断日志只保留最近 3 天（72 小时）：超过 72 小时的记录按其自身时间自动删除，无需用户操作；实测视频页每打开 1 小时约增加 7 MB，因此磁盘占用大致以最近 3 天的用量为上界。卸载扩展会连同其 IndexedDB 与存储一起删除全部数据。除此之外日志没有手动“删除部分记录”的功能。

### 第三方与广告

扩展不包含第三方代码或脚本的执行（无远程代码）、不投放广告、不做分析统计、不与任何第三方共享数据。

### 联系方式

GitHub Issues：https://github.com/chnlich/seamless-for-bilibili/issues

---

## English

### What the extension does

On Bilibili video pages and live pages, the extension takes over the player's media downloads. Video pages: a segment request from the player is answered from an in-memory cache; on a miss, the extension fetches complete chunks covering the requested range. When a pair is available, it fetches concurrently from the player's address and another mirror address Bilibili's playback info lists for the same file, stores the first complete response in memory, answers the player, and prefetches further segments; it also asks the native player to keep a 120-second stable buffer. Live pages: the extension takes over the player's live media downloads (the FLV stream and HLS segments), pairs the primary/backup addresses of the same cluster, checks that the two legs serve identical bytes, then delivers whichever bytes arrive first (for FLV the comparison covers the stream's leading prefix; for HLS the first raced segment pair is compared in full); with no pair or a mismatch it falls back to a single leg on the player's own URL. On fMP4 live rooms, an extra backup connection uses the same room's same-stream, same-codec FLV address from Bilibili's playback info to rebuild segments from FLV frames; a rebuild races only when its byte length and CRC32 equal the playlist's values. Live has no prefetch and no buffer target. On neither page type does the extension take over playback: it never changes play, pause, seeking, playback rate, quality, volume, or audio/video track decisions.

### What data is handled, and where it stays

1. **Media segments (audio/video bytes)**: video segments are held in page memory only (up to 512 MiB per tab), released when the video route is left (moving to a non-video page or to another video) or the page is closed; live stream bytes pass through memory to the player, and the FLV backup also keeps about 30 seconds of frames in memory for rebuilding, released on stream change or page leave. Media bytes are never written to disk and never written to the diagnostic log.
2. **Development diagnostic log**: stored in the extension's own local IndexedDB database (`bilibili-development-logs`); it keeps only the last 3 days (72 hours). Records older than 72 hours are deleted automatically by their own timestamp; within that window the log is append-only and not capped by count or size. Every `www.bilibili.com` or `live.bilibili.com` page that is opened (non-video pages included) gets a record. Log fields are limited to: timestamps, browser tab number, extension version and build id, site and path of the page address, video identifiers (such as bvid), part number, media identifier, media URLs with query/hash removed and mirror host names, byte counts/timings/results of media requests, in-flight request snapshots while a live stream shows a stall sign (a segment request in flight for 2 seconds or more, or 2 seconds since the last segment was delivered; each snapshot holds the stream path and waiting time of every in-flight segment request, per download line its number, mirror host name, bytes received so far and time since the last byte, and how long the playlist and the FLV backup have gone without new data), player media events (play, pause, seeking, rate and volume changes, and so on) with the media facts at that moment (buffered/seekable ranges, readyState, frame statistics, quality), extension actions, and error text with URL parameters removed. **Not stored**: query/hash, signed CDN parameters, cookies, account information, titles, page text, danmaku/chat, API bodies, audio/video data, frames, or screenshots. Values that cannot be read safely are recorded as “未提供” (not provided).
3. **Preferences**: two on/off switches in `chrome.storage.local` (video enhancement and live enhancement, each enabled or disabled).

### Data never leaves the device

The extension has no upload, telemetry, analytics, or external log endpoint. It issues only media download requests: to the media address the player requested and other mirror addresses Bilibili's own playback info (the playurl response the player receives, or the playback info embedded in the page) lists for the same file; the fMP4 live backup's FLV address also comes from that room's playback info. On video pages, it recognizes requests whose host ends in `.bilivideo.com` or `.akamaized.net`, or whose path matches an audio/video address that playback info lists for the file (including PCDN nodes), and takes over requests carrying a closed single Range. Live takeover still covers only FLV streams and HLS media segments on the known host suffixes above. Video race URLs are requested verbatim with their own signatures, and their paths may differ; a live HLS backup segment URL combines the backup host and that address's own signature parameters from playback info with the player's stream path and segment name. The extension never guesses hosts or contacts servers outside these media destinations. For speed it races: the same video segment is requested from two mirror addresses at once (first complete response wins, the other leg is cancelled), a paired live stream is transferred on both legs concurrently, and fMP4 live may also open an FLV backup connection. Download traffic can therefore exceed what the player would use without the extension (measured live traffic was about 1 to 2.3 times a single stream). Diagnostic logs, media segments, and preferences never leave the device. The extension does not read, store, or upload cookies.

### Viewing and export

Users can inspect the log at any time on the extension's log page. Export happens only when the user clicks export and picks a file in the browser's save dialog (JSONL format, kept by the user). There is no other path that takes data off the device.

### Retention

The diagnostic log keeps only the last 3 days (72 hours): records older than 72 hours are deleted automatically by their own timestamp, with no action from the user. One measurement on the developer's own browser put growth at about 7 MB per hour a video page is open, so disk use is roughly bounded by the last 3 days of usage. Uninstalling deletes the extension's IndexedDB and storage together with all data. Apart from that automatic deletion there is no manual "delete part of the log" feature.

### Third parties and advertising

The extension executes no third-party or remote code, shows no advertising, performs no analytics, and shares no data with any third party.

### Contact

GitHub Issues: https://github.com/chnlich/seamless-for-bilibili/issues
