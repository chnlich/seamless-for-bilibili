import { EXTENSION_MANIFEST, VERSION } from '../constants.js';

// Manifest description = store summary draft in store/listing.zh-CN.md (CWS limit 132 characters).
const DESCRIPTION = '接管 Bilibili 视频与直播页的媒体下载：视频分片同时向两个镜像地址取回、先完成先用，并请求播放器保持 120 秒缓冲；直播主备两路流并发供给、先到先用。全部在本机内存完成，不改动播放控制。';

const ICONS = Object.freeze({
  16: 'icon16.png',
  32: 'icon32.png',
  48: 'icon48.png',
  128: 'icon128.png',
});

export function createManifest() {
  return {
    manifest_version: EXTENSION_MANIFEST.manifestVersion,
    name: 'Bilibili 桌面网页抗卡',
    version: VERSION,
    description: DESCRIPTION,
    minimum_chrome_version: EXTENSION_MANIFEST.minimumChromeVersion,
    permissions: ['storage', 'unlimitedStorage'],
    host_permissions: [...EXTENSION_MANIFEST.hostPermissions],
    icons: { ...ICONS },
    action: {
      default_title: 'Bilibili 抗卡设置',
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
