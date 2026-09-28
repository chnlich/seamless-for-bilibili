# Seamless for Bilibili

Seamless for Bilibili is a Chrome extension that reduces playback stutter on Bilibili video and live pages. It is an independent third-party tool, not affiliated with or endorsed by Bilibili; Bilibili and related names belong to their respective owners.

[简体中文](README.md) | **English** (this file)

The user-facing part of this file is complete in English. The authoritative technical specification — the download layer, panel behaviour, and background-tab behaviour — lives in Chinese in [README.md](README.md); this file gives an English overview and links to it, so every fact has one home.

Long-term product constraints: [GOAL.md](GOAL.md). Privacy policy (bilingual): [PRIVACY.md](PRIVACY.md). Store listing materials: [store/README.md](store/README.md).

## What it is and who it is for

If video or live streams on Bilibili stutter while your own connection tests fine, this extension is built for that situation. It takes over the player's media downloads: the same content is downloaded at the same time from the two mirror addresses that Bilibili itself provides, and whichever arrives first is used; on video pages it also asks the native player to keep a 120-second buffer. Both video and live are supported.

It does not take over playback. Play, pause, seeking, playback speed, quality, volume, and track selection remain yours and Bilibili's; the extension never rewrites or substitutes any Bilibili address.

## Assumptions, and what it does not fix

The design rests on three assumptions:

1. Stutter often comes from an individual Bilibili CDN host being slow or unstable — not from the viewer's own connection;
2. Bilibili's own playback info (playurl) already lists primary and backup mirror addresses for the same content;
3. Your bandwidth is above the video bitrate, with headroom to download two copies at once.

It fixes the slow host, not the slow link: if your home connection itself is too narrow, the buffer keeps shrinking and the stall eventually comes anyway — the extension cannot prevent that. Stalls caused by the browser's decode side (buffer still full while playback freezes, for example hardware decode starving) are also outside its reach.

About ten seconds after a tab goes to the background, Chrome stops video decoding and keeps only audio. That is the browser's power-saving behaviour; the extension neither changes it nor works around it (see the FAQ).

## How it works

**Video pages** (`/video/*` and `/list/watchlater*`, one shared enhancement): the extension intercepts the player's media-segment requests on both interception channels (`fetch` and XHR). Each 1 MiB segment is requested from both mirror addresses Bilibili provides at once; the first complete response is stored in memory and served to the player, the losing leg is cancelled. Prefetch runs ahead (a window of up to 48 segments, 4 concurrent). Segments live only in memory (up to 512 MiB per tab) and are released when you leave the video route or close the page — nothing is written to disk. Each time a new player or media item appears, the extension asks the native player once for a 120-second stable buffer.

**Live pages** (live.bilibili.com): the extension takes over the player's FLV live stream. It only pairs the primary and backup addresses of the same cluster (for example 07 with 07b); after comparing the beginning of both legs byte-for-byte and finding them identical, it downloads both legs concurrently and hands the player whichever bytes arrive first. If no pair is found or the comparison disagrees, it falls back to a single-leg takeover of the address the player named. Live gets no prefetch and no buffer target.

On both page types, download-layer failures are reported explicitly rather than silently falling back to the player's own download. The authoritative behaviour spec (in Chinese) is the [download-layer section of README.md](README.md#下载层); product constraints are in [GOAL.md](GOAL.md).

## The cost — traffic comes first

Judge this against your data plan before installing:

- **Video racing waste**: bytes already downloaded by the losing leg are discarded. One measured run settled at about 12.6% steady-state waste (it varies per session; the CDN racing panel on the logs page shows the actual rate for the current session).
- **Live is close to double traffic**: while paired, both legs download continuously, so traffic approaches twice the single-leg amount.
- **Downloaded ahead**: the 120-second buffer target and prefetch fetch data you have not watched yet; leave the video early and those bytes were spent for nothing.
- **Memory**: the per-tab media cache holds up to about 512 MiB.
- **Disk**: the local diagnostic log keeps only the last 3 days (72 hours); older records are deleted automatically. Measured on the developer's own browser, an open video page adds about 7 MB per hour, so disk use is roughly bounded by the last 3 days of usage; uninstalling the extension deletes all of it.
- **Switches**: the popup carries two switches, both effective after a page reload. "视频增强" (video enhancement) applies to video pages only and "直播增强" (live enhancement) to live pages only. If you do not want live's double traffic, turn off the live switch; video enhancement is unaffected.

![Popup over a video page](store/images/screenshot-01-popup-video.png)

## The popup

The popup is read-only: it shows observed facts, affects no playback, and uploads nothing. Two always-visible switches sit at the top (effective after a page reload): "视频增强" for video pages and "直播增强" for live pages, each independent of the other.

