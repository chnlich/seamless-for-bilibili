// Browser run of the live FLV backup on one real live room: system Chrome with a fresh temporary
// profile, muted, headless unless --headed, the extension loaded unpacked from dist/extension.
//
//   BILIBILI_E2E_CHROME=<chrome.exe> [BILIBILI_E2E_COMMIT_SHA=<sha>] node scripts/live-backup-run.mjs \
//     --room <roomId> --minutes <m> [--delay-every <n> --delay-ms <ms>] [--report <file>] [--headed]
//
// With --delay-every, every fMP4 media segment whose media sequence number is a multiple of n is
// held for --delay-ms before its request reaches the network, on every host, so both network legs
// stall together and only the FLV rebuild leg can deliver it in time. Holding starts
// --delay-after-ms (default 20000) after page load: the first network segment calibrates the
// rebuild, and before calibration there is no rebuild leg to race.
//
// Chrome runs with hardware video decode off, as the daily Chrome does; without hardware decode
// Chrome cannot play HEVC, so the room's player picks its AVC stream, as it does there.
//
// The report covers: playback continuity from a 200 ms in-page sampler of the video element (every
// stretch of 1 s or more where currentTime stops while the element is not paused), the winner of
// every served segment and of the delayed ones, the rebuild leg's results, FLV backup states and
// reconnects, network traffic by kind from CDP Network.dataReceived against the single-stream
// traffic (one copy of every served segment), a console classification, and provenance.
// Preflight asserts the Chrome executable, the built extension and that the room is live.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { findAvailablePort, resolveChromeExecutablePath } from './browser-runtime.mjs';
import { startConsoleCapture, triggerExtensionPositiveControl } from './console-capture.mjs';
import { installUnpackedExtension } from './install-unpacked-extension.mjs';
import { readStoredEvents } from './extension-log-pull.mjs';
import { readProvenance } from './provenance.mjs';
import { parseBiliPlaylist } from '../src/bank/flv-rebuild.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');

function parseArguments(argv) {
  const options = { headed: false, delayEvery: undefined, delayMs: undefined, delayAfterMs: 20000, report: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === '--headed') {
      options.headed = true;
      continue;
    }
    const value = argv[index + 1];
    index += 1;
    if (value === undefined) throw new Error(`${name} needs a value`);
    if (name === '--room') options.room = value;
    else if (name === '--minutes') options.minutes = Number(value);
    else if (name === '--delay-every') options.delayEvery = Number(value);
    else if (name === '--delay-ms') options.delayMs = Number(value);
    else if (name === '--delay-after-ms') options.delayAfterMs = Number(value);
    else if (name === '--report') options.report = value;
    else throw new Error(`unknown argument ${name}`);
  }
  if (!/^\d+$/.test(options.room ?? '')) throw new Error('--room <roomId> is required');
  if (!(options.minutes > 0)) throw new Error('--minutes <m> is required');
  if ((options.delayEvery === undefined) !== (options.delayMs === undefined)) {
    throw new Error('--delay-every and --delay-ms go together');
  }
  return options;
}

// Runs in every frame: silences media and samples the first video element five times a second.
const pageInit = () => {
  window.__liveSamples = [];
  setInterval(() => {
    for (const element of document.querySelectorAll('video,audio')) {
      element.muted = true;
      element.volume = 0;
    }
    const video = document.querySelector('video');
    if (video === null) return;
    let ahead = 0;
    for (let index = 0; index < video.buffered.length; index += 1) {
      if (video.buffered.start(index) <= video.currentTime && video.currentTime <= video.buffered.end(index)) {
        ahead = video.buffered.end(index) - video.currentTime;
      }
    }
    window.__liveSamples.push([Date.now(), video.currentTime, video.paused, video.readyState, ahead]);
  }, 200);
};

function segmentNameOf(url) {
  const pathname = new URL(url).pathname;
  return pathname.slice(pathname.lastIndexOf('/') + 1);
}

function trafficKind(url) {
  if (!URL.canParse(url)) return 'other';
  const pathname = new URL(url).pathname;
  if (pathname.endsWith('.flv')) return 'flv';
  if (pathname.endsWith('.m4s')) return 'm4s';
  if (pathname.endsWith('.m3u8')) return 'm3u8';
  return 'other';
}

