# Seamless for Bilibili 长期目标

本仓库唯一的产品目标，是让 Bilibili 视频与直播尽量少卡。

## 播放所有权

- 所有视频都使用 Bilibili 原生播放器。每次页面出现新的播放器或新的媒体内容时，扩展只向 Bilibili 原生下载器请求一次 120 秒稳定缓存目标；播放器或媒体内容更换后，再为新内容请求一次。
- 直播页（live.bilibili.com）只做下载接管与双路竞速，不设缓存目标、不预拉：播放器的媒体流请求由扩展应答或显式失败，不静默退回原生；同一内容存在 Bilibili 自带主备两路地址时并发竞速、先达字节供给，共同前缀比对一致才开放竞速交付，查无配对或前缀不一致则永久降级为播放器所名地址单腿接管。播放与一切选择不碰。
- The extension owns media-segment downloading on video pages: every media-segment request the player makes is answered by the extension — served from the in-memory bank on a hit, otherwise fetched by the extension issuing the same Range request on the player's behalf, concurrently to the URL the player named and to other URLs that Bilibili's own playurl response supplied for the same representation, keeping whichever response completes first — and it may prefetch ahead. URLs are never synthesized, substituted, or taken from any other source, and the URL the player named is always in use. When the extension cannot produce a valid response, the request is handed back to the player untouched. Segments live only in the download layer instance's memory and are released when the video route is left or the page is closed; they are never written to disk. Playback itself is not taken over: no self-built playback pipeline, no media URL replacement, and no change to any decision about quality, playback rate, seek, play/pause, audio and video tracks, or volume. Bilibili and the user continue to own playback and media. The popup shows only read-only observed facts, does not affect playback, does not upload.
- 用户对播放、暂停、拖动、倍速、画质和音量的控制永远有效，Bilibili 的选择同样保留。扩展只处理视频增强范围内的媒体与缓存事实，不修改浏览器对所有媒体的通用行为。

## 开发诊断日志

开发阶段每次刷新、进入新视频、新分 P 或新媒体条目都建立独立记录；每个视频页面都记录完整结构化日志。诊断初始化早于功能开关和增强控制器，因此功能关闭、无关支持路由、30 秒没有视频、启动错误、页面内切换以及播放器或媒体内容更换也会记录。日志只保存在扩展自己的本地数据库中，且只保留最近 3 天（72 小时）：超过 72 小时的事件按其自身记录的时间自动删除；一个记录（session）在其自身超过 72 小时且名下已无剩余事件时一并删除。删除只看记录自身的时间，不看条数或容量。72 小时内的记录仍只追加保存，不做压缩、摘要、截断、合并或轮转，不设置记录数量、单次记录或总容量上限。清理在扩展后台分小批进行，不等待、不阻塞播放与日志写入，失败照常全量报告。保留窗口内的日志只受物理磁盘、浏览器资料损坏、卸载和实际存储失败影响。

每条日志先同步显示在开发者控制台，再异步保存；只有本地数据库写入完成后才标记为已保存，存储失败会明确标记并继续显示在控制台，播放永远不等待日志。日志页可以选择当前记录或全部记录，先固定导出范围，再由用户选择文件、分页逐行导出 JSONL；导出开始后的新增日志继续保存但不进入本次文件。没有上传、遥测或外部日志端点。

日志只保存经过明确字段限制的信息：页面地址中必要的站点和路径、视频编号、分 P、媒体编号、去除 query/hash 的媒体地址、媒体事实、扩展动作和安全错误；不保存 query/hash、签名 CDN 参数、Cookie、账号、标题、页面文字、弹幕/聊天、API body、音视频数据、帧或截图。不可直接读取的数值写“未提供”；浏览器报告的数值 0 原样保留并标明浏览器报告。

## 缺陷诊断依据

用户报告的缺陷，成因判定以用户实际运行时记录的诊断日志为准，不以行为复现作为成因证据。另起一个浏览器重演操作只能说明重演环境里发生了什么，不能说明用户那一次发生了什么。修复完成后的验证仍按「自动化约束」执行，本节只约束成因判定。

日志没有记下判定所需的事实时，正确的回应是说出缺哪条记录、该补哪个字段，先补日志再谈成因，不得用复现结果替代缺失的记录。用户运行的构建早于所需记录时，结论是这份历史日志无法判定成因，需换上记录该事实的构建、重新收集日志之后再下结论。

## 自动化约束

确定性 Playwright/Chromium 浏览器测试必须使用 fresh temporary profile；真实 Bilibili 页面验证使用仓库外的专用持久化 profile，该 profile 可以使用为验证准备的一次性 Bilibili 登录态。不得使用用户日常使用的 Chrome profile。所有自动化浏览器都必须使用 Chromium `--mute-audio`，并在 document-start 对所有媒体安装静音 guard；fixture 也不得产生音频。真实页面验证受匿名页面、登录、编解码器或网络环境阻挡时，必须诚实报告 `BLOCKED` 并保留诊断证据。
