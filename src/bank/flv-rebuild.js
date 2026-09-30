// FLV 后备拼接的纯函数：FLV 标签解析、fMP4 分片解析、播放列表 AUX 解析、CRC32、
// 校准、按规则选帧与逐字节拼装。不接触网络、计时器与页面。
//
// 拼装规则（离线录制实测，覆盖转码档、原画档、HEVC、60 fps、关键帧间隔 2/3/4.17 秒
// 与不规则关键帧的直播间，见 scripts/live-rebuild-offline.mjs）：
// - 每个关键帧开新分片；分片内解码时间距分片首帧满 1000 毫秒的帧开新分片。
// - 分片内解码时间距当前小片段（一对 moof+mdat）首帧满 250 毫秒的帧开新小片段。
// - 音频帧归入时间落在 [本小片段首个视频帧, 下一小片段首个视频帧) 的小片段；
//   时间相同则按 FLV 标签顺序，排在该视频帧之前到达的归前一个。
// - FLV 时间戳与 CTS 只有毫秒（原值截断到毫秒），fMP4 用 90 kHz（视频）与 48 kHz（音频）
//   的原值。校准分片给出锚点与栅格：帧的原值 = 锚点 + 栅格 × round(毫秒差 × 时基 / 栅格)。
//   毫秒派生的流栅格即每毫秒一格；按帧率或 AAC 帧长（1024）走格的流落在各自栅格上。

export const SEGMENT_TICKS = 90000;
export const FRAGMENT_TICKS = 22500;
const VIDEO_TICKS_PER_MS = 90;
const AUDIO_TICKS_PER_MS = 48;
// 1/60 秒（90 kHz）。有的 30 fps 转码档偶尔走半帧（时长与 CTS 为 1500 的奇数倍），校准分片
// 未必碰到；视频栅格取与 1500 的公约数，FLV 毫秒截断误差（小于 2 毫秒）仍远小于半格。
const HALF_FRAME_TICKS = 1500;

const TFHD_BASE_DATA_OFFSET = 0x1;
const TFHD_SAMPLE_DESCRIPTION_INDEX = 0x2;
const TFHD_DEFAULT_DURATION = 0x8;
const TFHD_DEFAULT_SIZE = 0x10;
const TFHD_DEFAULT_FLAGS = 0x20;
const TFHD_DEFAULT_BASE_IS_MOOF = 0x20000;
const TRUN_DATA_OFFSET = 0x1;
const TRUN_FIRST_SAMPLE_FLAGS = 0x4;
const TRUN_SAMPLE_DURATION = 0x100;
const TRUN_SAMPLE_SIZE = 0x200;
const TRUN_SAMPLE_FLAGS = 0x400;
const TRUN_SAMPLE_CTS = 0x800;
// ISO/IEC 14496-12 的样本标志：sample_depends_on=2 为同步帧；非同步帧沿用 tfhd 默认标志。
const SYNC_SAMPLE_FLAGS = 0x02000000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function hexValue(text, label) {
  if (!/^[0-9a-fA-F]+$/.test(text)) throw new Error(`播放列表 ${label} 不是十六进制: ${text}`);
  return Number.parseInt(text, 16);
}

// 播放列表：#EXT-BILI-AUX:<首帧显示时间毫秒>|<K 或 N>|<字节数>|<CRC32>，均为十六进制，
// CRC32 不补前导零。分片名取 URI 行去掉 query 的最后一段。
export function parseBiliPlaylist(text) {
  const lines = text.split(/\r?\n/);
  let mediaSequence;
  let mapUri;
  let pendingAux;
  let pendingDuration;
  let index = 0;
  const entries = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length));
      if (!Number.isSafeInteger(mediaSequence)) throw new Error(`播放列表媒体序号无效: ${line}`);
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const match = /URI="([^"]+)"/.exec(line);
      if (match === null) throw new Error(`播放列表 EXT-X-MAP 缺少 URI: ${line}`);
      mapUri = match[1].split('?', 1)[0];
      continue;
    }
    if (line.startsWith('#EXT-BILI-AUX:')) {
      const fields = line.slice('#EXT-BILI-AUX:'.length).split('|');
      if (fields.length < 4 || (fields[1] !== 'K' && fields[1] !== 'N')) {
        throw new Error(`播放列表 EXT-BILI-AUX 格式无效: ${line}`);
      }
      pendingAux = {
        ptsMs: hexValue(fields[0], '显示时间'),
        key: fields[1] === 'K',
        size: hexValue(fields[2], '字节数'),
        crc: hexValue(fields[3], 'CRC32'),
      };
      continue;
    }
    if (line.startsWith('#EXTINF:')) {
      pendingDuration = Number.parseFloat(line.slice('#EXTINF:'.length));
      continue;
    }
    if (line.startsWith('#')) continue;
    if (mediaSequence === undefined) throw new Error('播放列表分片出现在 EXT-X-MEDIA-SEQUENCE 之前');
    const name = line.split('?', 1)[0].split('/').at(-1);
    if (pendingAux !== undefined) {
      entries.push({ name, msn: mediaSequence + index, duration: pendingDuration, ...pendingAux });
    }
    index += 1;
    pendingAux = undefined;
    pendingDuration = undefined;
  }
  return { mediaSequence, mapUri, entries };
}

