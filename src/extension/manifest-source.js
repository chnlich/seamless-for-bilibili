import { EXTENSION_MANIFEST, VERSION } from '../constants.js';

// Manifest description = store summary draft in store/listing.zh-CN.md (CWS limit 132 characters).
const DESCRIPTION = '海外党看 Bilibili 视频和直播总是卡？Seamless for Bilibili 就是来解决这个问题的，让播放更顺畅。';

const ICONS = Object.freeze({
  16: 'icon16.png',
  32: 'icon32.png',
  48: 'icon48.png',
  128: 'icon128.png',
});

export function createManifest() {
  return {
    manifest_version: EXTENSION_MANIFEST.manifestVersion,
    name: 'Seamless for Bilibili',
    version: VERSION,
    description: DESCRIPTION,
    minimum_chrome_version: EXTENSION_MANIFEST.minimumChromeVersion,
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: [...EXTENSION_MANIFEST.hostPermissions],
    icons: { ...ICONS },
    action: {
      default_title: 'Seamless for Bilibili',
      default_popup: 'popup.html',
      default_icon: { ...ICONS },
    },
    background: {
      service_worker: 'worker.js',
    },
    content_scripts: [
      {
        matches: [...EXTENSION_MANIFEST.matches],
        js: ['source-buffer-shim.js'],
        run_at: 'document_start',
        all_frames: true,
        world: 'MAIN',
      },
      {
        matches: [...EXTENSION_MANIFEST.matches],
        js: ['bank.js'],
        run_at: 'document_start',
        all_frames: false,
        world: 'MAIN',
      },
      {
        matches: [...EXTENSION_MANIFEST.matches],
        js: ['main-bridge.js'],
        run_at: 'document_start',
        all_frames: false,
        world: 'MAIN',
      },
      {
        matches: [...EXTENSION_MANIFEST.matches],
        js: ['controller.js'],
        run_at: 'document_start',
        all_frames: false,
        world: 'ISOLATED',
      },
    ],
  };
}
