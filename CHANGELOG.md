# 更新日志 / Changelog

## 中文

### 1.2.3 · [release/1.2.3](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.2.3)

- 视频画面卡住、缓冲里还有 2 秒及以上数据时，弹窗「下载线路」卡片在「播放器解码没跟上，缓冲里还有 N 秒数据」下提示：部分电脑在 Chrome 设置 › 系统里关掉「使用图形加速功能」并重启 Chrome 后，这种卡顿就会消失。这条解码行优先于「还没有下载数据」，本次播放还没有任何下载记录时也会写出提示。

### 1.2.2 · [release/1.2.2](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.2.2)

- 弹窗「下载线路」卡片在播放器没暂停却播不动时分清两种原因：播放位置之后的缓冲不到 2 秒，仍写「正在等 m:ss 处的数据」；缓冲里还有 2 秒及以上数据，改写「播放器解码没跟上，缓冲里还有 N 秒数据」，第二行照常显示下载进度，不再把解码卡顿说成在等下载。
- 直播卡顿时，弹窗「下载线路」卡片说出此刻在等什么，不再一律写「空闲」：分片请求在途满 2 秒写「在等一个分片，已 N 秒没收到数据」（已收到部分字节时写「分片下载中，已 N 秒，收到 X KB」），在途线路写「等待中 N 秒」或已收到的字节；没有在途请求时，播放列表 3 秒以上没有新分片写「播放列表 N 秒没有新分片」（FLV 后备也没有新画面时后接「，FLV 后备也没有新画面」），播放列表 3 秒以上没刷新写「播放器 N 秒没有请求数据」。结束的线路另有「播放器已取消」「FLV 里没有这段画面」两种写法。

### 1.2.1 · [release/1.2.1](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.2.1)

- 视频页现在也接管 Bilibili 播放信息列出的 PCDN 等 CDN 地址，并可与路径不同的镜像地址竞速，避免这些请求绕过下载增强。
- 带语言前缀的视频页（如 `/zh-Hans/video/…`、`/en/video/…`）现在也启用下载接管与 120 秒缓冲增强。
- 修复直播 FLV 后备在流中途丢帧后持续无法拼出分片的问题：用网络送达的分片重新校准，成功后恢复后续分片的拼接；交付前仍核对字节数与 CRC32。

### 1.2.0 · [release/1.2.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.2.0)

- 弹窗「下载线路」卡片改报此刻的下载状态：合计速度与每条线路（镜像服务器）的速度、视频提前下载到哪里、播放器卡住时在等哪里的数据和已重试了几轮、按设计暂停下载时直说暂停。原来累计的「有错误」「有停滞」和连接时间从弹窗去掉，「FLV 拼接 · 已补上 N 个分片」一行也一起去掉（FLV 后备本身照常参与竞速），历史仍留在日志页的 CDN 竞速面板。

### 1.1.0 · [release/1.1.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.1.0)

- fMP4 直播间（.m4s 分片）新增 FLV 后备：扩展从 Bilibili 自己的播放信息里读出同一直播间的同流名、同编码 FLV 地址，自己开一条 FLV 连接，把每个分片从 FLV 帧逐字节拼出，与两条网络线路一起竞速；字节数与 CRC32 都等于播放列表给出的值才参与竞速，对不上的丢弃、从不交给播放器。实测有这条后备时直播总流量为单路的 1.03 到 1.15 倍；拼接腿一直赶不上时约为单路的 2.3 倍。
- 弹窗「下载线路」一行：由 FLV 拼接腿补过分片的线路显示「FLV 拼接 · 已补上 N 个分片」，N 是本次播放里该线路的拼接腿补上的分片数。

### 1.0.0 · [release/1.0.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.0.0)

- 首次在 Chrome Web Store 发布。

## English

### 1.2.3 · [release/1.2.3](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.2.3)

