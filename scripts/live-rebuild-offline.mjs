// Offline check of the FLV backup rebuild rule against real recordings, plus the recorder that
// makes them. The check runs the extension's own FlvSegmentRebuilder (src/bank/flv-rebuild.js):
// the first segment it can place calibrates, every later segment is rebuilt from FLV frames and the
// playlist's EXT-BILI-AUX values alone, and a rebuilt segment counts only when its length and CRC32
// match the playlist; it is then also compared byte for byte with the recorded file. The calibration
// segment is rebuilt as well, from the template and mfhd sequence calibration read off it, and is
// reported separately (calibrationSelfCheck) so the counts for later segments stay predictions.
//
//   node scripts/live-rebuild-offline.mjs record <roomId> <seconds> <dir> [avc|hevc] [qn]
//   node scripts/live-rebuild-offline.mjs check <dir> [<dir> ...]
//
// Recording layout (one room, one stream name, both routes pulled at the same time):
//   stream.flv          raw FLV bytes of the room's FLV route
//   playlist_NNNN.m3u8  every fMP4 playlist fetched, in order
//   <init>.m4s          the EXT-X-MAP init segment
//   <name>.m4s          every media segment that appeared after the first playlist
// Recordings are third-party broadcast content: keep them outside the repository and delete them
// after the check. The check feeds the whole FLV recording at once (no 30 s window), so it proves the
// segmentation and timing rule, not arrival timing.

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  FlvSegmentRebuilder,
  FlvTagReader,
  parseBiliPlaylist,
  rebuildSegment,
  segmentStartState,
} from '../src/bank/flv-rebuild.js';
import { flvStreamNameOf, hlsStreamNameOf, hlsStreamPathOf, urlFromLiveUrlInfo } from '../src/bank/live.js';

const REQUEST_HEADERS = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/' };

function usage() {
  throw new Error('usage: live-rebuild-offline.mjs record <roomId> <seconds> <dir> [avc|hevc] [qn] | check <dir> [<dir> ...]');
}

async function readFlvFrames(file) {
  const bytes = new Uint8Array(await fs.readFile(file));
  const reader = new FlvTagReader();
  const frames = [];
  for (let offset = 0; offset < bytes.byteLength; offset += 65536) {
    frames.push(...reader.push(bytes.subarray(offset, offset + 65536)));
  }
  return frames;
}

async function checkRecording(directory) {
  const names = (await fs.readdir(directory)).sort();
  const aux = new Map();
  for (const name of names.filter((entry) => /^playlist_\d+\.m3u8$/.test(entry))) {
    const playlist = parseBiliPlaylist(await fs.readFile(path.join(directory, name), 'utf8'));
    for (const entry of playlist.entries) aux.set(entry.name, entry);
  }
  const segments = names.filter((name) => name.endsWith('.m4s') && aux.has(name))
    .sort((left, right) => aux.get(left).msn - aux.get(right).msn);
  const rebuilder = new FlvSegmentRebuilder({ windowMs: Number.POSITIVE_INFINITY });
  rebuilder.appendFrames(await readFlvFrames(path.join(directory, 'stream.flv')));
  const counts = { verified: 0, mismatch: 0, frames_missing: 0, waiting: 0, byteDiffers: 0 };
  let calibratedOn;
  let calibrationSelfCheck = null;
  const compare = (result, real) => {
    if (result.status !== 'verified') return result.status === 'mismatch' ? `built ${result.bytes} bytes` : '';
    const same = Buffer.from(result.bytes).equals(Buffer.from(real));
    if (!same) counts.byteDiffers += 1;
    return same ? 'bytes identical' : 'BYTES DIFFER FROM RECORDING';
  };
  for (const name of segments) {
    const entry = aux.get(name);
    const real = new Uint8Array(await fs.readFile(path.join(directory, name)));
    if (!rebuilder.calibrated) {
      const outcome = rebuilder.noteRealSegment(entry, real);
      console.log(`${name} dur=${entry.duration} ${entry.key ? 'K' : 'N'} calibration ${outcome.calibrated ? 'ok' : outcome.reason}`);
      if (!outcome.calibrated) continue;
      calibratedOn = name;
      const start = segmentStartState(rebuilder.video, rebuilder.calibration.timing, entry);
      const self = start.state === 'found'
        ? rebuildSegment({
          frameWindow: rebuilder.frameWindow,
          calibration: rebuilder.calibration,
          aux: entry,
          seq: rebuilder.chain.get(entry.msn).seq,
          startIndex: start.index,
        })
        : { status: 'frames_missing' };
      calibrationSelfCheck = self.status;
      console.log(`${name} self-check ${self.status} ${compare(self, real)}`.trimEnd());
      continue;
    }
    const result = rebuilder.attempt(entry);
    counts[result.status] += 1;
    let note = compare(result, real);
    if (result.status !== 'verified') {
      // The network would have delivered this one; it re-anchors the segment chain.
      rebuilder.noteRealSegment(entry, real);
      if (result.status === 'mismatch') note = `${note}, playlist says ${entry.size}`;
    }
    console.log(`${name} dur=${entry.duration} ${entry.key ? 'K' : 'N'} ${result.status} ${note}`.trimEnd());
  }
  const rebuilt = counts.verified + counts.mismatch + counts.frames_missing + counts.waiting;
  const summary = {
    recording: directory,
    calibratedOn: calibratedOn ?? null,
    calibrationSelfCheck,
    segments: segments.length,
    attempted: rebuilt,
    verified: counts.verified,
    mismatch: counts.mismatch,
    framesMissing: counts.frames_missing,
    waiting: counts.waiting,
    verifiedButBytesDiffer: counts.byteDiffers,
  };
  console.log(JSON.stringify(summary));
  return summary;
}

