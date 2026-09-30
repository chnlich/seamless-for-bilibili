import { FlvSegmentRebuilder, FlvTagReader, FlvUnsupportedError } from './flv-rebuild.js';
import { liveUrlExpiresAt } from './live.js';

// 拼接腿失败：result 取 crc_mismatch（拼出但长度或 CRC32 对不上，bytes 为拼出长度）
// 或 frames_missing（窗口里没有该分片的帧、等待超时或连接已断）。
export class FlvRebuildFailure extends Error {
  constructor(result, bytes = 0) {
    super(`FLV 后备拼接未交付: ${result}`);
    this.name = 'FlvRebuildFailure';
    this.result = result;
    this.bytes = bytes;
  }
}

function abortError() {
  return new DOMException('The operation was aborted', 'AbortError');
}

// FLV 后备连接：为播放器正在拉的 fMP4 流另开一条 Bilibili 地址簿给出的同名同编码 FLV
// 连接，帧进滚动窗口，按分片请求拼出同一分片。连接的字节从不直接交给播放器。
// 断线后连续重连最多 maxReconnects 次，一条连接连续供帧满一个窗口后计数清零；
// 用尽后记 given_up 并全量报错，分片继续只走网络腿。
export class LiveFlvBackup {
  constructor({
    hlsStreamPath,
    resolveUrls,
    fetchImpl,
    credentials,
    timers,
    now,
    emitState,
    reportError,
    config,
  }) {
    this.hlsStreamPath = hlsStreamPath;
    this.resolveUrls = resolveUrls;
    this.fetchImpl = fetchImpl;
    this.credentials = credentials;
    this.timers = timers;
    this.now = now;
    this.emitStateCallback = emitState;
    this.reportError = reportError;
    this.config = config;
    this.rebuilder = new FlvSegmentRebuilder({ windowMs: config.windowMs });
    this.pending = new Set();
    this.closed = false;
    this.reconnects = 0;
    this.attempt = 0;
    this.calibrationFailures = 0;
    this.connection = undefined;
    this.reconnectTimer = undefined;
    this.url = undefined;
    this.lastHeaders = undefined;
  }

  get mirror() {
    return this.url === undefined ? undefined : new URL(this.url).hostname;
  }

  get streamPath() {
    return this.url === undefined ? this.hlsStreamPath : new URL(this.url).pathname;
  }

  get ready() {
    return !this.closed && this.rebuilder.calibrated;
  }

  emitState(state, reason) {
    const payload = { state, streamPath: this.streamPath };
    if (this.mirror !== undefined) payload.mirror = this.mirror;
    if (reason !== undefined) payload.reason = reason;
    this.emitStateCallback(payload);
  }

  // 每次连接现取地址簿（签名可能已更新），跳过已过期的地址，在 Bilibili 给出的地址间轮换。
  pickUrl() {
    const lookup = this.resolveUrls();
    if (lookup.urls === undefined) return { miss: lookup.miss };
    const usable = lookup.urls.filter((url) => {
      const expiresAt = liveUrlExpiresAt(url);
      return expiresAt === undefined || this.now() < expiresAt;
    });
    if (usable.length === 0) return { miss: 'address_expired' };
    const url = usable[this.attempt % usable.length];
    this.attempt += 1;
    return { url };
  }

  // 开连接；地址簿里没有可用地址时不开，返回缺失原因（由调用方记 unavailable）。
  start() {
    const picked = this.pickUrl();
    if (picked.url === undefined) return picked.miss;
    this.url = picked.url;
    void this.connect();
    return undefined;
  }

  async connect() {
    const controller = new AbortController();
    const connection = {
      controller,
      stallTimer: undefined,
      reader: undefined,
      firstTs: undefined,
      fullWindow: false,
      stalled: false,
    };
    this.connection = connection;
    const tagReader = new FlvTagReader();
    const armStall = () => {
      if (connection.stallTimer !== undefined) this.timers.clearTimeout(connection.stallTimer);
      connection.stallTimer = this.timers.setTimeout(() => {
        connection.stalled = true;
        controller.abort();
        void connection.reader?.cancel().catch((error) => {
          if (error?.name !== 'AbortError') this.reportError('FLV 后备停滞读取取消失败', error);
        });
      }, this.config.stallMs);
    };
    armStall();
    let reason;
    let failure;
    try {
      const response = await this.fetchImpl(this.url, { credentials: this.credentials, signal: controller.signal });
      if (response.status < 200 || response.status >= 300) {
        reason = 'http_error';
        failure = new Error(`FLV 后备响应状态无效: ${response.status}`);
      } else {
        connection.reader = response.body.getReader();
        for (;;) {
          const read = await connection.reader.read();
          if (read.done) break;
          if (read.value.byteLength === 0) continue;
          armStall();
          this.noteFrames(connection, tagReader.push(read.value));
          if (this.closed || this.connection !== connection) return;
        }
        reason = 'stream_ended';
      }
    } catch (error) {
      if (this.closed || this.connection !== connection) return;
      if (error instanceof FlvUnsupportedError) {
        // 只有音频的 FLV 是地址本身的状况（同 no_flv_entry），不是扩展错误；编码不受支持才报错。
        if (error.reason !== 'flv_no_video') this.reportError('FLV 后备流格式不受支持', error);
        this.emitState('unavailable', error.reason);
        this.close();
        return;
      }
      reason = connection.stalled ? 'stalled' : 'network_error';
      failure = error;
    } finally {
      if (connection.stallTimer !== undefined) this.timers.clearTimeout(connection.stallTimer);
    }
    if (this.closed || this.connection !== connection) return;
    this.disconnected(reason, failure);
  }

