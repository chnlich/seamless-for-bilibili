# Store listing draft (English)

Field-by-field draft for the Chrome Web Store Developer Dashboard. The name is decided:
Seamless for Bilibili (decision and rationale in [README.md](README.md)); the user copy-pastes and
submits. Every field and every image is pre-filled and current (see [images/README.md](images/README.md)).

Note: the item currently has a single default listing language (the manifest declares no `_locales`),
so the live listing will be the zh-CN draft ([listing.zh-CN.md](listing.zh-CN.md)). This English
draft is the ready-to-paste text for a future locale-specific listing once `_locales` ships.

## Store listing tab

- **Item name**: Seamless for Bilibili (comes from the manifest `name`; the dashboard name stays
  identical to it, decision in README.md).
- **Summary**: not a dashboard field; the dashboard takes the manifest `description`. The live summary
  is the 63-character zh text. For a future `_locales/en` `description` (131 characters, counted as
  Unicode characters, within the 132 limit):
  Watching Bilibili from overseas, video and live always stutter? Seamless for Bilibili is here to solve that, for smoother playback.
- **Detailed description** (paste-ready):

  ```text
  Your speed test looks fine, yet the picture often stalls with a spinner halfway through. The cause is usually not your own connection but one of Bilibili's servers slowing down for a while. This extension fixes that in two ways:

  • 120-second video prebuffer: the player loads the next 120 seconds ahead of time. When a server slows down for a moment, the player still has the content it stored ahead and keeps playing.
  • Two servers downloaded at once: Bilibili prepares more than one server for the same content. The extension downloads from two of them at the same time and uses whichever arrives first; when one slows down, the other takes over. Video and live both work this way, and a live room that supports it also gets one more backup line attached.

  When your connection is fast enough, 1080p video plays smoothly even at 2× speed. Works as soon as it is installed, no setup needed.

  What to know
  • It uses more data: a bit over 10% more on video; live runs at 1 to 2.3 times what you would use without the extension. To skip the extra live data, turn off "Live enhancement" on its own in the popup.
  • It cannot help when your own connection is not fast enough.
  • Data stays on your computer; nothing is uploaded. Source code is public: https://github.com/chnlich/seamless-for-bilibili

  This extension is an independent third-party tool, not affiliated with or in partnership with Bilibili.
  ```

- **Category**: Entertainment. The old "Productivity" group was split up in an earlier category
  revision; Entertainment is the category for viewers of TV and cinema content, the closest fit for
  an extension that serves only Bilibili video and live viewing. Fallback: Tools.
- **Language**: the dashboard listing language for the default listing is 中文（简体）(zh-CN); add
  this English text as a locale-specific listing only after the manifest ships `_locales`.
