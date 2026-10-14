# 更新日志 / Changelog

## 中文

### 未发布

- 弹窗「下载线路」卡片改报此刻的下载状态：合计速度与每条线路（镜像服务器）的速度、视频提前下载到哪里、播放器卡住时在等哪里的数据和已重试了几轮、按设计暂停下载时直说暂停。原来累计的「有错误」「有停滞」和连接时间从弹窗去掉，历史仍留在日志页的 CDN 竞速面板。

### 1.1.0 · [release/1.1.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.1.0)

- fMP4 直播间（.m4s 分片）新增 FLV 后备：扩展从 Bilibili 自己的播放信息里读出同一直播间的同流名、同编码 FLV 地址，自己开一条 FLV 连接，把每个分片从 FLV 帧逐字节拼出，与两条网络线路一起竞速；字节数与 CRC32 都等于播放列表给出的值才参与竞速，对不上的丢弃、从不交给播放器。实测有这条后备时直播总流量为单路的 1.03 到 1.15 倍；拼接腿一直赶不上时约为单路的 2.3 倍。
- 弹窗「下载线路」一行：由 FLV 拼接腿补过分片的线路显示「FLV 拼接 · 已补上 N 个分片」，N 是本次播放里该线路的拼接腿补上的分片数。

### 1.0.0 · [release/1.0.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.0.0)

- 首次在 Chrome Web Store 发布。

## English

### Unreleased

- The popup's download-lines card now reports the current download state: the total speed and each mirror line's speed, how far ahead the video is downloaded, what the player is waiting for and how many retry rounds have failed while it stalls, and a plain statement when the extension pauses downloads by design. The cumulative 「有错误」/「有停滞」 words and the connection times leave the popup; the history stays on the logs page CDN panel.

### 1.1.0 · [release/1.1.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.1.0)

- fMP4 live rooms (.m4s segments) gain an FLV backup: the extension reads the same room's same-stream, same-codec FLV address from Bilibili's own playback info, opens its own FLV connection, and rebuilds each segment byte for byte from the FLV frames, racing it against the two network legs; a rebuilt segment joins the race only when its byte count and CRC32 both equal the values the playlist published, mismatches are discarded and never handed to the player. Measured with this backup in place, live traffic totals 1.03 to 1.15 times the single leg; about 2.3 times when the rebuild leg keeps lagging.
- Popup download-line row: a line whose segments were backfilled by the FLV rebuild leg shows 「FLV 拼接 · 已补上 N 个分片」 ("FLV rebuild · N segments backfilled"), N being the number of segments that leg rebuilt in the current playback.

### 1.0.0 · [release/1.0.0](https://github.com/chnlich/seamless-for-bilibili/tree/release/1.0.0)

- First release on the Chrome Web Store.
