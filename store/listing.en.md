# Store listing draft (English)

Field-by-field draft for the Chrome Web Store Developer Dashboard. Name candidates and the final
decision live in [README.md](README.md); the user copy-pastes and submits. Every field is pre-filled
except the images marked "TODO".

Note: the item currently has a single default listing language (the manifest declares no `_locales`),
so the live listing will be the zh-CN draft ([listing.zh-CN.md](listing.zh-CN.md)). This English
draft is the ready-to-paste text for a future locale-specific listing once `_locales` ships.

## Store listing tab

- **Item name**: comes from the manifest (unchanged in this task). Recommended rename:
  "Anti-Stutter for Bilibili" — decision in README.md.
- **Summary** (= manifest `description`; the live summary is the 98-character zh text — the en
  summary below is 124 characters, counted, within the 132 limit):
  Races Bilibili's mirrors for video and live streams, holding a 120-second buffer to cut stalling. In memory, on-device only.
- **Detailed description** (paste-ready):

  ```text
  Cuts playback stalling on Bilibili video and live pages. An independent third-party tool, not affiliated with or endorsed by Bilibili; Bilibili and related names are trademarks of their respective owner.

  Idea and assumptions: stalling often comes from one slow or unstable Bilibili CDN host rather than from your own bandwidth, and Bilibili itself supplies primary/backup mirror addresses for the same content — the extension fetches from two addresses at once and keeps the first complete response. It rescues a slow host, not a slow link: if your connection itself is too slow, or the browser's decoder stalls even with a full buffer, this extension cannot help.

  Video pages: takes over the player's media segment downloads — every 1 MiB segment is requested from the two mirror addresses Bilibili supplied at once, first complete response wins; prefetches ahead (window up to 48 segments, concurrency 4); segments stay in memory only (512 MiB cap), are released when the page is left, and are never written to disk; asks the native player to keep a 120-second buffer. Playback is not taken over: play, pause, seeking, rate, quality, volume, and track choices stay with you and Bilibili's player.

  Live pages: takes over the player's FLV stream — pairs only the primary/backup addresses of the same cluster, checks their common prefix matches before racing both concurrently, and delivers whichever bytes arrive first; with no pair or a prefix mismatch it falls back to a single leg on the player's own URL. No prefetch and no buffer target on live.

  The cost — please weigh against your data plan: on video, the bytes the losing leg already downloaded are discarded — about 12.6% steady-state waste in one real run (it varies per session; the extension's CDN racing panel on its log page shows the session's own wasted-byte ratio); the 120-second buffer and prefetch download ahead, so leaving a video early downloads more unwatched data than the native player would. On live, both legs stream at once while a pair is racing — close to twice the traffic. Each tab may use up to about 512 MiB of memory for media; the local diagnostic log is never rotated and grows with use (on-device only, deleted on uninstall).

  Data: media segments stay in memory; the development diagnostic log lives in the extension's local IndexedDB and stores no cookies, account data, titles, page text, chat, signed parameters, or audio/video bytes; no upload, no telemetry; export happens only when you pick a file, and the log is kept until you uninstall. Permissions are only storage (one on/off switch) and unlimitedStorage (an unrotated local log); no broad host permissions. Fully open source: https://github.com/chnlich/smooth-bilibili-chrome-plugin
  ```

- **Category**: Productivity. The extension category list has no media/playback entry; this is the
  closest fit — adjust in the dashboard if the list differs.
- **Language**: the dashboard listing language for the default listing is 中文（简体）(zh-CN); add
  this English text as a locale-specific listing only after the manifest ships `_locales`.
- **Homepage URL**: https://github.com/chnlich/smooth-bilibili-chrome-plugin
- **Support URL**: https://github.com/chnlich/smooth-bilibili-chrome-plugin/issues
- **Official URL**: leave empty (optional; requires verifying the site in Google Search Console).

## Privacy practices tab