  noteFrames(connection, frames) {
    if (frames.length === 0) return;
    const firstFrames = connection.firstTs === undefined;
    if (firstFrames) connection.firstTs = frames[0].ts;
    this.rebuilder.appendFrames(frames);
    if (firstFrames) this.emitState('connected');
    if (!connection.fullWindow && frames.at(-1).ts - connection.firstTs >= this.config.windowMs) {
      connection.fullWindow = true;
      this.reconnects = 0;
    }
    for (const request of [...this.pending]) this.progressRequest(request);
  }

  // 断线：新连接的时间戳重新起算，窗口、校准与分片链一并作废，等下一个网络分片重新校准。
  disconnected(reason, error) {
    this.connection = undefined;
    this.rebuilder.reset();
    this.failPending('frames_missing');
    if (this.reconnects >= this.config.maxReconnects) {
      this.emitState('given_up', reason);
      this.reportError('FLV 后备连接重连用尽', error ?? new Error(reason));
      this.close();
      return;
    }
    this.reconnects += 1;
    this.emitState('reconnecting', reason);
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.closed) return;
      const picked = this.pickUrl();
      if (picked.url === undefined) {
        this.disconnected(picked.miss, new Error(`FLV 后备无可用地址: ${picked.miss}`));
        return;
      }
      this.url = picked.url;
      void this.connect();
    }, this.config.reconnectDelayMs);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== undefined) this.timers.clearTimeout(this.reconnectTimer);
    const connection = this.connection;
    this.connection = undefined;
    if (connection !== undefined) {
      if (connection.stallTimer !== undefined) this.timers.clearTimeout(connection.stallTimer);
      connection.controller.abort();
      void connection.reader?.cancel().catch((error) => {
        if (error?.name !== 'AbortError') this.reportError('FLV 后备读取取消失败', error);
      });
    }
    this.failPending('frames_missing');
    this.rebuilder.reset();
  }

  // init 分片更换（播放列表 EXT-X-MAP 变了）后旧模板作废，等下一个网络分片重新校准。
  resetCalibration() {
    this.rebuilder.resetCalibration();
    this.failPending('frames_missing');
  }

  // 网络送达的真分片：记下响应头（拼接腿胜出时沿用），未校准时拿它校准，已校准时续分片链。
  // 连接供帧满一个窗口后仍连续 maxCalibrationAttempts 个分片校准不上，或分片结构不受支持，
  // 判这条流 unavailable 并关闭连接。
  noteNetworkSegment({ aux, bytes, headers }) {
    this.lastHeaders = headers;
    if (this.closed) return;
    const wasCalibrated = this.rebuilder.calibrated;
    let outcome;
    try {
      outcome = this.rebuilder.noteRealSegment(aux, bytes);
    } catch (error) {
      this.reportError('FLV 后备读取网络分片失败', error);
      return;
    }
    if (wasCalibrated) return;
    if (outcome.calibrated) {
      this.calibrationFailures = 0;
      this.emitState('calibrated');
      return;
    }
    if (outcome.reason !== 'template_unsupported') {
      // 连接供帧未满一个窗口时，网络分片可能早于窗口起点，找不到帧不算失败。
      if (this.connection?.fullWindow !== true) return;
      this.calibrationFailures += 1;
      if (this.calibrationFailures < this.config.maxCalibrationAttempts) return;
    }
    this.emitState('unavailable', `calibration_${outcome.reason}`);
    this.close();
  }

  // 拼接腿：返回 { promise, cancel }。promise 以 { bytes } 兑现（字节数与 CRC32 已核对），
  // 或以 FlvRebuildFailure 拒绝；等待最多 stallMs。
  requestSegment(aux) {
    let resolve;
    let reject;
    const promise = new Promise((resolveArg, rejectArg) => {
      resolve = resolveArg;
      reject = rejectArg;
    });
    const request = { aux, resolve, reject, timer: undefined, settled: false };
    request.timer = this.timers.setTimeout(() => {
      this.settle(request, undefined, new FlvRebuildFailure('frames_missing'));
    }, this.config.stallMs);
    this.pending.add(request);
    this.progressRequest(request);
    return {
      promise,
      cancel: () => this.settle(request, undefined, abortError()),
    };
  }

  settle(request, value, error) {
    if (request.settled) return;
    request.settled = true;
    this.pending.delete(request);
    this.timers.clearTimeout(request.timer);
    if (error === undefined) request.resolve(value);
    else request.reject(error);
  }

  failPending(result) {
    for (const request of [...this.pending]) this.settle(request, undefined, new FlvRebuildFailure(result));
  }

  progressRequest(request) {
    if (!this.rebuilder.calibrated) {
      this.settle(request, undefined, new FlvRebuildFailure('frames_missing'));
      return;
    }
    let result;
    try {
      result = this.rebuilder.attempt(request.aux);
    } catch (error) {
      this.reportError('FLV 后备拼接失败', error);
      this.settle(request, undefined, new FlvRebuildFailure('frames_missing'));
      return;
    }
    if (result.status === 'waiting') return;
    if (result.status === 'verified') this.settle(request, { bytes: result.bytes });
    else if (result.status === 'mismatch') this.settle(request, undefined, new FlvRebuildFailure('crc_mismatch', result.bytes));
    else this.settle(request, undefined, new FlvRebuildFailure('frames_missing'));
  }
}