function routesFor(info, codec) {
  const found = {};
  for (const stream of info.data.playurl_info.playurl.stream) {
    for (const format of stream.format) {
      for (const entry of format.codec) {
        if (entry.codec_name !== codec) continue;
        found[format.format_name] = urlFromLiveUrlInfo(entry.url_info[0], entry.base_url);
      }
    }
  }
  if (found.fmp4 === undefined || found.flv === undefined) throw new Error(`room offers no fmp4+flv ${codec} pair`);
  const hlsName = hlsStreamNameOf(hlsStreamPathOf(new URL(found.fmp4).pathname));
  const flvName = flvStreamNameOf(new URL(found.flv).pathname);
  if (hlsName !== flvName) throw new Error(`fmp4 stream ${hlsName} and flv stream ${flvName} differ`);
  return found;
}

async function record(roomId, seconds, directory, codec, qn) {
  const infoUrl = 'https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo'
    + `?room_id=${roomId}&protocol=0,1&format=0,1,2&codec=0,1&qn=${qn}&platform=web&ptype=8`;
  const info = await (await fetch(infoUrl, { headers: REQUEST_HEADERS })).json();
  if (info.data?.playurl_info == null) throw new Error(`room ${roomId} is not live`);
  const routes = routesFor(info, codec);
  await fs.mkdir(directory, { recursive: true });
  const deadline = Date.now() + seconds * 1000;
  const controller = new AbortController();
  const flv = (async () => {
    const response = await fetch(routes.flv, { headers: REQUEST_HEADERS, signal: controller.signal });
    if (!response.ok) throw new Error(`flv HTTP ${response.status}`);
    const file = await fs.open(path.join(directory, 'stream.flv'), 'w');
    const reader = response.body.getReader();
    try {
      while (Date.now() < deadline) {
        const read = await reader.read();
        if (read.done) break;
        await file.write(read.value);
      }
    } finally {
      await file.close();
      controller.abort();
    }
  })();
  const fmp4 = (async () => {
    const playlistUrl = new URL(routes.fmp4);
    const seen = new Set();
    let count = 0;
    while (Date.now() < deadline) {
      const text = await (await fetch(playlistUrl, { headers: REQUEST_HEADERS })).text();
      count += 1;
      await fs.writeFile(path.join(directory, `playlist_${String(count).padStart(4, '0')}.m3u8`), text);
      const playlist = parseBiliPlaylist(text);
      const wanted = [playlist.mapUri, ...playlist.entries.map((entry) => entry.name)];
      if (count === 1) for (const entry of playlist.entries.slice(0, -1)) seen.add(entry.name);
      for (const name of wanted) {
        if (seen.has(name)) continue;
        seen.add(name);
        const response = await fetch(new URL(name, playlistUrl), { headers: REQUEST_HEADERS });
        if (!response.ok) throw new Error(`segment ${name} HTTP ${response.status}`);
        await fs.writeFile(path.join(directory, name), new Uint8Array(await response.arrayBuffer()));
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  })();
  await Promise.all([flv.catch((error) => {
    if (error?.name !== 'AbortError') throw error;
  }), fmp4]);
  console.log(JSON.stringify({
    recorded: directory,
    roomId,
    seconds,
    codec,
    qn,
    streams: { fmp4: new URL(routes.fmp4).pathname, flv: new URL(routes.flv).pathname },
    files: (await fs.readdir(directory)).length,
  }));
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'record') {
  if (rest.length < 3) usage();
  await record(rest[0], Number(rest[1]), rest[2], rest[3] ?? 'avc', rest[4] ?? '10000');
} else if (command === 'check') {
  if (rest.length === 0) usage();
  const summaries = [];
  for (const directory of rest) summaries.push(await checkRecording(directory));
  if (summaries.some((summary) => summary.verifiedButBytesDiffer > 0)) process.exitCode = 1;
} else {
  usage();
}