- **Single purpose description**:
  Reduce playback stalling on Bilibili video and live pages by taking over the player's media
  downloads (racing Bilibili's own mirror addresses) and, on video, requesting a 120-second buffer
  from the native player.
- **Permissions justification** (per item, exactly the manifest's permissions and matches):

  | Dashboard item | Paste text |
  |---|---|
  | `storage` | Stores exactly one user switch (video enhancement on/off) in chrome.storage.local so the popup preference survives restarts. Nothing else is stored. |
  | `unlimitedStorage` | The development diagnostic log is append-only by design and never rotated or capped (see GOAL.md in the repository); it lives in the extension's own origin IndexedDB and grows with use. unlimitedStorage removes the browser's default storage quota so the log can keep growing without interrupting downloads or diagnostics. It stays on the device; the user can view or export it on the log page, and uninstalling deletes everything. |
  | Content script `https://www.bilibili.com/*` | Injected on video pages to intercept the player's media segment requests and answer them from the in-memory cache or fetch them on the player's behalf; also records local media diagnostics and asks the player for a 120-second buffer. |
  | Content script `https://live.bilibili.com/*` | On live pages, applies the same download takeover and dual-leg racing to FLV media streams (no prefetch, no buffer target). |
  | MAIN world injection (`world: "MAIN"`) | Intercepting media requests requires wrapping fetch/XHR in the page's own JavaScript realm, so three content scripts run in the MAIN world, which exposes no extension chrome.* APIs; the ISOLATED-world controller reads the preference. |

  Also state: the manifest requests no `host_permissions` (answer "none" if the dashboard shows a
  host-access row); media fetches happen in the page context, exactly as the player's own requests.
- **Remote code**: select "No, I am not using remote code". All JavaScript is bundled from repository
  sources by esbuild at build time; nothing remote is loaded or executed at runtime (the sources
  contain no eval, remote script, or remote importScripts).
- **Data usage — which data is collected**:

  | Checkbox | Answer | Reason |
  |---|---|---|
  | Web history | ✅ check | The log records media URLs requested by the player and page paths (site + path only, query/hash stripped). A local record of "URLs the browser interacts with", for defect diagnosis; never leaves the device. |
  | Website content | ✅ check | Media segments (audio/video bytes) transit through memory to feed the player; never written to disk, never logged, never sent anywhere. |
  | Personally identifiable info / Auth info / Communications / Location / Financial / Health / User activity | ⬜ skip | The log explicitly stores no cookies, account data, titles, page text, chat, API bodies, audio/video bytes, frames, or screenshots; no location is read; no form data is touched. |

- **Data usage — compliance certifications**: check all four. Reason: the extension has no external
  endpoint at all, so selling/transferring data, unrelated uses, creditworthiness checks, and
  targeted advertising cannot physically occur; the only network requests it makes are the same
  media requests the player would make, to Bilibili's own media addresses.
- **Privacy policy URL**: https://github.com/chnlich/smooth-bilibili-chrome-plugin/blob/main/PRIVACY.md
  (PRIVACY.md must be merged to main before submitting — the URL is user-facing.)
- **Limited Use statement**: not applicable. That requirement covers data received from Google APIs;
  this extension uses no Google APIs, so PRIVACY.md deliberately makes no such statement (it would
  imply Google API data exists).

## Distribution tab

- Visibility: public. Regions: all (default). Pricing: free. Content rating: default (no mature content).

## Image checklist

| Asset | Spec | Status |
|---|---|---|
| Store icon | 128×128 PNG (96×96 artwork + 16px transparent padding) | ✅ Done: `assets/icon.svg` → `npm run icons` renders the four sizes, committed with the package |
| Screenshots | 1280×800 (or 640×400), 1–5 images | ⬜ TODO: after the popup redesign lands (later task) |
| Small promo tile (required) | 440×280 PNG/JPEG | ⬜ TODO: later task |
| Marquee promo tile (optional, needed for featuring) | 1400×560 PNG/JPEG | ⬜ TODO: later task |
| YouTube promo video (optional) | — | ⬜ none |

## Packaging and upload

```sh
npm run package
```

Builds → runs the contract test → writes `release/smooth-bilibili-chrome-plugin-<version>.zip`
(manifest.json at the zip root); upload it under Items → New item. If the reviewer requests source
(code readability requirements), provide a repository zip separately; the published bundles are
unminified and carry source maps.

## References (sources this draft relies on)

- Listing fields and images: https://developer.chrome.com/docs/webstore/cws-dashboard-listing , https://developer.chrome.com/docs/webstore/images
- Privacy practices tab (single purpose, permission justifications, remote code, data usage, privacy policy URL): https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- Listing requirements (blank description/icon/screenshots are rejected; keyword spam): https://developer.chrome.com/docs/webstore/program-policies/listing-requirements
- Narrowest permissions: https://developer.chrome.com/docs/webstore/program-policies/permissions
- User Data Policy (local-only processing must still be disclosed): https://developer.chrome.com/docs/webstore/user_data
- Limited Use: https://developer.chrome.com/docs/webstore/program-policies/limited-use
- Privacy policies requirement: https://developer.chrome.com/docs/webstore/program-policies/privacy
- Impersonation & intellectual property (third-party brand naming): https://developer.chrome.com/docs/webstore/program-policies/impersonation-and-intellectual-property
- Branding guidelines (the "for …" reference pattern for marks): https://developer.chrome.com/docs/webstore/branding
- Manifest field lengths (name 75, description 132): https://developer.chrome.com/docs/extensions/reference/manifest
- Developer registration: https://developer.chrome.com/docs/webstore/register
- Locale-specific listings require `_locales`: https://developer.chrome.com/docs/webstore/cws-dashboard-listing#localize-your-listing
