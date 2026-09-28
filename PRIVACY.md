# 隐私政策 / Privacy Policy

适用于：Bilibili 桌面网页抗卡（Chrome 扩展，版本 1.0.0）。
Applies to: Bilibili 桌面网页抗卡 (Chrome extension, version 1.0.0).

---

## 中文

### 扩展做什么

本扩展在 Bilibili 的视频页与直播页接管播放器发起的媒体分片（音频/视频字节段）下载：播放器请求一个媒体分片时，由扩展用内存中的缓存回应；未命中时由扩展向 Bilibili 为该视频提供的媒体地址发出同一段 Range 请求取回，存入内存后再回应播放器；同时向原生播放器请求 120 秒稳定缓冲。扩展不接管播放：不改变播放、暂停、拖动、倍速、画质、音量与音视频轨的任何决定。

### 处理哪些数据、放在哪里

1. **媒体分片（音频/视频字节）**：只保存在内存中，离开视频路由或关闭页面时立即释放；不写入磁盘，也不进入诊断日志。
2. **开发诊断日志**：保存在扩展自身 origin 的本地 IndexedDB 数据库（`bilibili-development-logs`）中，只追加，不删除、不轮转、不设条数或容量上限。日志字段只包括：页面地址中的站点与路径、视频编号（如 bvid）、分 P 编号、媒体编号、去除 query/hash 的媒体地址、媒体事实（buffered/seekable 区间、readyState、帧统计、清晰度等）、扩展动作和安全错误。**不保存**：query/hash、签名 CDN 参数、Cookie、账号、标题、页面文字、弹幕/聊天、API body、音视频数据、帧或截图。无法安全读取的值记为“未提供”。
3. **偏好设置**：`chrome.storage.local` 中只保存一个开关（视频增强启用或关闭）。

### 数据不离开设备

扩展没有上传、遥测、统计或任何外部端点。扩展发出的网络请求只有一种：代替播放器，向 Bilibili 播放信息中为当前视频给出的媒体地址发出与播放器相同的媒体请求（域名限定为 `*.bilivideo.com` 与 `*.akamaized.net`）。诊断日志、媒体分片与偏好设置永不离开本机。扩展不读取、不存储、不上传 Cookie。

### 查看与导出

用户可以在扩展的日志页随时查看日志；导出只在用户主动点击导出并在浏览器文件对话框中选择保存文件时发生（JSONL 格式，由用户自行保管）。导出之外没有任何把数据带出设备的途径。

### 保留期限

诊断日志按设计不轮转、不删除，保留到用户卸载扩展为止；卸载扩展会连同其 IndexedDB 与存储一起删除全部数据。日志不设“删除部分记录”的功能。

### 第三方与广告

扩展不包含第三方代码或脚本的执行（无远程代码）、不投放广告、不做分析统计、不与任何第三方共享数据。

### 联系方式

GitHub Issues：https://github.com/chnlich/smooth-bilibili-chrome-plugin/issues

---

## English

### What the extension does

On Bilibili video pages and live pages, the extension takes over the media segments (audio/video byte ranges) that the native player requests: a segment request from the player is answered from an in-memory cache; on a miss, the extension issues the same Range request to the media addresses that Bilibili supplied for that video, stores the bytes in memory, and then answers the player. It also asks the native player to keep a 120-second stable buffer. The extension does not take over playback: it never changes play, pause, seeking, playback rate, quality, volume, or audio/video track decisions.

### What data is handled, and where it stays

1. **Media segments (audio/video bytes)**: held in memory only, released as soon as the video route is left or the page is closed; never written to disk and never written to the diagnostic log.
2. **Development diagnostic log**: stored in the extension's own local IndexedDB database (`bilibili-development-logs`), append-only — never deleted, rotated, or capped by count or size. Log fields are limited to: site and path of the page address, video identifiers (such as bvid), part number, media identifier, media URLs with query/hash removed, media facts (buffered/seekable ranges, readyState, frame statistics, quality), extension actions, and safe error text. **Not stored**: query/hash, signed CDN parameters, cookies, account information, titles, page text, danmaku/chat, API bodies, audio/video data, frames, or screenshots. Values that cannot be read safely are recorded as “未提供” (not provided).
3. **Preferences**: a single on/off switch (video enhancement enabled or disabled) in `chrome.storage.local`.

### Data never leaves the device

The extension has no upload, telemetry, analytics, or any external endpoint. The only network requests the extension issues are the same media requests the player would issue, made on the player's behalf to the media addresses Bilibili's own playback info supplies for the current video (hosts limited to `*.bilivideo.com` and `*.akamaized.net`). Diagnostic logs, media segments, and preferences never leave the device. The extension does not read, store, or upload cookies.

### Viewing and export

Users can inspect the log at any time on the extension's log page. Export happens only when the user clicks export and picks a file in the browser's save dialog (JSONL format, kept by the user). There is no other path that takes data off the device.

### Retention

By design the diagnostic log is never rotated or deleted; it is kept until the user uninstalls the extension, which deletes the extension's IndexedDB and storage together with all data. There is no "delete part of the log" feature.

### Third parties and advertising

The extension executes no third-party or remote code, shows no advertising, performs no analytics, and shares no data with any third party.

### Contact

GitHub Issues: https://github.com/chnlich/smooth-bilibili-chrome-plugin/issues