// FLV 标签增量解析：输入任意切分的字节块，输出完整的视频帧与音频帧。
// 视频只收 AVC（7）与 HEVC（12）的 NALU 包，音频只收 AAC 原始帧；序列头、
// 脚本标签与视频信息帧跳过。order 是标签在流里的次序，拼装时用来裁决同时刻的音视频。
// 流头标志不含视频时（实测：超清档 HEVC 的 FLV 地址只下发音频）直接判不可用。
// reason 取 flv_no_video 或 flv_codec_unsupported。
export class FlvUnsupportedError extends Error {
  constructor(message, reason = 'flv_codec_unsupported') {
    super(message);
    this.name = 'FlvUnsupportedError';
    this.reason = reason;
  }
}

export class FlvTagReader {
  constructor() {
    this.pending = new Uint8Array(0);
    this.headerDone = false;
    this.order = 0;
  }

  push(chunk) {
    const buffer = new Uint8Array(this.pending.byteLength + chunk.byteLength);
    buffer.set(this.pending, 0);
    buffer.set(chunk, this.pending.byteLength);
    let offset = 0;
    const frames = [];
    if (!this.headerDone) {
      if (buffer.byteLength < 9) {
        this.pending = buffer;
        return frames;
      }
      if (buffer[0] !== 0x46 || buffer[1] !== 0x4c || buffer[2] !== 0x56) throw new Error('FLV 头签名无效');
      if ((buffer[4] & 0x01) === 0) throw new FlvUnsupportedError('FLV 流不含视频', 'flv_no_video');
      const headerSize = ((buffer[5] << 24) | (buffer[6] << 16) | (buffer[7] << 8) | buffer[8]) >>> 0;
      if (buffer.byteLength < headerSize + 4) {
        this.pending = buffer;
        return frames;
      }
      offset = headerSize + 4;
      this.headerDone = true;
    }
    while (buffer.byteLength - offset >= 11) {
      const type = buffer[offset];
      const size = (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3];
      if (buffer.byteLength - offset < 11 + size + 4) break;
      const ts = ((buffer[offset + 7] << 24) | (buffer[offset + 4] << 16)
        | (buffer[offset + 5] << 8) | buffer[offset + 6]) >>> 0;
      const data = buffer.subarray(offset + 11, offset + 11 + size);
      const order = this.order;
      this.order += 1;
      const frame = type === 9 ? videoFrameOf(data, ts, order) : type === 8 ? audioFrameOf(data, ts, order) : undefined;
      if (frame !== undefined) frames.push(frame);
      offset += 11 + size + 4;
    }
    this.pending = buffer.slice(offset);
    return frames;
  }
}

function videoFrameOf(data, ts, order) {
  if (data.byteLength < 5) return undefined;
  if ((data[0] & 0x80) !== 0) throw new FlvUnsupportedError('FLV 扩展视频头不受支持');
  const frameType = data[0] >> 4;
  const codecId = data[0] & 0x0f;
  if (frameType === 5) return undefined;
  if (codecId !== 7 && codecId !== 12) throw new FlvUnsupportedError(`FLV 视频编码不受支持: ${codecId}`);
  if (data[1] !== 1) return undefined;
  const cts = ((data[2] << 16) | (data[3] << 8) | data[4]) << 8 >> 8;
  return { kind: 'video', ts, cts, key: frameType === 1, data: data.slice(5), order };
}