- **Homepage URL**: https://github.com/chnlich/seamless-for-bilibili
- **Support URL**: https://github.com/chnlich/seamless-for-bilibili/issues
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
  | `storage` | Stores exactly two user switches (video enhancement and live enhancement, each on/off) in chrome.storage.local so the popup preferences survive restarts. Nothing else is stored. |
  | `unlimitedStorage` | The development diagnostic log lives in the extension's own origin IndexedDB and keeps only the last 3 days (72 hours); older records are deleted automatically, and within the window the log is append-only and not capped by count or size (see GOAL.md in the repository). Measured on the developer's own browser, an open video page adds about 7 MB per hour, so even a 3-day window can exceed the browser's default storage quota; unlimitedStorage removes that quota so writes inside the window do not start failing at it. The log stays on the device; the user can view or export it on the log page, and uninstalling deletes everything. |
  | Content script `https://www.bilibili.com/*` | Download takeover starts only on video routes (/video/* and /list/watchlater*): it intercepts the player's media segment requests, answers them from the in-memory cache or fetches them from the mirror addresses Bilibili supplied, and asks the player for a 120-second buffer. The match covers the whole site because the extension follows in-page route changes and must be in place at document_start; on other routes it intercepts nothing and only records the page path in the local diagnostic log. |
  | Content script `https://live.bilibili.com/*` | On live pages, takes over the player's live media downloads: the FLV live stream and HLS live segments (.m4s and .ts; .m3u8 playlists pass through), and, after the pair check, races the same-cluster primary/backup addresses Bilibili supplied (no prefetch, no buffer target). On fMP4 live rooms (.m4s segments) a third FLV backup leg joins: the extension reads the same room's same-stream, same-codec FLV address from Bilibili's own playback info, opens its own FLV connection, and rebuilds each segment byte for byte from the FLV frames; a rebuilt segment joins the race only when its byte count and CRC32 both equal the values the playlist published, mismatches are discarded and never handed to the player. |
  | MAIN world injection (`world: "MAIN"`) | Three scripts must run in the page's own JavaScript realm: bank.js wraps the page's fetch/XMLHttpRequest to catch the player's media requests; source-buffer-shim.js observes the page's MediaSource/SourceBuffer appends and removals for local diagnostics; main-bridge.js calls the Bilibili player object's own buffer setting (setStableBufferTime). The MAIN world exposes no chrome.* APIs; the ISOLATED-world controller.js reads the preference and writes the log. |

  If the dashboard shows a single combined "Host permission" field, paste:
  The extension requests no host_permissions; it has two content-script matches: www.bilibili.com
  (download takeover and a 120-second buffer request on video routes only; other routes only record
  the page path in the local diagnostic log) and live.bilibili.com (live-media takeover: FLV live streams and
  HLS live segments, .m3u8 playlists passing through, racing Bilibili's own primary/backup addresses; on fMP4
  live rooms a further FLV backup leg reads the same room's FLV address from Bilibili's playback info and
  rebuilds each segment from the FLV frames, and only a rebuild whose byte count and CRC32 equal the values the
  playlist published ever joins the race). Media fetches run in the page context and go only to the
  address the player requested and the mirror addresses Bilibili's playback info lists for the same
  file; the fMP4 backup's FLV address comes from that same playback info.
- **Remote code**: select "No, I am not using remote code". All JavaScript is bundled from repository
  sources by esbuild at build time; nothing remote is loaded or executed at runtime (the sources
  contain no eval, new Function, remote script, or importScripts).
- **Data usage: which data is collected**: the User Data Policy FAQ states that data processed or
  stored only on the device must still be disclosed, so the boxes follow what the extension handles
  locally. Category definitions are quoted from the store's public disclosure pages.

  | Checkbox (store definition) | Answer | Reason |
  |---|---|---|
  | Web history ("The list of web pages a user has visited, as well as associated data such as page title and time of visit") | ✅ check | Every www.bilibili.com / live.bilibili.com page opened gets a log record with its path (query/hash stripped), video identifiers, and timestamps; no titles. On-device only, for defect diagnosis. |
  | User activity ("For example: network monitoring, clicks, mouse position, scroll, or keystroke logging") | ✅ check | The log records the player's media requests (URL without parameters, mirror host, timing, bytes, result), which is network monitoring, and player events such as play, pause, seeking, rate and volume changes. No click positions, mouse, scroll, or keystrokes. On-device only. |
  | Website content ("For example: text, images, sounds, videos, or hyperlinks") | ✅ check | Media segments (audio/video bytes) pass through memory to feed the player; never written to disk, never logged, never sent anywhere. |
  | Personally identifiable information / Health / Financial and payment / Authentication / Personal communications / Location | ⬜ skip | The log explicitly stores no cookies, account data, titles, page text, chat, API bodies, audio/video bytes, frames, or screenshots; no location or IP is read; no form or password data is touched. |

- **Data usage: compliance certifications**: check all three (the public listing shows them as: not
  sold to third parties outside the approved use cases; not used or transferred for purposes unrelated
  to the item's core functionality; not used or transferred to determine creditworthiness or for
  lending). Reason: the extension has no external endpoint, so data never leaves the device; the only
  network requests it makes are the player's own media requests, to Bilibili's media addresses. If the
  dashboard shows a different number of statements, check each on the same reasoning.
- **Privacy policy URL**: https://github.com/chnlich/seamless-for-bilibili/blob/main/PRIVACY.md
  (the repository is public; the current PRIVACY.md must be on main before submitting, and the URL is
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
| Screenshots | 1280×800 (or 640×400), 1–5 images | ✅ done: `store/images/screenshot-01-popup-video.png` (real popup over a video page, two switches, current name) and `screenshot-02-popup-live.png` (real popup over a live page); `screenshot-03-racing-diagram.png` (mechanism and traffic cost diagram, no name). Composed by `store/images/src/compose.mjs` from a real run; the page background is blurred wholesale to hide third-party content |
| Small promo tile (required) | 440×280 PNG/JPEG | ✅ done: `store/images/promo-tile-440x280.png`, showing the current name Seamless for Bilibili |
| Marquee promo tile (optional, needed for featuring) | 1400×560 PNG/JPEG | ✅ done: `store/images/marquee-1400x560.png`, showing the current name Seamless for Bilibili |
| YouTube promo video | link | ⬜ none. The images page says only the icon, small promo tile, and a screenshot are mandatory; the listing page lists the video alongside the other assets. If the dashboard blocks submission without it, a later task produces one |

## Packaging and upload

```sh
npm run package
```

Builds → runs the contract test → writes `release/seamless-for-bilibili-<version>.zip`
(manifest.json at the zip root); upload it under Items → New item. If the reviewer requests source,
provide a repository zip separately; the published bundles are unminified and carry source maps.

## References (sources this draft relies on)

- Listing fields; localized listings map to `_locales`: https://developer.chrome.com/docs/webstore/cws-dashboard-listing
- Image specs (96×96 artwork + 16px padding, screenshots, promo tiles, mandatory set): https://developer.chrome.com/docs/webstore/images
- Category list and the category revision: https://developer.chrome.com/docs/webstore/best-practices
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