- **Buffer**: a bar and the line "已缓冲 N 秒 / 目标 120 秒" (N seconds buffered / 120-second target). The number is the continuous playable forward range covering the current playhead, not the whole video's buffer; the bar turns green when the 120-second target is reached.
- **120-second request state**: the result of asking the player for the 120-second buffer — 已生效 (applied) / 等待生效 (waiting) / 播放器不支持 (player does not support it) / 申请失败 (request failed).
- **Download lines**: every CDN line this playback actually used (usually two), each with a health word (正常 normal / 有停滞 stalled / 有错误 errors / 尚无数据 no data yet) and connection times ("通常 X 毫秒 · 慢时 Y 毫秒" — the line's first-byte latency P50 and P90).
- **Live pages** use the same layout: the same download-lines card plus one live-takeover line (正在按两条线路竞速下载 racing on two lines / 单路接管（无可用备用线路） single leg, no backup found / 接管请求失败 takeover request failed / 未接管（未发现 FLV 直播流） not taken over, no FLV live stream found / 等待直播数据 waiting for live data). Live has no buffer bar.
- On a page that is not playing, the cards fold away and a single friendly hint remains.

![Popup close-up](store/images/popup-video.png)

## Install

**Chrome Web Store**: the release is in preparation; the store link will be placed here once live. Until then, do not trust any installation page claiming to be this extension.

**Load unpacked from source**: requires Node.js 20+ and Chrome/Chromium 120+.

```sh
npm ci
npm run build
```

Enable developer mode in `chrome://extensions` and load `dist/extension`. The repo commits a directly loadable `dist/extension`; after changing source, rebuild, click "Reload" on the extensions page, and refresh open Bilibili pages.

## Privacy

Data never leaves the device: media segments only transit through memory, the diagnostic log stays in the extension's own local database, and there is no upload, telemetry, or any external endpoint. The extension requests only `storage` and `unlimitedStorage` — no `tabs`, no `downloads`, no host permissions. Full policy: [PRIVACY.md](PRIVACY.md) (bilingual).

## FAQ

**Will this always remove stutter?**
No. It targets the "one slow CDN host" class of stutter; a narrow home connection or a browser that cannot decode fast enough is beyond it (see [assumptions](#assumptions-and-what-it-does-not-fix)).

**Why does a background tab keep playing audio while the picture freezes?**
Chrome stops video decoding for background tabs (background video track optimization). When you switch back, the page itself rebuilds the player: the frame counter restarts from zero and the buffer collapses and refills. This is browser behaviour; the extension does not change it or work around it. Details in the [background-tab section of README.md](README.md#浏览器后台行为) (Chinese).

**The buffer bar never reaches 120 seconds?**
That means the connection cannot keep up with the current bitrate. The extension spends the available bandwidth on what the player actually needs; it cannot keep a buffer from draining on a slow link.

**Can live be switched off separately?**
Yes. The "直播增强" (live enhancement) switch in the popup controls live pages only (it takes effect after a page reload): with it off, the player downloads natively — no takeover, no racing — and video enhancement is unaffected.

**Does it touch playback controls?**
No. Play, pause, seeking, speed, quality, volume, and tracks stay with you and the player; the popup is read-only.

**What gets uploaded?**
Nothing. See [PRIVACY.md](PRIVACY.md).

## Feedback

Issues and suggestions: https://github.com/chnlich/seamless-for-bilibili/issues

## License

[MIT](LICENSE).

---

## Technical overview (English)

The sections below describe how the implementation works. The full authoritative spec — exact interception rules, event names, and edge cases — is the Chinese [下载层 section of README.md](README.md#下载层); where this overview and that spec could ever disagree, that spec wins.

- **Interception.** The extension runs inside the page's own JavaScript context and wraps `fetch` and `XMLHttpRequest` (two parallel interception channels with identical behaviour). A request is recognized as a media segment when it carries a closed single-range header. Cache hits are answered from memory; on a miss the extension issues the player's identical Range request itself — to the address the player named and to other mirrors Bilibili's own playurl response lists for the same file — racing two legs per chunk (`raceLegs=2`) and keeping the first complete response. The player never issues a network request for an intercepted segment itself.
- **Video buffering.** The extension never builds a playback pipeline. It uses Bilibili's own player API to ask for a 120-second stable buffer, once per player or media item, and shows the player-reported forward range in the popup.
- **Live takeover.** On live pages the extension answers the player's FLV stream requests directly. Mirror pairing comes from Bilibili's own live playback info (the page-embedded `playurl_info` and the player's `getRoomPlayInfo` traffic); only same-cluster primary/backup pairs are raced, byte windows are compared between legs (1 MiB windows), and any disagreement permanently degrades that stream to the single address the player named. Both legs dying, or an expired signature with no new address, fails explicitly — no silent native fallback.
- **Bounds.** Segments live in a `Map` capped at 512 MiB per tab and are never written to disk; a fetch that receives no bytes for 10 s is cancelled and its partial chunk discarded; the prefetch window covers at most 48 chunks with 4 concurrent fetches and at most 3 consecutive failures per chunk.
- **Diagnostics.** A structured local-only log records page routes, media facts, and download-layer events; it keeps the last 3 days (72 hours) and deletes older records automatically, by each record's own time. The logs page states this retention. An export fixes its maxEventId snapshot when it starts; rows pruned out of that range while the export runs are skipped by the pagination and the export still completes. The logs page also includes a CDN racing panel with per-mirror racing, stall, latency, and waste statistics. The popup shows a deliberately small subset (buffer, download lines, connection times, live takeover state — including an explicit "not taken over" state when the player streams without FLV, instead of implying a takeover that never engaged).

Build, test, and verification commands are identical on any OS and are listed in the [build section of README.md](README.md#构建) and the [testing section of README.md](README.md#测试与验证) (both Chinese). The repo carries no device-specific paths.