function audioFrameOf(data, ts, order) {
  if (data.byteLength < 2) return undefined;
  if (data[0] >> 4 !== 10) throw new FlvUnsupportedError(`FLV 音频编码不受支持: ${data[0] >> 4}`);
  if (data[1] !== 1) return undefined;
  return { kind: 'audio', ts, data: data.slice(2), order };
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function readInt32(bytes, offset) {
  return readUint32(bytes, offset) | 0;
}

function readUint64(bytes, offset) {
  return readUint32(bytes, offset) * 2 ** 32 + readUint32(bytes, offset + 4);
}

function boxesOf(bytes, start, end) {
  const boxes = [];
  let offset = start;
  while (offset < end) {
    if (end - offset < 8) throw new Error('fMP4 盒子头被截断');
    const size = readUint32(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (size < 8 || offset + size > end) throw new Error(`fMP4 盒子长度无效: ${type} ${size}`);
    boxes.push({ type, start: offset, payload: offset + 8, end: offset + size });
    offset += size;
  }
  return boxes;
}

function parseTraf(bytes, traf, moofStart) {
  const result = { trun: undefined };
  for (const child of boxesOf(bytes, traf.payload, traf.end)) {
    const body = child.payload;
    if (child.type === 'tfhd') {
      const flags = readUint32(bytes, body) & 0xffffff;
      let cursor = body + 8;
      result.trackId = readUint32(bytes, body + 4);
      result.tfhdFlags = flags;
      if (flags & TFHD_BASE_DATA_OFFSET) throw new Error('fMP4 tfhd base-data-offset 不受支持');
      if (flags & TFHD_SAMPLE_DESCRIPTION_INDEX) { result.sampleDescriptionIndex = readUint32(bytes, cursor); cursor += 4; }
      if (flags & TFHD_DEFAULT_DURATION) { result.defaultDuration = readUint32(bytes, cursor); cursor += 4; }
      if (flags & TFHD_DEFAULT_SIZE) { result.defaultSize = readUint32(bytes, cursor); cursor += 4; }
      if (flags & TFHD_DEFAULT_FLAGS) { result.defaultFlags = readUint32(bytes, cursor); cursor += 4; }
    } else if (child.type === 'tfdt') {
      result.tfdtVersion = bytes[body];
      result.baseTime = bytes[body] === 1 ? readUint64(bytes, body + 4) : readUint32(bytes, body + 4);
    } else if (child.type === 'trun') {
      if (result.trun !== undefined) throw new Error('fMP4 traf 含多个 trun，不受支持');
      const version = bytes[body];
      const flags = readUint32(bytes, body) & 0xffffff;
      const count = readUint32(bytes, body + 4);
      let cursor = body + 8;
      const trun = { version, flags, entries: [] };
      if (flags & TRUN_DATA_OFFSET) { trun.dataOffset = readInt32(bytes, cursor); cursor += 4; }
      if (flags & TRUN_FIRST_SAMPLE_FLAGS) { trun.firstSampleFlags = readUint32(bytes, cursor); cursor += 4; }
      for (let index = 0; index < count; index += 1) {
        const entry = {};
        if (flags & TRUN_SAMPLE_DURATION) { entry.duration = readUint32(bytes, cursor); cursor += 4; }
        if (flags & TRUN_SAMPLE_SIZE) { entry.size = readUint32(bytes, cursor); cursor += 4; }
        if (flags & TRUN_SAMPLE_FLAGS) { entry.flags = readUint32(bytes, cursor); cursor += 4; }
        if (flags & TRUN_SAMPLE_CTS) {
          entry.cts = version === 1 ? readInt32(bytes, cursor) : readUint32(bytes, cursor);
          cursor += 4;
        }
        trun.entries.push(entry);
      }
      result.trun = trun;
    } else {
      throw new Error(`fMP4 traf 子盒子不受支持: ${child.type}`);
    }
  }
  if (result.trackId === undefined || result.baseTime === undefined || result.trun === undefined) {
    throw new Error('fMP4 traf 缺少 tfhd/tfdt/trun');
  }
  if (!(result.tfhdFlags & TFHD_DEFAULT_BASE_IS_MOOF) || result.trun.dataOffset === undefined) {
    throw new Error('fMP4 traf 数据偏移不是相对 moof');
  }
  let dataCursor = moofStart + result.trun.dataOffset;
  let time = result.baseTime;
  result.samples = result.trun.entries.map((entry) => {
    const size = entry.size ?? result.defaultSize;
    const duration = entry.duration ?? result.defaultDuration;
    if (!Number.isSafeInteger(size) || !Number.isSafeInteger(duration)) throw new Error('fMP4 样本缺少长度或时长');
    const sample = { data: bytes.subarray(dataCursor, dataCursor + size), time, duration, cts: entry.cts ?? 0 };
    if (dataCursor + size > bytes.byteLength) throw new Error('fMP4 样本越过分片末尾');
    dataCursor += size;
    time += duration;
    return sample;
  });
  return result;
}

// 媒体分片 = 若干 moof+mdat 对；其他顶层盒子（styp、sidx 等）不受支持。
export function parseMediaSegment(bytes) {
  const fragments = [];
  for (const box of boxesOf(bytes, 0, bytes.byteLength)) {
    if (box.type === 'moof') {
      const fragment = { seq: undefined, trafs: [], hasMdat: false };
      for (const child of boxesOf(bytes, box.payload, box.end)) {
        if (child.type === 'mfhd') fragment.seq = readUint32(bytes, child.payload + 4);
        else if (child.type === 'traf') fragment.trafs.push(parseTraf(bytes, child, box.start));
        else throw new Error(`fMP4 moof 子盒子不受支持: ${child.type}`);
      }
      if (fragment.seq === undefined) throw new Error('fMP4 moof 缺少 mfhd');
      fragments.push(fragment);
    } else if (box.type === 'mdat') {
      if (fragments.length === 0 || fragments.at(-1).hasMdat) throw new Error('fMP4 mdat 前没有对应的 moof');
      fragments.at(-1).hasMdat = true;
    } else {
      throw new Error(`fMP4 顶层盒子不受支持: ${box.type}`);
    }
  }
  if (fragments.length === 0 || !fragments.every((fragment) => fragment.hasMdat)) {
    throw new Error('fMP4 分片没有完整的 moof+mdat');
  }
  return fragments;
}

function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

// 连续一段样本在帧序列里的起点：静止画面会出现字节相同的帧，所以按整段连续匹配。
export function matchFrameRun(frames, samples) {
  if (samples.length === 0) return -1;
  for (let start = 0; start + samples.length <= frames.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < samples.length; offset += 1) {
      if (!bytesEqual(frames[start + offset].data, samples[offset].data)) {
        matched = false;
        break;
      }
    }
    if (matched) return start;
  }
  return -1;
}

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function snap(base, delta, grid) {
  return base + grid * Math.round(delta / grid);
}

export function videoDecodeTime(timing, frame) {
  return snap(timing.video.base, (frame.ts - timing.video.flvTs) * VIDEO_TICKS_PER_MS, timing.video.grid);
}

export function videoPresentationTime(timing, frame) {
  return snap(
    timing.video.ptsBase,
    (frame.ts + frame.cts - timing.video.flvPts) * VIDEO_TICKS_PER_MS,
    timing.video.grid,
  );
}

export function audioTime(timing, frame, grid) {
  return snap(timing.audio.base, (frame.ts - timing.audio.flvTs) * AUDIO_TICKS_PER_MS, grid);
}

function trafTemplate(traf, kind) {
  const trun = traf.trun;
  if (trun.flags & TRUN_SAMPLE_FLAGS) return { error: 'template_unsupported' };
  if (!(trun.flags & TRUN_SAMPLE_SIZE)) return { error: 'template_unsupported' };
  if (kind === 'audio' && (trun.flags & (TRUN_SAMPLE_DURATION | TRUN_SAMPLE_CTS))) {
    return { error: 'template_unsupported' };
  }
  return {
    kind,
    trackId: traf.trackId,
    tfhdFlags: traf.tfhdFlags,
    sampleDescriptionIndex: traf.sampleDescriptionIndex,
    defaultDuration: traf.defaultDuration,
    defaultSize: traf.defaultSize,
    defaultFlags: traf.defaultFlags,
    tfdtVersion: traf.tfdtVersion,
    trunVersion: trun.version,
    trunFlags: trun.flags,
    firstSampleFlags: trun.firstSampleFlags,
  };
}

function sameTrafShape(left, right) {
  return left.trackId === right.trackId
    && left.tfhdFlags === right.tfhdFlags
    && left.sampleDescriptionIndex === right.sampleDescriptionIndex
    && left.defaultDuration === right.defaultDuration
    && left.defaultSize === right.defaultSize
    && left.defaultFlags === right.defaultFlags
    && left.tfdtVersion === right.tfdtVersion
    && left.trun.version === right.trun.version
    && left.trun.flags === right.trun.flags;
}

// 校准：一个真分片与 FLV 帧窗口对齐，得出拼装模板（traf 次序、轨道号、盒子标志）、
// 时间锚点与栅格、以及该分片的首帧与小片段序号。失败时给出原因，不抛异常。
export function calibrateFromSegment(segmentBytes, frameWindow) {
  const fragments = parseMediaSegment(segmentBytes);
  // 有的直播间发布只含一条轨的分片（实测 0.02 秒、只有音频）：它定不出两轨模板，只算这一个
  // 分片校准不上，等下一个分片。
  if (fragments.some((fragment) => fragment.trafs.length < 2)) return { ok: false, reason: 'track_missing' };
  const first = fragments[0];
  for (const fragment of fragments) {
    if (fragment.trafs.length !== 2) return { ok: false, reason: 'template_unsupported' };
    for (let index = 0; index < 2; index += 1) {
      if (!sameTrafShape(first.trafs[index], fragment.trafs[index])) return { ok: false, reason: 'template_unsupported' };
    }
  }
  const kinds = first.trafs.map((traf) => {
    if (matchFrameRun(frameWindow.video, traf.samples) !== -1) return 'video';
    if (matchFrameRun(frameWindow.audio, traf.samples) !== -1) return 'audio';
    return undefined;
  });
  if (kinds.includes(undefined)) return { ok: false, reason: 'frames_not_found' };
  if (!kinds.includes('video') || !kinds.includes('audio')) return { ok: false, reason: 'template_unsupported' };
  const videoIndex = kinds.indexOf('video');
  const audioIndex = kinds.indexOf('audio');
  const videoSamples = fragments.flatMap((fragment) => fragment.trafs[videoIndex].samples);
  const audioTrafs = fragments.map((fragment) => fragment.trafs[audioIndex]);
  const audioSamples = audioTrafs.flatMap((traf) => traf.samples);
  const videoStart = matchFrameRun(frameWindow.video, videoSamples);
  const audioStart = matchFrameRun(frameWindow.audio, audioSamples);
  if (videoStart === -1 || audioStart === -1) return { ok: false, reason: 'frames_not_found' };

  const template = [];
  for (const [index, kind] of kinds.entries()) {
    const shape = trafTemplate(first.trafs[index], kind);
    if (shape.error !== undefined) return { ok: false, reason: shape.error };
    template.push(shape);
  }
  const videoTemplate = template[videoIndex];
  const keyFlags = { key: SYNC_SAMPLE_FLAGS, nonKey: videoTemplate.defaultFlags };
  let frameCursor = videoStart;
  for (const fragment of fragments) {
    const traf = fragment.trafs[videoIndex];
    if (traf.trun.firstSampleFlags !== undefined) {
      if (frameWindow.video[frameCursor].key) keyFlags.key = traf.trun.firstSampleFlags;
      else keyFlags.nonKey = traf.trun.firstSampleFlags;
    }
    frameCursor += traf.samples.length;
  }
  videoTemplate.keyFlags = keyFlags;

  let grid = HALF_FRAME_TICKS;
  for (const sample of videoSamples) grid = gcd(gcd(grid, sample.duration), sample.cts);
  const anchor = frameWindow.video[videoStart];
  const timing = {
    video: {
      base: videoSamples[0].time,
      flvTs: anchor.ts,
      ptsBase: videoSamples[0].time + videoSamples[0].cts,
      flvPts: anchor.ts + anchor.cts,
      grid,
    },
    audio: { base: audioTrafs[0].baseTime, flvTs: frameWindow.audio[audioStart].ts, grids: [] },
  };
  for (const [offset, sample] of videoSamples.entries()) {
    const frame = frameWindow.video[videoStart + offset];
    if (videoDecodeTime(timing, frame) !== sample.time
      || videoPresentationTime(timing, frame) !== sample.time + sample.cts) {
      return { ok: false, reason: 'timing_mismatch' };
    }
  }
  // 音频两种走时：毫秒派生（每毫秒 48 格）或 AAC 帧长栅格；只留能复现全部小片段起点的候选。
  let audioCursor = audioStart;
  const audioStarts = audioTrafs.map((traf) => {
    const frame = frameWindow.audio[audioCursor];
    audioCursor += traf.samples.length;
    return { frame, time: traf.baseTime };
  });
  for (const candidate of [AUDIO_TICKS_PER_MS, template[audioIndex].defaultDuration]) {
    if (audioStarts.every(({ frame, time }) => audioTime(timing, frame, candidate) === time)) {
      timing.audio.grids.push(candidate);
    }
  }
  if (timing.audio.grids.length === 0) return { ok: false, reason: 'timing_mismatch' };
  return {
    ok: true,
    calibration: { template, timing },
    segment: {
      seq: first.seq,
      fragmentCount: fragments.length,
      startTs: anchor.ts,
    },
  };
}

// 分片选帧：从 startIndex 起按规则找到分片终点（下一分片首帧）与各小片段起点；
// 终点帧尚未到达时返回 undefined。
export function planSegment(video, startIndex, timing) {
  const segmentStart = videoDecodeTime(timing, video[startIndex]);
  const fragmentStarts = [startIndex];
  let fragmentStart = segmentStart;
  for (let index = startIndex + 1; index < video.length; index += 1) {
    const decodeTime = videoDecodeTime(timing, video[index]);
    if (video[index].key || decodeTime - segmentStart >= SEGMENT_TICKS) return { endIndex: index, fragmentStarts };
    if (decodeTime - fragmentStart >= FRAGMENT_TICKS) {
      fragmentStarts.push(index);
      fragmentStart = decodeTime;
    }
  }
  return undefined;
}

// 音频帧是否排在视频帧之前：比较两轨原值换算到同一单位后的时间，相同则看 FLV 标签次序。
function audioBefore(timing, audioFrame, audioGrid, videoFrame) {
  const audioScaled = audioTime(timing, audioFrame, audioGrid) * VIDEO_TICKS_PER_MS;
  const videoScaled = videoDecodeTime(timing, videoFrame) * AUDIO_TICKS_PER_MS;
  if (audioScaled !== videoScaled) return audioScaled < videoScaled;
  return audioFrame.order < videoFrame.order;
}

// 按 AUX 的首帧显示时间（毫秒，容差 1 毫秒）与关键帧标记定位分片首帧。
export function locateSegmentStart(video, timing, aux) {
  for (let index = 0; index < video.length; index += 1) {
    const frame = video[index];
    if (frame.key !== aux.key) continue;
    if (Math.abs(videoPresentationTime(timing, frame) / VIDEO_TICKS_PER_MS - aux.ptsMs) <= 1) return index;
  }
  return -1;
}

class ByteWriter {
  constructor(size) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
    this.offset = 0;
  }

  u8(value) { this.view.setUint8(this.offset, value); this.offset += 1; }

  u24(value) { this.u8((value >>> 16) & 0xff); this.u8((value >>> 8) & 0xff); this.u8(value & 0xff); }

  u32(value) { this.view.setUint32(this.offset, value >>> 0); this.offset += 4; }

  i32(value) { this.view.setInt32(this.offset, value); this.offset += 4; }

  u64(value) {
    this.u32(Math.floor(value / 2 ** 32));
    this.u32(value % 2 ** 32);
  }

  type(name) { for (const char of name) this.u8(char.charCodeAt(0)); }

  raw(bytes) { this.bytes.set(bytes, this.offset); this.offset += bytes.byteLength; }
}

