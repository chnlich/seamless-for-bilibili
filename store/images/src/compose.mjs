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

// On Linux the system fontconfig knows neither Segoe UI nor any Chinese font: the
// first Linux render shipped two store images whose every Chinese character was a
// tofu box (the geometry checks cannot see fonts). fonts.conf next to this script
// adds /mnt/c/Windows/Fonts and prefers Segoe UI and Microsoft YaHei, so Linux Chrome
// draws the same glyphs Windows Chrome did. A FONTCONFIG_FILE already in the
// environment wins over this default, on purpose, so a run can be pointed at another
// config (e.g. to exercise the font self-check). Windows Chrome finds these fonts
// itself and launches as before.
const launchEnv = { ...process.env };
if (process.platform === 'linux' && process.env.FONTCONFIG_FILE === undefined) {
  launchEnv.FONTCONFIG_FILE = path.join(srcDir, 'fonts.conf');
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

// The only fonts allowed to draw text in the store images: Segoe UI for Latin and
// Microsoft YaHei for Chinese, the families Windows Chrome picked for the recorded
// captures (shared.css asks for both by name). Add a family only when a page starts
// using it deliberately, and report the addition. One deliberate addition so far:
// Noto Sans SC draws the diagram's literal check mark (diagram.html "完整到达 →
// 交给播放器 ✓"): neither Segoe UI nor Microsoft YaHei contains U+2713, so the
// character falls back — to Noto Sans SC on Linux (a Windows-side font reached
// through fonts.conf), and to another symbol font on Windows.
const ALLOWED_FONTS = ['Segoe UI', 'Microsoft YaHei', 'Noto Sans SC'];

// Font self-check, next to the geometry checks, before every screenshot: asks Chrome
// over CDP (CSS.getPlatformFontsForNode) which platform fonts actually drew each
// element's own text and fails the render on any family outside ALLOWED_FONTS. Catches
// a page whose text fell back to a system font or to tofu boxes.
async function assertFonts(page, htmlName) {
  const texts = await page.evaluate(() => {
    const texts = [];
    for (const el of document.querySelectorAll('body *')) {
      const ownText = [...el.childNodes]
        .some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '');
      if (ownText) {
        el.setAttribute('data-font-check', String(texts.length));
        texts.push(el.textContent.trim());
      }
    }
    return texts;
  });
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('CSS.enable');
    const { root } = await session.send('DOM.getDocument');
    const { nodeIds } = await session.send('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: '[data-font-check]',
    });
    if (nodeIds.length !== texts.length) {
      throw new Error(`${htmlName}: the font check found ${nodeIds.length} of ${texts.length} text elements`);
    }
    for (const [index, nodeId] of nodeIds.entries()) {
      const { fonts } = await session.send('CSS.getPlatformFontsForNode', { nodeId });
      for (const font of fonts) {
        if (!ALLOWED_FONTS.includes(font.familyName)) {
          throw new Error(`${htmlName}: text ${JSON.stringify(texts[index])} is drawn in font ${JSON.stringify(font.familyName)} (${font.glyphCount} glyphs), only ${ALLOWED_FONTS.map((f) => JSON.stringify(f)).join(' and ')} may draw text`);
        }
      }
    }
  } finally {
    await session.detach();
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-font-check]')) {
        el.removeAttribute('data-font-check');
      }
    });
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

console.log('chrome fontconfig:', launchEnv.FONTCONFIG_FILE ?? '(none; the environment keeps its own)');
const browser = await chromium.launch({ executablePath, headless: true, env: launchEnv });
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
      await assertFonts(page, htmlName);
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
