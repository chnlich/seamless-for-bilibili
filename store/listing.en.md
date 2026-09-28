# Store listing draft (English)

Field-by-field draft for the Chrome Web Store Developer Dashboard. Name candidates and the final
decision live in [README.md](README.md); the user copy-pastes and submits. Every field is pre-filled
including all images.

Note: the item currently has a single default listing language (the manifest declares no `_locales`),
so the live listing will be the zh-CN draft ([listing.zh-CN.md](listing.zh-CN.md)). This English
draft is the ready-to-paste text for a future locale-specific listing once `_locales` ships.

## Store listing tab

- **Item name**: comes from the manifest (unchanged in this task). Recommended rename:
  "Anti-Stutter for Bilibili" — decision in README.md.
- **Summary**: not a dashboard field; the dashboard takes the manifest `description`. The live summary
  is the 107-character zh text. For a future `_locales/en` `description` (131 characters, counted as
  Unicode characters, within the 132 limit):
  Fewer stalls on Bilibili video/live: races two of Bilibili's own mirrors; 120 s buffer on video. Uses extra data. Nothing uploaded.
- **Detailed description** (paste-ready):

  ```text
  Cuts playback stalling on Bilibili video and live pages. An independent third-party tool, not affiliated with or endorsed by Bilibili; Bilibili and related names are trademarks of their respective owner.

  Assumptions and limits
  The extension rests on three assumptions: stalling often comes from one slow or unstable Bilibili CDN host, not from your own connection; Bilibili's own playback info already lists several primary/backup mirror addresses for the same content; and your bandwidth has headroom above the video bitrate, enough to download two copies at once. It rescues a slow host, not a slow link: if your home connection itself is too slow, it cannot help. Stalling caused by the browser's video decoder (the buffer is full and playback still stalls, e.g. hardware-decode underflow) is also outside what it can fix.

  Video pages: how it works
  Takes over the player's media segment downloads (both the fetch and XHR channels): every 1 MiB segment is requested from two mirror addresses Bilibili supplied, at once; the first complete response wins and the other is cancelled. It prefetches ahead (window up to 48 segments, concurrency 4). Segments stay in memory only (up to 512 MiB per tab), are released when the page is left, and are never written to disk. Once per video it asks Bilibili's native player to keep a 120-second buffer.

  Live pages: how it works
  Takes over the player's FLV live stream: pairs only the primary/backup addresses of the same cluster, checks that the first bytes of both legs match, then downloads both at once and hands the player whichever bytes arrive first. With no pair or a mismatch it falls back to a single download from the player's own address. No prefetch and no buffer target on live. If the player streams without FLV (some tournament rooms do), the takeover stays out and the popup says so honestly.

  What it never does, on either page type
  It uses no third-party addresses and never rewrites or substitutes Bilibili's addresses. It does not take over playback: play, pause, seeking, rate, quality, volume, and track choices stay with you and Bilibili's player.

  The cost — please weigh against your data plan
  Video: the bytes the losing leg already downloaded are discarded — about 12.6% steady-state waste in one real run (it varies per session; the CDN racing panel on the extension's log page shows the session's own wasted-byte ratio). The 120-second buffer and prefetch download ahead, so leaving a video early downloads more unwatched data than the native player would. Live: once paired, both legs keep downloading at once — close to twice the stream's traffic. Memory: up to about 512 MiB of media cache per tab. Disk: the local diagnostic log is never rotated and grows with use (measured on the developer's own browser: about 7 MB per hour a video page is open); uninstalling deletes it.
  Switch: the popup's "video enhancement" switch applies to video pages only (takes effect after a reload). Live takeover has no separate switch; to avoid the doubled live traffic, disable the extension in chrome://extensions.

  Data
  Media segments stay in memory. The development diagnostic log lives only in the extension's local IndexedDB: it records the path of each Bilibili page, video identifiers, media URLs without parameters, timings and results of media requests, player events (play, pause, seeking, and so on), and buffer state. It stores no cookies, account data, titles, page text, chat, signed parameters, or audio/video bytes. No upload, no telemetry; export happens only when you pick a file. Permissions are only storage (one switch) and unlimitedStorage (an unrotated local log); no host_permissions. Fully open source: https://github.com/chnlich/smooth-bilibili-chrome-plugin
  ```

- **Category**: Entertainment. The old "Productivity" group was split up in the mid-2023 category
  revision; Entertainment is the category for viewers of TV and cinema content, the closest fit for
  an extension that serves only Bilibili video and live viewing. Fallback: Tools.