function trafSize(shape, sampleCount) {
  let tfhd = 16;
  for (const flag of [TFHD_SAMPLE_DESCRIPTION_INDEX, TFHD_DEFAULT_DURATION, TFHD_DEFAULT_SIZE, TFHD_DEFAULT_FLAGS]) {
    if (shape.tfhdFlags & flag) tfhd += 4;
  }
  const tfdt = shape.tfdtVersion === 1 ? 20 : 16;
  let entry = 0;
  for (const flag of [TRUN_SAMPLE_DURATION, TRUN_SAMPLE_SIZE, TRUN_SAMPLE_CTS]) {
    if (shape.trunFlags & flag) entry += 4;
  }
  // trun 头：版本与标志 4、样本数 4、数据偏移 4（模板要求必有），首样本标志可选。
  let trunHead = 20;
  if (shape.trunFlags & TRUN_FIRST_SAMPLE_FLAGS) trunHead += 4;
  return 8 + tfhd + tfdt + trunHead + entry * sampleCount;
}

function writeFullBoxHeader(writer, size, type, version, flags) {
  writer.u32(size);
  writer.type(type);
  writer.u8(version);
  writer.u24(flags);
}

function writeTraf(writer, shape, track, dataOffset) {
  const start = writer.offset;
  const size = trafSize(shape, track.samples.length);
  writer.u32(size);
  writer.type('traf');
  let tfhdSize = 16;
  for (const flag of [TFHD_SAMPLE_DESCRIPTION_INDEX, TFHD_DEFAULT_DURATION, TFHD_DEFAULT_SIZE, TFHD_DEFAULT_FLAGS]) {
    if (shape.tfhdFlags & flag) tfhdSize += 4;
  }
  writeFullBoxHeader(writer, tfhdSize, 'tfhd', 0, shape.tfhdFlags);
  writer.u32(shape.trackId);
  if (shape.tfhdFlags & TFHD_SAMPLE_DESCRIPTION_INDEX) writer.u32(shape.sampleDescriptionIndex);
  if (shape.tfhdFlags & TFHD_DEFAULT_DURATION) writer.u32(shape.defaultDuration);
  if (shape.tfhdFlags & TFHD_DEFAULT_SIZE) writer.u32(shape.defaultSize);
  if (shape.tfhdFlags & TFHD_DEFAULT_FLAGS) writer.u32(shape.defaultFlags);
  writeFullBoxHeader(writer, shape.tfdtVersion === 1 ? 20 : 16, 'tfdt', shape.tfdtVersion, 0);
  if (shape.tfdtVersion === 1) writer.u64(track.baseTime);
  else writer.u32(track.baseTime);
  writeFullBoxHeader(writer, start + size - writer.offset, 'trun', shape.trunVersion, shape.trunFlags);
  writer.u32(track.samples.length);
  writer.i32(dataOffset);
  if (shape.trunFlags & TRUN_FIRST_SAMPLE_FLAGS) writer.u32(track.firstSampleFlags);
  for (const sample of track.samples) {
    if (shape.trunFlags & TRUN_SAMPLE_DURATION) writer.u32(sample.duration);
    if (shape.trunFlags & TRUN_SAMPLE_SIZE) writer.u32(sample.data.byteLength);
    if (shape.trunFlags & TRUN_SAMPLE_CTS) writer.i32(sample.cts);
  }
}

