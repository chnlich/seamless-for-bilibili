import { BANK_CONFIG } from '../constants.js';
import { chunkIndex, isMediaHost } from './logic.js';

export function isLiveLocation(locationObject) {
  return locationObject !== undefined && locationObject.hostname === 'live.bilibili.com';
}

export function isLivePlayurlUrl(url) {
  const parsed = new URL(url);
  return parsed.hostname === 'api.live.bilibili.com' && parsed.pathname.endsWith('/getRoomPlayInfo');
}

export function classifyLiveRequest({ url, enabled = true, locationObject }) {
  if (enabled !== true) return { intercepted: false };
  const parsed = new URL(url, locationObject?.href);
  if (!isMediaHost(parsed.hostname)) return { intercepted: false, reason: 'non_media_host' };
  if (!parsed.pathname.endsWith('.flv')) return { intercepted: false, reason: 'live_non_flv' };
  return { intercepted: true, url: parsed.href };
}

export function liveUrlExpiresAt(url) {
  const raw = new URL(url).searchParams.get('expires');
  if (raw === null) return undefined;
  const expires = Number(raw);
  if (!Number.isSafeInteger(expires) || expires <= 0) return undefined;
  return expires * 1000;
}

export function visitLiveUrlInfoGroups(value, callback) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const item of value) visitLiveUrlInfoGroups(item, callback);
    return;
  }
  if (Array.isArray(value.url_info)) {
    const group = [];
    for (const info of value.url_info) {
      if (info === null || typeof info !== 'object') continue;
      if (typeof info.host !== 'string' || typeof info.extra !== 'string') continue;
      group.push({ host: info.host, extra: info.extra });
    }
    if (group.length > 0) callback(group);
  }
  for (const child of Object.values(value)) visitLiveUrlInfoGroups(child, callback);
}

function compareByteRegions(left, right) {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return index;
  }
  return -1;
}

// 直播流拼接器：双腿字节按偏移分窗累积，前缀门一致才进入竞速交付，
// 竞速中重叠窗口持续比对；降级与失败全部经回调上报，不接触网络与计时器。
export class LiveStreamStitcher {
  constructor({
    streamPath,
    legs,
    chunkBytes = BANK_CONFIG.chunkBytes,
    now = Date.now,
    emitChunk,
    emitStitch,
    deliver,
    cancelLeg,
    failStream,
    closeStream,
  }) {
    if (!Array.isArray(legs) || legs.length < 1 || legs.length > 2) {
      throw new Error('直播流腿数必须是 1 或 2');
    }
    this.streamPath = streamPath;
    this.chunkBytes = chunkBytes;
    this.now = now;
    this.callbacks = { emitChunk, emitStitch, deliver, cancelLeg, failStream, closeStream };
    this.bytesChecked = 0;
    this.closed = false;
    this.completionSequence = 0;
    this.deliveredOffset = 0;
    this.deliveredWindows = new Map();
    this.state = legs.length === 2 ? 'gating' : 'single';
    this.gateCompared = 0;
    this.legs = legs.map((meta) => ({
      slot: meta.slot,
      source: meta.source,
      mirror: meta.mirror,
      receivedTotal: 0,
      currentWindow: new Uint8Array(chunkBytes),
      windowFilled: 0,
      windowStartedAt: undefined,
      reportedInWindow: 0,
      ahead: new Map(),
      startedAt: this.now(),
      ttfbAt: undefined,
      done: false,
      dead: false,
    }));
  }

  legFor(slot) {
    return this.legs.find((leg) => leg.slot === slot);
  }

