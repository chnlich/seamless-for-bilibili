// Renders the committed store images from the raw capture files in store-images-raw/
// (raw page captures stay out of the repo for privacy; the popup close-ups are the
// extension's own UI and are committed). Run with Node on any OS that has Chrome:
//   BILIBILI_E2E_CHROME=<chrome path> node compose.mjs
// Inputs: store-images-raw/{video,live}-popup-light.png, {video,live}-page.png, report.json
// Outputs: ../screenshot-0*.png, ../promo-tile-440x280.png, ../marquee-1400x560.png,
//          ../popup-video.png, ../popup-live.png
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
const imagesDir = path.resolve(srcDir, '..');
const repoDir = path.resolve(imagesDir, '..', '..');
const rawDir = path.resolve(repoDir, 'store-images-raw');

const executablePath = process.env.BILIBILI_E2E_CHROME;
if (executablePath === undefined) {
  throw new Error('set BILIBILI_E2E_CHROME to the Chrome executable; no silent fallback');
}

// The raw popup captures are 2x device pixels of the whole popup page (the capture
// clips exactly the popup document's scrollWidth x scrollHeight), so the close-up is
// the capture itself: every edge, the toggle and the log link are complete by
// construction. No hard-coded crop box.
async function pngSize(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!header.subarray(0, 8).equals(signature)) {
      throw new Error(`${file} is not a PNG`);
    }
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } finally {
    await handle.close();
  }
}

async function exportPopupCloseup(rawName, outName) {
  const target = path.join(imagesDir, outName);
  await fs.copyFile(path.join(rawDir, rawName), target);
  const { width, height } = await pngSize(target);
  console.log('exported', target, `${width}x${height}`);
}

const SIZES = {
  'screenshot-video.html': [1280, 800, 'screenshot-01-popup-video.png'],
  'screenshot-live.html': [1280, 800, 'screenshot-02-popup-live.png'],
  'diagram.html': [1280, 800, 'screenshot-03-racing-diagram.png'],
  'tile.html': [440, 280, 'promo-tile-440x280.png'],
  'marquee.html': [1400, 560, 'marquee-1400x560.png'],
};

// Layout self-check, run in each page before the screenshot: the store upload uses
// these pixels as-is, so the render fails loudly when a subject (popup, caption, tile
// text block) is clipped by the canvas, when the caption overlaps the popup, or when
// a heading line wraps mid-word, or when the blurred page backdrop failed to load (a
// missing backdrop renders as a plain dark canvas, not as an error). Decorative bleed
// (scaled background, glows) is intentional and checked only through the subjects above.
async function assertLayout(page, htmlName) {
  const check = await page.evaluate(async () => {
    const rectOf = (selector) => {
      const element = document.querySelector(selector);
      return element === null ? null : element.getBoundingClientRect().toJSON();
    };
    const heading = document.querySelector('h1');
    const namedLines = heading === null ? [] : [...heading.childNodes]
      .filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '')
      .map((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return [...range.getClientRects()].filter((rect) => rect.width > 1);
      });
    const backdrop = document.querySelector('.page-bg');
    let backdropError = null;
    if (backdrop !== null) {
      const backgroundImage = getComputedStyle(backdrop).backgroundImage;
      const url = /^url\("(.+)"\)$/.exec(backgroundImage)?.[1];
      if (url === undefined) {
        backdropError = `no backdrop url (${backgroundImage})`;
      } else {
        const image = new Image();
        image.src = url;
        await image.decode().catch((error) => { backdropError = `${url}: ${error}`; });
      }
    }
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      popup: rectOf('.popup img'),
      caption: rectOf('.caption'),
      textBlock: rectOf('.text'),
      namedLines,
      headingRight: heading === null ? Infinity : heading.getBoundingClientRect().right,
      backdropError,
    };
  });
  if (check.backdropError !== null) {
    throw new Error(`${htmlName}: the page backdrop did not load (${check.backdropError})`);
  }
  const inside = (name, rect) => {
    if (rect.left < 0 || rect.top < 0 || rect.right > check.innerWidth || rect.bottom > check.innerHeight) {
      throw new Error(`${htmlName}: ${name} is clipped by the canvas (${JSON.stringify(rect)})`);
    }
  };
  if (check.popup !== null) {
    inside('the popup', check.popup);
    if (check.caption !== null && check.caption.right > check.popup.left - 16) {
      throw new Error(`${htmlName}: the caption overlaps the popup (caption right ${check.caption.right}, popup left ${check.popup.left})`);
    }
  }
  if (check.caption !== null) inside('the caption', check.caption);
  if (check.textBlock !== null) inside('the text block', check.textBlock);
  for (const rects of check.namedLines) {
    if (rects.length !== 1) {
      throw new Error(`${htmlName}: a heading line wraps (${rects.length} line boxes); break only at a word boundary or fit it on one line`);
    }
    if (rects[0].right > check.headingRight + 0.5) {
      throw new Error(`${htmlName}: a heading line overflows its box`);
    }
  }
}

// Honest live caption: the LIVE_NOTE comment in screenshot-live.html is replaced in the
// rendered page (never in the source file) based on what was actually captured. The keys
// are the popup's live status texts (popup-view.js liveTakeoverText); an unknown status
// stops the render instead of silently captioning the wrong state.
function liveCaptionNote(report) {
  const state = report.scenarios.live.readout.liveTakeover;
  switch (state) {
    case '正在按两条线路竞速下载':
      return '配对后两条线路同时下载，';
    case '单路接管（无可用备用线路）':
      return '此直播间无可用备用线路，单路接管，';
    case '接管请求失败':
      return '此直播间接管请求失败，';
    case '未接管（未发现直播媒体流）':
      return '此直播间未发现直播媒体流，弹窗如实显示未接管，';
    case '等待直播数据':
      return '此直播间还没有直播数据，';
    default:
      throw new Error(`report.json 的直播状态不是弹窗已知的任一状态: ${JSON.stringify(state)}`);
  }
}

async function fillLiveNote(page, note) {
  await page.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_COMMENT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node.data === 'LIVE_NOTE') {
        node.replaceWith(text);
        return;
      }
    }
    throw new Error('screenshot-live.html has no <!--LIVE_NOTE--> marker');
  }, note);
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const report = JSON.parse(await fs.readFile(path.join(rawDir, 'report.json'), 'utf8'));
  const note = liveCaptionNote(report);
  console.log('live caption note:', note);
  await exportPopupCloseup('video-popup-light.png', 'popup-video.png');
  await exportPopupCloseup('live-popup-light.png', 'popup-live.png');
  for (const [htmlName, [width, height, outName]] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      await page.goto(`file://${path.join(srcDir, htmlName)}`, { waitUntil: 'networkidle' });
      if (htmlName === 'screenshot-live.html') await fillLiveNote(page, note);
      await page.waitForTimeout(250);
      await assertLayout(page, htmlName);
      const target = path.join(imagesDir, outName);
      await page.screenshot({ path: target, clip: { x: 0, y: 0, width, height }, type: 'png' });
      console.log('rendered', target);
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
