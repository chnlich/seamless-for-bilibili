import { LIVE_INVENTORY_CONFIG } from '../constants.js';

const MAX_TRACKED_STREAMS = 8;
const MAX_SEEN_SEGMENT_NAMES = 512;

function ageSince(at, since) {
  return since === undefined ? null : at - since;
}

// 直播在途快照：记下播放器此刻在等什么，卡顿迹象成立时写成 live.inventory 事件，弹窗与日志
// 据此说出等的是分片请求、停更的播放列表还是不再请求的播放器。只观察，不改下载、竞速与
// 拼接。记三类事实：在途的分片请求（各腿的已收字节与距上次收字节的时间）、各流播放列表
// 的响应时间与新分片时间、当前流的 FLV 连接最近一次收到画面帧的时间。所有年龄按写快照
// 的时刻算。
// 当前流是最近一个分片请求所属的流；还没有分片请求时取最近播放列表所属的流。
// 卡顿迹象：有分片请求在途满 stallSignMs，或距上一次交付满 stallSignMs（还没交付过时从
// 第一个 HLS 信号起算；播放器直接拉 FLV 长连接的直播间没有这类信号，不会写快照）。
// 迹象成立期间每 snapshotIntervalMs 写一份；迹象不再成立时若这一轮已写过快照，再写一份
// delivered 为 true 的收尾快照，之后停止。播放器在一个分片挂住时还会请求并拿到后面的
// 分片：这些交付不让迹象消失（挂住的请求仍在途满 stallSignMs），这一轮继续按原节奏写。
export class LiveInventory {
  constructor({ now, timers, emit, isEnabled, flvLastFrameAt }) {
    this.now = now;
    this.timers = timers;
    this.emit = emit;
    this.isEnabled = isEnabled;
    this.flvLastFrameAt = flvLastFrameAt;
    this.requests = new Set();
    // 流目录 -> { responseAt, newSegmentAt, seenNames }
    this.streams = new Map();
    this.currentStreamPath = undefined;
    this.timer = undefined;
    // 计 stallSignMs 的起点：第一个 HLS 信号或最近一次交付的时刻。
    this.sinceAt = undefined;
    this.episodeActive = false;
    this.lastSnapshotAt = undefined;
  }

  arm() {
    if (this.timer !== undefined) return;
    this.sinceAt = this.now();
    this.timer = this.timers.setInterval(() => this.tick(), LIVE_INVENTORY_CONFIG.tickMs);
  }

  // legs 在每次写快照时现取：返回仍在下载的腿 [{ slot, mirror, bytes, lastByteAt }]。
  requestStarted({ streamPath, legs }) {
    this.arm();
    const request = { streamPath, startedAt: this.now(), legs };
    this.requests.add(request);
    this.currentStreamPath = streamPath;
    return request;
  }

  noteEnded(request) {
    this.requests.delete(request);
    this.closeSettledEpisode(this.now());
  }

  noteDelivered(request) {
    const at = this.now();
    this.requests.delete(request);
    this.sinceAt = at;
    this.closeSettledEpisode(at);
  }

  closeSettledEpisode(at) {
    if (!this.episodeActive || this.stallSignHolds(at)) return;
    this.episodeActive = false;
    this.emit(this.snapshot(at, true));
  }

  // 一份播放列表响应：名字没见过的分片算新分片。
  notePlaylist(streamPath, segmentNames) {
    this.arm();
    const at = this.now();
    let stream = this.streams.get(streamPath);
    if (stream === undefined) {
      stream = { responseAt: at, newSegmentAt: undefined, seenNames: new Set() };
      this.streams.set(streamPath, stream);
      while (this.streams.size > MAX_TRACKED_STREAMS) this.streams.delete(this.streams.keys().next().value);
    }
    stream.responseAt = at;
    for (const name of segmentNames) {
      if (stream.seenNames.has(name)) continue;
      stream.seenNames.add(name);
      stream.newSegmentAt = at;
    }
    while (stream.seenNames.size > MAX_SEEN_SEGMENT_NAMES) {
      stream.seenNames.delete(stream.seenNames.values().next().value);
    }
    if (this.currentStreamPath === undefined) this.currentStreamPath = streamPath;
  }

  stallSignHolds(at) {
    if (at - this.sinceAt >= LIVE_INVENTORY_CONFIG.stallSignMs) return true;
    for (const request of this.requests) {
      if (at - request.startedAt >= LIVE_INVENTORY_CONFIG.stallSignMs) return true;
    }
    return false;
  }

  // 接管关闭期间不写快照，重新开启后也不把关闭的时间算作没有交付。
  tick() {
    const at = this.now();
    if (!this.isEnabled()) {
      this.sinceAt = at;
      this.episodeActive = false;
      return;
    }
    if (!this.stallSignHolds(at)) return;
    if (this.episodeActive && at - this.lastSnapshotAt < LIVE_INVENTORY_CONFIG.snapshotIntervalMs) return;
    this.episodeActive = true;
    this.lastSnapshotAt = at;
    this.emit(this.snapshot(at, false));
  }

  snapshot(at, delivered) {
    const streamPath = this.currentStreamPath;
    const stream = this.streams.get(streamPath);
    return {
      streamPath,
      delivered,
      inflight: [...this.requests].map((request) => ({
        streamPath: request.streamPath,
        ageMs: at - request.startedAt,
        legs: request.legs().map((leg) => ({
          slot: leg.slot,
          mirror: leg.mirror,
          bytes: leg.bytes,
          lastByteAgeMs: ageSince(at, leg.lastByteAt),
        })),
      })),
      playlistResponseAgeMs: ageSince(at, stream?.responseAt),
      playlistNewSegmentAgeMs: ageSince(at, stream?.newSegmentAt),
      flvFrameAgeMs: ageSince(at, this.flvLastFrameAt(streamPath)),
    };
  }

  destroy() {
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
  }
}