  noteLegBytes(slot, chunk) {
    if (this.closed) return;
    const leg = this.legFor(slot);
    if (leg === undefined || leg.dead || leg.done) {
      throw new Error('直播腿结束后仍收到字节');
    }
    if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) {
      throw new Error('直播腿字节必须是长度大于零的 Uint8Array');
    }
    if (leg.ttfbAt === undefined) leg.ttfbAt = this.now();
    let view = chunk;
    while (view.byteLength > 0) {
      const windowIndex = chunkIndex(leg.receivedTotal, this.chunkBytes);
      if (leg.windowStartedAt === undefined) leg.windowStartedAt = this.now();
      const portion = Math.min(this.chunkBytes - leg.windowFilled, view.byteLength);
      leg.currentWindow.set(view.subarray(0, portion), leg.windowFilled);
      leg.windowFilled += portion;
      leg.receivedTotal += portion;
      view = view.subarray(portion);
      if (leg.windowFilled === this.chunkBytes) this.completeWindow(leg, windowIndex);
    }
    this.progress();
  }

  noteLegDone(slot) {
    if (this.closed) return;
    const leg = this.legFor(slot);
    if (leg === undefined || leg.dead || leg.done) {
      throw new Error('直播腿重复结束');
    }
    if (leg.windowFilled > 0) {
      const windowIndex = chunkIndex(leg.receivedTotal, this.chunkBytes);
      const bytes = leg.currentWindow.slice(0, leg.windowFilled);
      this.completionSequence += 1;
      leg.ahead.set(windowIndex, {
        bytes,
        seq: this.completionSequence,
        startedAt: leg.windowStartedAt ?? leg.startedAt,
      });
      leg.currentWindow = new Uint8Array(this.chunkBytes);
      leg.windowFilled = 0;
      leg.reportedInWindow = 0;
      leg.windowStartedAt = undefined;
    }
    leg.done = true;
    if (this.state === 'gating') {
      if (this.legs.every((candidate) => candidate.done)) {
        this.resolveGateOnAllDone();
      } else if (leg.receivedTotal < this.chunkBytes) {
        // 门期内提前收完的腿无法承担整窗比对，剩余腿独跑。
        this.reportLegUnreported(leg, 'lost_race');
        this.legs.splice(this.legs.indexOf(leg), 1);
        this.state = 'single';
      }
    }
    this.progress();
  }

  noteLegDead(slot, outcome) {
    if (this.closed) return;
    const leg = this.legFor(slot);
    if (leg === undefined || leg.dead || leg.done) {
      throw new Error('直播腿重复死亡');
    }
    leg.dead = true;
    this.reportLegUnreported(leg, outcome);
    for (const delivered of this.deliveredWindows.values()) delivered.compared.add(slot);
    this.legs.splice(this.legs.indexOf(leg), 1);
    if (this.state === 'gating') {
      // 门期腿死（含备腿停滞）按单腿死处理：余腿独跑。
      this.state = 'single';
    }
    if (this.legs.length === 0) {
      this.failStreamNow();
      return;
    }
    if (this.legs.length === 1) this.state = 'single';
    this.progress();
  }

  abortStream() {
    if (this.closed) return;
    for (const leg of this.legs) this.reportLegUnreported(leg, 'aborted');
    this.legs = [];
    this.deliveredWindows.clear();
    this.closed = true;
  }

  completeWindow(leg, windowIndex) {
    const bytes = leg.currentWindow;
    leg.currentWindow = new Uint8Array(this.chunkBytes);
    this.completionSequence += 1;
    leg.ahead.set(windowIndex, {
      bytes,
      seq: this.completionSequence,
      startedAt: leg.windowStartedAt ?? leg.startedAt,
    });
    leg.windowFilled = 0;
    leg.reportedInWindow = 0;
    leg.windowStartedAt = undefined;
  }

  regionOf(leg, windowIndex) {
    const entry = leg.ahead.get(windowIndex);
    if (entry !== undefined) return entry.bytes;
    return leg.currentWindow.subarray(0, leg.windowFilled);
  }

  emitChunkNow(leg, windowIndex, result, bytes, entry) {
    const start = windowIndex * this.chunkBytes;
    const startedAt = entry?.startedAt ?? leg.windowStartedAt;
    const payload = {
      slot: leg.slot,
      source: leg.source,
      mirror: leg.mirror,
      chunkIndex: windowIndex,
      start,
      end: bytes > 0 ? start + bytes - 1 : start,
      bytes,
      durationMs: startedAt === undefined ? 0 : this.now() - startedAt,
      result,
    };
    if (windowIndex === 0 && leg.ttfbAt !== undefined) payload.ttfbMs = leg.ttfbAt - leg.startedAt;
    this.callbacks.emitChunk(payload);
  }

  emitLegWindowEvent(leg, result) {
    const windowIndex = chunkIndex(leg.receivedTotal, this.chunkBytes);
    const bytes = leg.windowFilled - leg.reportedInWindow;
    leg.reportedInWindow = leg.windowFilled;
    this.emitChunkNow(leg, windowIndex, result, bytes, undefined);
  }

  reportLegUnreported(leg, result) {
    const indices = [...leg.ahead.keys()].sort((left, right) => left - right);
    for (const windowIndex of indices) {
      const entry = leg.ahead.get(windowIndex);
      this.emitChunkNow(leg, windowIndex, result, entry.bytes.byteLength, entry);
      leg.ahead.delete(windowIndex);
    }
    this.emitLegWindowEvent(leg, result);
  }

  emitStitchNow(mismatch, phase) {
    this.callbacks.emitStitch({
      streamPath: this.streamPath,
      bytesChecked: this.bytesChecked,
      mismatch,
      phase,
    });
  }

  failStreamNow() {
    if (this.closed) return;
    this.closed = true;
    this.callbacks.failStream();
  }

  progress() {
    if (this.closed) return;
    if (this.state === 'gating') this.progressGate();
    if (this.closed || this.state === 'gating') return;
    if (this.state === 'racing') this.progressRacing();
    if (this.closed) return;
    if (this.state === 'single') this.progressSingle();
    if (this.closed) return;
    this.checkFinish();
  }

  progressGate() {
    if (this.legs.length !== 2) return;
    const [first, second] = this.legs;
    for (;;) {
      const limit = Math.min(first.receivedTotal, second.receivedTotal, this.chunkBytes);
      if (limit <= this.gateCompared) break;
      const start = this.gateCompared;
      const left = this.regionOf(first, 0).subarray(start, limit);
      const right = this.regionOf(second, 0).subarray(start, limit);
      const mismatchAt = compareByteRegions(left, right);
      if (mismatchAt !== -1) {
        this.bytesChecked += mismatchAt + 1;
        this.gateCompared += mismatchAt + 1;
        this.emitStitchNow(true, 'prefix');
        this.degradeToSingle(first.slot);
        return;
      }
      this.bytesChecked += limit - start;
      this.gateCompared = limit;
    }
    if (this.gateCompared >= this.chunkBytes) {
      this.state = 'racing';
      this.emitStitchNow(false, 'prefix');
    }
  }

  resolveGateOnAllDone() {
    const [first, second] = this.legs;
    const common = Math.min(first.receivedTotal, second.receivedTotal);
    if (common > this.gateCompared) {
      const left = this.regionOf(first, 0).subarray(this.gateCompared, common);
      const right = this.regionOf(second, 0).subarray(this.gateCompared, common);
      const mismatchAt = compareByteRegions(left, right);
      if (mismatchAt !== -1) {
        this.bytesChecked += mismatchAt + 1;
        this.emitStitchNow(true, 'prefix');
        this.degradeToSingle(first.slot);
        return;
      }
      this.bytesChecked += common - this.gateCompared;
    }
    if (first.receivedTotal !== second.receivedTotal) {
      this.emitStitchNow(true, 'prefix');
      this.degradeToSingle(first.slot);
      return;
    }
    this.state = 'racing';
    this.emitStitchNow(false, 'prefix');
  }

  degradeToSingle(keepSlot) {
    const keep = this.legs.find((leg) => leg.slot === keepSlot && !leg.dead);
    if (keep === undefined) {
      this.failStreamNow();
      return;
    }
    for (const leg of [...this.legs]) {
      if (leg === keep || leg.dead) continue;
      this.reportLegUnreported(leg, 'lost_race');
      leg.dead = true;
      this.legs.splice(this.legs.indexOf(leg), 1);
      this.callbacks.cancelLeg(leg.slot);
    }
    this.deliveredWindows.clear();
    this.state = 'single';
  }

  progressRacing() {
    if (this.state !== 'racing') return;
    for (;;) {
      const windowIndex = chunkIndex(this.deliveredOffset, this.chunkBytes);
      const start = windowIndex * this.chunkBytes;
      let winner;
      for (const leg of this.legs) {
        if (leg.dead) continue;
        const entry = leg.ahead.get(windowIndex);
        if (entry === undefined) continue;
        if (winner === undefined || entry.seq < winner.entry.seq) winner = { leg, entry };
      }
      if (winner === undefined) break;
      const end = start + winner.entry.bytes.byteLength - 1;
      this.emitChunkNow(winner.leg, windowIndex, 'fetched', winner.entry.bytes.byteLength, winner.entry);
      for (const other of this.legs) {
        if (other === winner.leg || other.dead) continue;
        const otherEntry = other.ahead.get(windowIndex);
        if (otherEntry !== undefined) {
          this.emitChunkNow(other, windowIndex, 'lost_race', otherEntry.bytes.byteLength, otherEntry);
        } else if (!other.done) {
          this.emitLegWindowEvent(other, 'lost_race');
        }
      }
      this.callbacks.deliver(winner.entry.bytes.slice(), start, end);
      this.deliveredOffset = end + 1;
      winner.leg.ahead.delete(windowIndex);
      this.deliveredWindows.set(windowIndex, {
        bytes: winner.entry.bytes,
        winnerSlot: winner.leg.slot,
        compared: new Set([winner.leg.slot]),
      });
      this.progressTripwire();
      if (this.closed || this.state !== 'racing') return;
    }
    this.progressTripwire();
  }

  progressTripwire() {
    if (this.closed || this.state !== 'racing') return;
    for (const [windowIndex, delivered] of [...this.deliveredWindows]) {
      for (const leg of this.legs) {
        if (leg.dead || leg.slot === delivered.winnerSlot || delivered.compared.has(leg.slot)) continue;
        const entry = leg.ahead.get(windowIndex);
        if (entry === undefined) continue;
        const mismatchAt = compareByteRegions(entry.bytes, delivered.bytes);
        this.bytesChecked += mismatchAt === -1 ? delivered.bytes.byteLength : mismatchAt + 1;
        delivered.compared.add(leg.slot);
        leg.ahead.delete(windowIndex);
        if (mismatchAt === -1) continue;
        this.emitStitchNow(true, 'stream');
        const winner = this.legFor(delivered.winnerSlot);
        if (winner === undefined || winner.dead) {
          this.failStreamNow();
          return;
        }
        this.degradeToSingle(winner.slot);
        return;
      }
      const open = this.legs.some((leg) => {
        if (leg.dead || leg.slot === delivered.winnerSlot || delivered.compared.has(leg.slot)) return false;
        return !leg.done || leg.ahead.has(windowIndex);
      });
      if (!open) this.deliveredWindows.delete(windowIndex);
    }
  }

  progressSingle() {
    const leg = this.legs[0];
    if (leg === undefined) return;
    while (this.deliveredOffset < leg.receivedTotal) {
      const windowIndex = chunkIndex(this.deliveredOffset, this.chunkBytes);
      const start = windowIndex * this.chunkBytes;
      const targetEnd = Math.min(leg.receivedTotal, start + this.chunkBytes);
      const region = this.regionOf(leg, windowIndex);
      const piece = region.subarray(this.deliveredOffset - start, targetEnd - start);
      this.callbacks.deliver(piece.slice(), this.deliveredOffset, targetEnd - 1);
      this.deliveredOffset = targetEnd;
      if (targetEnd === start + this.chunkBytes) {
        this.emitChunkNow(leg, windowIndex, 'fetched', targetEnd - start, leg.ahead.get(windowIndex));
      }
    }
    if (leg.done && this.deliveredOffset === leg.receivedTotal
      && leg.receivedTotal % this.chunkBytes !== 0) {
      const windowIndex = chunkIndex(leg.receivedTotal, this.chunkBytes);
      this.emitChunkNow(
        leg,
        windowIndex,
        'fetched',
        leg.receivedTotal - windowIndex * this.chunkBytes,
        leg.ahead.get(windowIndex),
      );
    }
  }

  checkFinish() {
    if (this.closed || this.legs.length === 0) return;
    if (!this.legs.every((leg) => leg.done)) return;
    if (this.state === 'gating') return;
    this.deliveredWindows.clear();
    this.closed = true;
    this.callbacks.closeStream();
  }
}