// 一个小片段的 moof+mdat；tracks 与模板一一对应（同序），每轨 { baseTime, firstSampleFlags, samples }。
export function buildFragment(template, seq, tracks) {
  const moofSize = 8 + 16 + template.reduce((sum, shape, index) => sum + trafSize(shape, tracks[index].samples.length), 0);
  const payloadSizes = tracks.map((track) => track.samples.reduce((sum, sample) => sum + sample.data.byteLength, 0));
  const mdatSize = 8 + payloadSizes.reduce((sum, size) => sum + size, 0);
  const writer = new ByteWriter(moofSize + mdatSize);
  writer.u32(moofSize);
  writer.type('moof');
  writeFullBoxHeader(writer, 16, 'mfhd', 0, 0);
  writer.u32(seq);
  let dataOffset = moofSize + 8;
  for (const [index, shape] of template.entries()) {
    writeTraf(writer, shape, tracks[index], dataOffset);
    dataOffset += payloadSizes[index];
  }
  writer.u32(mdatSize);
  writer.type('mdat');
  for (const track of tracks) for (const sample of track.samples) writer.raw(sample.data);
  return writer.bytes;
}

// 按规则把 [startIndex, plan.endIndex) 的视频帧与对应音频帧拼成分片。
export function buildSegment({ frameWindow, calibration, startIndex, plan, seq, audioGrid }) {
  const { template, timing } = calibration;
  const { video, audio } = frameWindow;
  const bounds = [...plan.fragmentStarts, plan.endIndex];
  let audioCursor = 0;
  while (audioCursor < audio.length && audioBefore(timing, audio[audioCursor], audioGrid, video[bounds[0]])) {
    audioCursor += 1;
  }
  const pieces = [];
  for (let fragmentIndex = 0; fragmentIndex < plan.fragmentStarts.length; fragmentIndex += 1) {
    const videoFrames = video.slice(bounds[fragmentIndex], bounds[fragmentIndex + 1]);
    const audioFrames = [];
    while (audioCursor < audio.length
      && audioBefore(timing, audio[audioCursor], audioGrid, video[bounds[fragmentIndex + 1]])) {
      audioFrames.push(audio[audioCursor]);
      audioCursor += 1;
    }
    if (audioFrames.length === 0) return undefined;
    const decodeTimes = [...videoFrames, video[bounds[fragmentIndex + 1]]].map((frame) => videoDecodeTime(timing, frame));
    const tracks = template.map((shape) => {
      if (shape.kind === 'video') {
        return {
          baseTime: decodeTimes[0],
          firstSampleFlags: videoFrames[0].key ? shape.keyFlags.key : shape.keyFlags.nonKey,
          samples: videoFrames.map((frame, index) => ({
            data: frame.data,
            duration: decodeTimes[index + 1] - decodeTimes[index],
            cts: videoPresentationTime(timing, frame) - decodeTimes[index],
          })),
        };
      }
      return {
        baseTime: audioTime(timing, audioFrames[0], audioGrid),
        firstSampleFlags: shape.firstSampleFlags,
        samples: audioFrames.map((frame) => ({ data: frame.data })),
      };
    });
    pieces.push(buildFragment(template, seq + fragmentIndex, tracks));
  }
  const total = pieces.reduce((sum, piece) => sum + piece.byteLength, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.byteLength;
  }
  return bytes;
}