// Playback discontinuities: stretches of at least minimumMs where currentTime does not move while
// the element is not paused (stop), where no video element was sampled at all (gap), and every
// backwards jump of currentTime, which means the player rebuilt its element or source (restart).
function playbackDiscontinuities(samples, minimumMs = 1000) {
  const found = [];
  let stuckSince;
  for (let index = 1; index < samples.length; index += 1) {
    const [at, currentTime, paused] = samples[index];
    const [previousAt, previousTime] = samples[index - 1];
    if (at - previousAt >= minimumMs) found.push({ kind: 'gap', from: previousAt, to: at, ms: at - previousAt });
    if (currentTime < previousTime) found.push({ kind: 'restart', from: previousAt, to: at, fromTime: previousTime, toTime: currentTime });
    const stuck = !paused && currentTime === previousTime;
    if (stuck && stuckSince === undefined) stuckSince = previousAt;
    if (!stuck && stuckSince !== undefined) {
      if (at - stuckSince >= minimumMs) found.push({ kind: 'stop', from: stuckSince, to: at, ms: at - stuckSince });
      stuckSince = undefined;
    }
  }
  const last = samples.at(-1);
  if (stuckSince !== undefined && last[0] - stuckSince >= minimumMs) {
    found.push({ kind: 'stop', from: stuckSince, to: last[0], ms: last[0] - stuckSince, open: true });
  }
  return found;
}