- **Language**: the dashboard listing language for the default listing is 中文（简体）(zh-CN); add
  this English text as a locale-specific listing only after the manifest ships `_locales`.
- **Homepage URL**: https://github.com/chnlich/smooth-bilibili-chrome-plugin
- **Support URL**: https://github.com/chnlich/smooth-bilibili-chrome-plugin/issues
- **Official URL**: leave empty (optional; requires verifying the site in Google Search Console).
- **Mature content**: leave unchecked.

## Privacy practices tab

- **Single purpose description**:
  Reduce playback stalling on Bilibili video and live pages by taking over the player's media
  downloads (racing Bilibili's own primary/backup mirror addresses) and, on video pages, requesting a
  120-second buffer from the native player.
- **Permissions justification** (per item, exactly the manifest's permissions and matches):

  | Dashboard item | Paste text |
  |---|---|
  | `storage` | Stores exactly one user switch (video-page enhancement on/off) in chrome.storage.local so the popup preference survives restarts. Nothing else is stored. |
  | `unlimitedStorage` | The development diagnostic log is append-only by design and never rotated or capped (see GOAL.md in the repository); it lives in the extension's own origin IndexedDB and grows with use (measured on the developer's own browser: about 7 MB per hour a video page is open). unlimitedStorage removes the browser's default storage quota so appends do not start failing at the quota. The log stays on the device; the user can view or export it on the log page, and uninstalling deletes everything. |
  | Content script `https://www.bilibili.com/*` | Download takeover starts only on video routes (/video/* and /list/watchlater*): it intercepts the player's media segment requests, answers them from the in-memory cache or fetches them from the mirror addresses Bilibili supplied, and asks the player for a 120-second buffer. The match covers the whole site because the extension follows in-page route changes and must be in place at document_start; on other routes it intercepts nothing and only records the page path in the local diagnostic log. |
  | Content script `https://live.bilibili.com/*` | On live pages, takes over the player's FLV live stream and, after a prefix check, races the same-cluster primary/backup addresses Bilibili supplied (no prefetch, no buffer target). |
  | MAIN world injection (`world: "MAIN"`) | Three scripts must run in the page's own JavaScript realm: bank.js wraps the page's fetch/XMLHttpRequest to catch the player's media requests; source-buffer-shim.js observes the page's MediaSource/SourceBuffer appends and removals for local diagnostics; main-bridge.js calls the Bilibili player object's own buffer setting (setStableBufferTime). The MAIN world exposes no chrome.* APIs; the ISOLATED-world controller.js reads the preference and writes the log. |

  If the dashboard shows a single combined "Host permission" field, paste:
  The extension requests no host_permissions; it has two content-script matches: www.bilibili.com
  (download takeover and a 120-second buffer request on video routes only; other routes only record
  the page path in the local diagnostic log) and live.bilibili.com (FLV live-stream takeover, racing
  Bilibili's own primary/backup addresses). Media fetches run in the page context and go only to the
  address the player requested and the mirror addresses Bilibili's playback info lists for the same
  file.
- **Remote code**: select "No, I am not using remote code". All JavaScript is bundled from repository
  sources by esbuild at build time; nothing remote is loaded or executed at runtime (the sources
  contain no eval, new Function, remote script, or importScripts).
- **Data usage — which data is collected**: the User Data Policy FAQ states that data processed or
  stored only on the device must still be disclosed, so the boxes follow what the extension handles
  locally. Category definitions are quoted from the store's public disclosure pages.

  | Checkbox (store definition) | Answer | Reason |
  |---|---|---|
  | Web history ("The list of web pages a user has visited, as well as associated data such as page title and time of visit") | ✅ check | Every www.bilibili.com / live.bilibili.com page opened gets a log record with its path (query/hash stripped), video identifiers, and timestamps; no titles. On-device only, for defect diagnosis. |
  | User activity ("For example: network monitoring, clicks, mouse position, scroll, or keystroke logging") | ✅ check | The log records the player's media requests (URL without parameters, mirror host, timing, bytes, result) — network monitoring — and player events such as play, pause, seeking, rate and volume changes. No click positions, mouse, scroll, or keystrokes. On-device only. |
  | Website content ("For example: text, images, sounds, videos, or hyperlinks") | ✅ check | Media segments (audio/video bytes) pass through memory to feed the player; never written to disk, never logged, never sent anywhere. |
  | Personally identifiable information / Health / Financial and payment / Authentication / Personal communications / Location | ⬜ skip | The log explicitly stores no cookies, account data, titles, page text, chat, API bodies, audio/video bytes, frames, or screenshots; no location or IP is read; no form or password data is touched. |

- **Data usage — compliance certifications**: check all three (the public listing shows them as: not
  sold to third parties outside the approved use cases; not used or transferred for purposes unrelated
  to the item's core functionality; not used or transferred to determine creditworthiness or for
  lending). Reason: the extension has no external endpoint, so data never leaves the device; the only
  network requests it makes are the player's own media requests, to Bilibili's media addresses. If the
  dashboard shows a different number of statements, check each on the same reasoning.
- **Privacy policy URL**: https://github.com/chnlich/smooth-bilibili-chrome-plugin/blob/main/PRIVACY.md
  (the repository is public; the current PRIVACY.md must be on main before submitting — the URL is
  user-facing.)
- **Limited Use statement**: not applicable. That requirement covers data received from Google APIs;
  this extension uses no Google APIs, so PRIVACY.md deliberately makes no such statement (it would
  imply Google API data exists).

## Test instructions tab

Leave empty. The tab is not required for publishing and serves items that need restricted or paid
credentials; Bilibili video and live play without logging in.

## Distribution tab

- Visibility: public. Regions: all (default). Pricing: free.

## Image checklist

| Asset | Spec | Status |
|---|---|---|
| Store icon | 128×128 PNG (96×96 artwork + 16px transparent padding) | ✅ Done: `assets/icon.svg` → `npm run icons` renders the four sizes (16/32/48 crop to the artwork so the toolbar icon stays legible), committed with the package; upload `src/extension/icons/icon128.png` |
| Screenshots | 1280×800 (or 640×400), 1–5 images | ✅ Done: `store/images/screenshot-01-popup-video.png` (real popup over a video page), `screenshot-02-popup-live.png` (real popup over a live page), `screenshot-03-racing-diagram.png` (mechanism and traffic cost diagram). Composed by `store/images/src/compose.mjs` from a real run; the page background is blurred wholesale to hide third-party content |
| Small promo tile (required) | 440×280 PNG/JPEG | ✅ Done: `store/images/promo-tile-440x280.png` |
| Marquee promo tile (optional, needed for featuring) | 1400×560 PNG/JPEG | ✅ Done: `store/images/marquee-1400x560.png` |
| YouTube promo video | link | ⬜ none. The images page says only the icon, small promo tile, and a screenshot are mandatory; the listing page lists the video alongside the other assets. If the dashboard blocks submission without it, a later task produces one |

## Packaging and upload

```sh
npm run package
```

Builds → runs the contract test → writes `release/smooth-bilibili-chrome-plugin-<version>.zip`
(manifest.json at the zip root); upload it under Items → New item. If the reviewer requests source,
provide a repository zip separately; the published bundles are unminified and carry source maps.

## References (sources this draft relies on)

- Listing fields; localized listings map to `_locales`: https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- Image specs (96×96 artwork + 16px padding, screenshots, promo tiles, mandatory set): https://developer.chrome.com/docs/webstore/images
- Category list and the mid-2023 category revision: https://developer.chrome.com/docs/webstore/best-practices
- Privacy practices tab (single purpose, permission justifications, remote code, data usage, privacy policy URL): https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Test instructions tab (optional): https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions
- Data category definitions (the store's public disclosure text, shown on any item's privacy page, e.g.): https://chromewebstore.google.com/detail/crxmouse-mouse-gestures/jlgkpaicikihijadgifklkbpdajbkhjo/privacy
- Program Policies overview (privacy fields contradicting behavior lead to removal; misleading title/description; unreviewable functionality can be rejected): https://developer.chrome.com/docs/webstore/program-policies/policies
- Listing requirements (blank description/icon/screenshots are rejected; keyword spam): https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
- Narrowest permissions: https://developer.chrome.com/docs/webstore/program-policies/permissions
- Permissions list (unlimitedStorage lifts the IndexedDB quota): https://developer.chrome.com/docs/extensions/reference/permissions-list
- User Data Policy FAQ (local-only processing must still be disclosed; web browsing activity definition): https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- Limited Use: https://developer.chrome.com/docs/webstore/program-policies/limited-use
- Privacy policies requirement: https://developer.chrome.com/docs/webstore/program-policies/privacy
- Impersonation & intellectual property (third-party brand naming): https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property
- Branding guidelines (the "for …" reference pattern for Google marks, applied here by analogy to Bilibili): https://developer.chrome.com/docs/webstore/branding
- MV3 requirements (no remotely hosted code): https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
- Manifest field lengths (name 75, description 132): https://developer.chrome.com/docs/extensions/reference/manifest
- Developer registration: https://developer.chrome.com/docs/webstore/register