- When a video freezes with 2 seconds or more still buffered, the download-lines card now hints beneath 「播放器解码没跟上，缓冲里还有 N 秒数据」 (the player's decoder is not keeping up; N seconds of data are still buffered) that on some computers turning off "Use graphics acceleration when available" in Chrome Settings › System and restarting Chrome stops these stalls. This decoder line takes priority over 「还没有下载数据」 (no download data yet), so the hint appears even when the playback has no download record yet.

### 1.2.2 · [release/1.2.2](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.2.2)

- The popup's download-lines card now tells two stalls apart when the player is not paused but cannot advance: with under 2 seconds buffered ahead it still reads 「正在等 m:ss 处的数据」 (waiting for the data at m:ss); with 2 seconds or more buffered it reads 「播放器解码没跟上，缓冲里还有 N 秒数据」 (the player's decoder is not keeping up; N seconds of data are still buffered), and the second line keeps showing the download progress, so a decoder stall is no longer reported as waiting for the download.
- When a live stream stalls, the download-lines card now says what the extension is waiting for instead of reading 「空闲」 (idle) throughout: a segment request in flight for 2 seconds or more reads 「在等一个分片，已 N 秒没收到数据」 (waiting for a segment, no data for N seconds), or 「分片下载中，已 N 秒，收到 X KB」 (segment downloading, N seconds so far, X KB received) once some bytes arrived, with the lines in flight reading 「等待中 N 秒」 (waiting N seconds) or the bytes received; with no request in flight, a playlist that has added no segment for 3 seconds or more reads 「播放列表 N 秒没有新分片」 (playlist has no new segment for N seconds), followed by 「，FLV 后备也没有新画面」 (, the FLV backup has no new frames either) when the FLV connection is silent too, and a playlist that has not refreshed for 3 seconds or more reads 「播放器 N 秒没有请求数据」 (the player has requested no data for N seconds). Finished lines gain two live-page texts: 「播放器已取消」 (the player cancelled the request) and 「FLV 里没有这段画面」 (the FLV has no frames for this segment).

### 1.2.1 · [release/1.2.1](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.2.1)

- Video pages now take over PCDN and other CDN addresses listed in Bilibili's playback info, including races between addresses with different paths, so these requests receive the download enhancement too.
- Video pages with a language prefix (such as `/zh-Hans/video/…` and `/en/video/…`) now receive download takeover and the 120-second buffer enhancement.
- Fixed the live FLV backup remaining unable to rebuild segments after frames drop mid-stream: a network-delivered segment recalibrates the rebuild, and successful calibration restores later rebuilds; byte length and CRC32 are still checked before delivery.

### 1.2.0 · [release/1.2.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.2.0)

- The popup's download-lines card now reports the current download state: the total speed and each mirror line's speed, how far ahead the video is downloaded, what the player is waiting for and how many retry rounds have failed while it stalls, and a plain statement when the extension pauses downloads by design. The cumulative 「有错误」/「有停滞」 words, the connection times, and the 「FLV 拼接 · 已补上 N 个分片」 row (FLV rebuild, N segments backfilled) leave the popup; the FLV backup itself keeps racing under the same rules, and the history stays on the logs page CDN panel.

### 1.1.0 · [release/1.1.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.1.0)

- fMP4 live rooms (.m4s segments) gain an FLV backup: the extension reads the same room's same-stream, same-codec FLV address from Bilibili's own playback info, opens its own FLV connection, and rebuilds each segment byte for byte from the FLV frames, racing it against the two network legs; a rebuilt segment joins the race only when its byte count and CRC32 both equal the values the playlist published, mismatches are discarded and never handed to the player. Measured with this backup in place, live traffic totals 1.03 to 1.15 times the single leg; about 2.3 times when the rebuild leg keeps lagging.
- Popup download-line row: a line whose segments were backfilled by the FLV rebuild leg shows 「FLV 拼接 · 已补上 N 个分片」 ("FLV rebuild · N segments backfilled"), N being the number of segments that leg rebuilt in the current playback.

### 1.0.0 · [release/1.0.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.0.0)

- First release on the Chrome Web Store.