// 一个分片的拼接尝试（首帧已定位）。waiting：终点帧或越过终点的音频尚未到达；
// verified：拼出的字节数与 CRC32 都等于播放列表所给的值；mismatch：拼出了但对不上
// （bytes 为最后一个候选的长度，某个小片段分不到音频时为 0）。
export function rebuildSegment({ frameWindow, calibration, aux, seq, startIndex }) {
  const { timing } = calibration;
  const { video, audio } = frameWindow;
  const plan = planSegment(video, startIndex, timing);
  if (plan === undefined) return { status: 'waiting' };
  const boundary = video[plan.endIndex];
  const grids = timing.audio.grids;
  const lastAudio = audio.at(-1);
  if (lastAudio === undefined || grids.some((grid) => audioBefore(timing, lastAudio, grid, boundary))) {
    return { status: 'waiting' };
  }
  let mismatchBytes = 0;
  for (const grid of grids) {
    const bytes = buildSegment({ frameWindow, calibration, startIndex, plan, seq, audioGrid: grid });
    if (bytes === undefined) continue;
    if (bytes.byteLength === aux.size && crc32(bytes) === aux.crc) {
      return { status: 'verified', bytes, fragmentCount: plan.fragmentStarts.length, audioGrid: grid };
    }
    mismatchBytes = bytes.byteLength;
  }
  return { status: 'mismatch', bytes: mismatchBytes };
}