async function roomLiveStatus(room) {
  const response = await fetch(
    `https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${room}`,
    { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://live.bilibili.com/' } },
  );
  return (await response.json()).data;
}

function countBy(values) {
  const counts = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

// The session record (buildId) and the popup's live summary for one session.
async function readSessionFacts(context, extensionId, sessionId) {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/logs.html`, { waitUntil: 'domcontentloaded' });
    return await page.evaluate((id) => {
      const send = (message) => new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ version: 1, ...message }, (response) => {
          if (chrome.runtime.lastError !== undefined) reject(new Error(chrome.runtime.lastError.message));
          else if (response?.ok !== true) reject(new Error(response?.error?.message ?? 'log read rejected'));
          else resolve(response);
        });
      });
      return Promise.all([
        send({ type: 'logs:sessions-page', sessionId: id, limit: 1 }),
        send({ type: 'logs:live-summary', sessionId: id }),
      ]).then(([sessions, live]) => ({ session: sessions.sessions[0], facts: live.facts }));
    }, sessionId);
  } finally {
    await page.close();
  }
}

const options = parseArguments(process.argv.slice(2));
const chromeExecutablePath = await resolveChromeExecutablePath();
await fs.access(path.join(extensionDirectory, 'manifest.json'));
const roomInfo = { data: await roomLiveStatus(options.room) };
if (roomInfo.data?.live_status !== 1) throw new Error(`room ${options.room} is not live (live_status ${roomInfo.data?.live_status})`);
const provenance = await readProvenance({ rootDirectory: root, extensionDirectory });
const cdpPort = await findAvailablePort();
const profileDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'bilibili-live-backup-'));
const log = (line) => console.log(`[${new Date().toISOString()}] ${line}`);
const report = {
  room: options.room,
  minutes: options.minutes,
  injection: options.delayEvery === undefined
    ? null
    : { every: options.delayEvery, delayMs: options.delayMs, afterMs: options.delayAfterMs },
  provenance: {
    commitSha: process.env.BILIBILI_E2E_COMMIT_SHA ?? provenance.commitSha,
    buildId: provenance.buildId,
    profileDirectory,
    browserVersion: undefined,
    headless: !options.headed,
  },
};
const injections = [];
let injectFrom = Number.POSITIVE_INFINITY;
const traffic = { flv: 0, m4s: 0, m3u8: 0, other: 0 };
const aux = new Map();
const samples = [];
let context;
let consoleCapture;
try {
  context = await chromium.launchPersistentContext(profileDirectory, {
    executablePath: chromeExecutablePath,
    cdpPort,
    headless: !options.headed,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--mute-audio',
      '--enable-unsafe-extension-debugging',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-accelerated-video-decode',
    ],
  });
  report.provenance.browserVersion = context.browser().version();
  log(`provenance ${JSON.stringify(report.provenance)}`);
  const extensionId = await installUnpackedExtension(context.browser(), extensionDirectory);
  consoleCapture = await startConsoleCapture(cdpPort, extensionId);
  await triggerExtensionPositiveControl(context, extensionId, consoleCapture);
  await context.addInitScript({ content: `(${pageInit.toString()})()` });
  if (options.delayEvery !== undefined) {
    await context.route((url) => {
      const match = /\/(\d+)\.m4s$/.exec(url.pathname);
      return Date.now() >= injectFrom && match !== null && Number(match[1]) % options.delayEvery === 0;
    }, async (route) => {
      const url = route.request().url();
      const record = { at: Date.now(), name: segmentNameOf(url), host: new URL(url).hostname, delayMs: options.delayMs };
      injections.push(record);
      log(`inject hold ${record.name} ${record.host} ${options.delayMs} ms`);
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      try {
        await route.continue();
        record.outcome = 'continued';
      } catch (error) {
        // The request was cancelled while held (the rebuild leg won and aborted the network legs).
        record.outcome = `not_continued: ${error.message.split('\n')[0]}`;
      }
      log(`inject release ${record.name} ${record.host} ${record.outcome}`);
    });
  }
  const page = await context.newPage();
  page.on('response', (response) => {
    if (!new URL(response.url()).pathname.endsWith('.m3u8') || !response.ok()) return;
    void response.text().then((text) => {
      for (const entry of parseBiliPlaylist(text).entries) aux.set(entry.name, entry);
    }).catch((error) => log(`playlist read failed: ${error.message}`));
  });
  const network = await context.newCDPSession(page);
  const requestKinds = new Map();
  network.on('Network.requestWillBeSent', ({ requestId, request }) => requestKinds.set(requestId, trafficKind(request.url)));
  network.on('Network.dataReceived', ({ requestId, dataLength }) => {
    traffic[requestKinds.get(requestId) ?? 'other'] += dataLength;
  });
  await network.send('Network.enable');
  const startedAt = Date.now();
  injectFrom = startedAt + options.delayAfterMs;
  await page.goto(`https://live.bilibili.com/${options.room}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  const deadline = startedAt + options.minutes * 60000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(Math.min(30000, deadline - Date.now()));
    for (const frame of page.frames()) {
      const drained = await frame.evaluate(() => window.__liveSamples?.splice(0) ?? []).catch(() => []);
      samples.push(...drained);
    }
    const last = samples.at(-1);
    log(`progress samples=${samples.length} currentTime=${last?.[1]} readyState=${last?.[3]} ahead=${last?.[4]?.toFixed(2)} `
      + `traffic=${JSON.stringify(traffic)} injections=${injections.length}`);
  }
  samples.sort((left, right) => left[0] - right[0]);
  await page.close();
  // 1 = live; anything else means the broadcast ended during the run (2 = rotation, 0 = offline).
  report.liveStatusAtEnd = (await roomLiveStatus(options.room)).live_status;

  const stored = await readStoredEvents(context, extensionId);
  // The page may carry the room's short id and host the player in a frame of its own
  // (/blanc/<room>): take every session whose pathname names the room, and the one that served
  // segments as the player's.
  const roomIds = [String(roomInfo.data.room_id), String(roomInfo.data.short_id)];
  const roomSessions = stored.events.filter((event) => event.code === 'route.session_started'
    && typeof event.data?.pathname === 'string'
    && event.data.pathname.split('/').some((part) => roomIds.includes(part)));
  report.roomSessions = roomSessions.map((event) => ({ sessionId: event.sessionId, pathname: event.data.pathname }));
  const session = roomSessions.find((candidate) => stored.events.some((event) => event.sessionId === candidate.sessionId
    && event.code === 'bank.serve')) ?? roomSessions[0];
  const events = stored.events.filter((event) => event.sessionId === session?.sessionId);
  const serves = events.filter((event) => event.code === 'bank.serve' && event.data?.result === 'hit'
    && event.data?.reason?.startsWith('live_hls_segment'));
  const chunks = events.filter((event) => event.code === 'bank.fetch.chunk');
  const rebuildChunks = chunks.filter((event) => event.data?.slot === 2);
  const backupStates = events.filter((event) => event.code === 'live.flv.backup').map((event) => event.data);
  const winnerOf = new Map(serves.map((event) => [segmentNameOf(event.data.source), event.data.winner]));
  const delayedNames = [...new Set(injections.map((record) => record.name))];
  const rebuildResults = countBy(rebuildChunks.map((event) => (event.data.result === 'lost_race' && event.data.bytes > 0
    ? 'lost_race_after_build'
    : event.data.result)));
  const built = (rebuildResults.fetched ?? 0) + (rebuildResults.lost_race_after_build ?? 0) + (rebuildResults.crc_mismatch ?? 0);
  const deliveredRebuilds = rebuildChunks.filter((event) => event.data.result === 'fetched');
  const singleStreamBytes = chunks.filter((event) => event.data?.result === 'fetched'
    && new URL(event.data.source).pathname.endsWith('.m4s')).reduce((sum, event) => sum + event.data.bytes, 0);
  const stops = playbackDiscontinuities(samples);
  const nearDelayed = stops.filter((stop) => injections.some((record) => record.at <= stop.to + 1000
    && stop.from <= record.at + options.delayMs + 1000));
  const notable = new Set(['live.flv.backup', 'log.error', 'media.error', 'media.emptied', 'media.waiting', 'live.stream.stitch']);
  report.timeline = events.filter((event) => notable.has(event.code)
    || (event.code === 'bank.serve' && event.data?.result === 'failed'))
    .map((event) => ({ wallTime: event.wallTime, code: event.code, data: event.data })).slice(0, 200);
  if (session === undefined) {
    const pathnames = stored.events.filter((event) => event.code === 'route.session_started').map((event) => event.data?.pathname);
    throw new Error(`no extension session recorded for room ${options.room}; sessions: ${JSON.stringify(pathnames)}`);
  }
  const sessionFacts = await readSessionFacts(context, extensionId, session.sessionId);
  report.session = { sessionId: session.sessionId, buildId: sessionFacts.session?.buildId ?? null };
  report.playback = {
    samples: samples.length,
    firstCurrentTime: samples[0]?.[1],
    lastCurrentTime: samples.at(-1)?.[1],
    discontinuities: stops,
    discontinuitiesNearDelayedSegments: nearDelayed,
  };
  report.segments = {
    streams: [...new Set(serves.map((event) => {
      const pathname = new URL(event.data.source).pathname;
      return pathname.slice(0, pathname.lastIndexOf('/') + 1);
    }))],
    served: serves.length,
    winners: countBy(serves.map((event) => event.data.winner)),
    delayed: delayedNames.map((name) => ({ name, winner: winnerOf.get(name) ?? null })),
  };
  report.rebuild = {
    results: rebuildResults,
    crcMatchRate: built === 0 ? null : ((rebuildResults.fetched ?? 0) + (rebuildResults.lost_race_after_build ?? 0)) / built,
    // Every delivered rebuild must carry the playlist's byte length; the CRC32 check is in code.
    deliveredWithoutPlaylistSize: deliveredRebuilds.filter((event) => {
      const entry = aux.get(segmentNameOf(event.data.source));
      return entry === undefined || entry.size !== event.data.bytes;
    }).map((event) => segmentNameOf(event.data.source)),
  };
  report.flvBackup = {
    timeline: backupStates.slice(0, 40),
    states: countBy(backupStates.map((state) => state.state)),
    reconnects: backupStates.filter((state) => state.state === 'reconnecting').length,
    reasons: countBy(backupStates.filter((state) => state.reason !== undefined).map((state) => `${state.state}:${state.reason}`)),
    mirrors: [...new Set(backupStates.map((state) => state.mirror).filter((mirror) => mirror !== undefined))],
  };
  report.traffic = {
    bytes: traffic,
    singleStreamBytes,
    totalMediaOverSingleStream: singleStreamBytes === 0 ? null : (traffic.flv + traffic.m4s) / singleStreamBytes,
    networkLegsOverSingleStream: singleStreamBytes === 0 ? null : traffic.m4s / singleStreamBytes,
  };
  report.errors = countBy(events.filter((event) => event.code === 'log.error').map((event) => `${event.data?.code}: ${event.data?.message}`));
  report.popupFacts = sessionFacts.facts;
  report.console = consoleCapture.verdict();
  report.consoleEvents = countBy(consoleCapture.events
    .filter((event) => event.positiveControl !== true && (event.level === 'error' || event.kind === 'exception'))
    .map((event) => `${event.source} ${event.kind} ${event.text.slice(0, 160)}`));
  report.injections = injections;
} finally {
  await consoleCapture?.close();
  await context?.close();
  await fs.rm(profileDirectory, { recursive: true, force: true });
}

const output = `${JSON.stringify(report, null, 2)}\n`;
if (options.report !== undefined) await fs.writeFile(options.report, output, 'utf8');
console.log(output);