// 分片首帧的定位状态：found 给出下标；waiting 表示窗口尚未推进到该时刻；
// missing 表示该时刻已不在窗口里或窗口已越过仍找不到。
export function segmentStartState(video, timing, aux) {
  const index = locateSegmentStart(video, timing, aux);
  if (index !== -1) return { state: 'found', index };
  if (video.length === 0) return { state: 'waiting' };
  const oldestMs = videoDecodeTime(timing, video[0]) / VIDEO_TICKS_PER_MS;
  const newestMs = videoDecodeTime(timing, video.at(-1)) / VIDEO_TICKS_PER_MS;
  if (aux.ptsMs < oldestMs || newestMs > aux.ptsMs + SEGMENT_TICKS / VIDEO_TICKS_PER_MS) return { state: 'missing' };
  return { state: 'waiting' };
}

// 拼接状态（不含网络）：FLV 帧窗口、校准结果与分片链。分片链按媒体序号记每个
// 已知分片的首个小片段序号、小片段数与首帧 FLV 时间戳；目标分片的小片段序号
// 取前一分片的延续，前一分片未知时从最近的已知分片按规则逐片推算。
export class FlvSegmentRebuilder {
  constructor({ windowMs }) {
    this.windowMs = windowMs;
    this.video = [];
    this.audio = [];
    this.calibration = undefined;
    this.chain = new Map();
  }

  get frameWindow() {
    return { video: this.video, audio: this.audio };
  }

  get calibrated() {
    return this.calibration !== undefined;
  }

  reset() {
    this.video = [];
    this.audio = [];
    this.calibration = undefined;
    this.chain.clear();
  }

  resetCalibration() {
    this.calibration = undefined;
    this.chain.clear();
  }

  appendFrames(frames) {
    for (const frame of frames) (frame.kind === 'video' ? this.video : this.audio).push(frame);
    const newest = Math.max(this.video.at(-1)?.ts ?? 0, this.audio.at(-1)?.ts ?? 0);
    const cutoff = newest - this.windowMs;
    let videoDrop = 0;
    while (videoDrop < this.video.length && this.video[videoDrop].ts < cutoff) videoDrop += 1;
    if (videoDrop > 0) this.video.splice(0, videoDrop);
    let audioDrop = 0;
    while (audioDrop < this.audio.length && this.audio[audioDrop].ts < cutoff) audioDrop += 1;
    if (audioDrop > 0) this.audio.splice(0, audioDrop);
  }

  recordSegment(msn, record) {
    this.chain.set(msn, record);
    for (const known of this.chain.keys()) {
      if (known < msn - 128) this.chain.delete(known);
    }
  }

  // 网络送达的真分片：未校准时拿它校准，已校准时记入分片链。
  noteRealSegment(aux, bytes) {
    if (this.calibration === undefined) {
      const result = calibrateFromSegment(bytes, this.frameWindow);
      if (!result.ok) return { calibrated: false, reason: result.reason };
      this.calibration = result.calibration;
      this.recordSegment(aux.msn, result.segment);
      return { calibrated: true };
    }
    const fragments = parseMediaSegment(bytes);
    const startIndex = locateSegmentStart(this.video, this.calibration.timing, aux);
    this.recordSegment(aux.msn, {
      seq: fragments[0].seq,
      fragmentCount: fragments.length,
      startTs: startIndex === -1 ? undefined : this.video[startIndex].ts,
    });
    return { calibrated: false };
  }

  seqFor(msn) {
    const previous = this.chain.get(msn - 1);
    if (previous !== undefined) return previous.seq + previous.fragmentCount;
    let anchorMsn;
    for (const [known, record] of this.chain) {
      if (known < msn && record.startTs !== undefined && (anchorMsn === undefined || known > anchorMsn)) anchorMsn = known;
    }
    if (anchorMsn === undefined) return undefined;
    const anchor = this.chain.get(anchorMsn);
    let index = this.video.findIndex((frame) => frame.ts === anchor.startTs);
    if (index === -1) return undefined;
    let seq = anchor.seq;
    for (let current = anchorMsn; current < msn; current += 1) {
      const plan = planSegment(this.video, index, this.calibration.timing);
      if (plan === undefined) return undefined;
      seq += plan.fragmentStarts.length;
      index = plan.endIndex;
    }
    return seq;
  }

  // 一次拼接尝试：waiting / frames_missing / verified（bytes）/ mismatch（bytes 为长度）。
  attempt(aux) {
    const start = segmentStartState(this.video, this.calibration.timing, aux);
    if (start.state === 'waiting') return { status: 'waiting' };
    if (start.state === 'missing') return { status: 'frames_missing' };
    const seq = this.seqFor(aux.msn);
    if (seq === undefined) return { status: 'frames_missing' };
    const result = rebuildSegment({
      frameWindow: this.frameWindow,
      calibration: this.calibration,
      aux,
      seq,
      startIndex: start.index,
    });
    if (result.status === 'verified') {
      this.calibration.timing.audio.grids = [result.audioGrid];
      this.recordSegment(aux.msn, {
        seq,
        fragmentCount: result.fragmentCount,
        startTs: this.video[start.index].ts,
      });
    }
    return result;
  }
}
