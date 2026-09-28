// Renders the committed store images from the raw capture files in store-images-raw/
// (raw page captures stay out of the repo for privacy; the popup close-ups are the
// extension's own UI and are committed). Run with Node on any OS that has Chrome:
//   BILIBILI_E2E_CHROME=<chrome path> node compose.mjs [--raw <store-images-raw dir>]
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

// Raw popup captures are 2x device pixels; the popup body is 340 CSS px wide and the
// content (cards + footer) ends at 338 CSS px tall. Crop keeps exactly the popup visual.
const POPUP_CSS_WIDTH = 344;
const POPUP_CSS_HEIGHT = 338;

async function cropPopup(browser, rawName, outName) {
  const page = await browser.newPage({ viewport: { width: POPUP_CSS_WIDTH, height: POPUP_CSS_HEIGHT }, deviceScaleFactor: 2 });
  try {
    await page.setContent(`<body style="margin:0"><img src="${rawName}" style="display:block;width:372px"></body>`);
    await page.evaluate(async (name) => {
      const image = document.querySelector('img');
      if (!image.complete) await new Promise((resolve) => { image.onload = resolve; });
      image.src = name;
    }, rawName);
    const target = path.join(imagesDir, outName);
    await page.screenshot({ path: target, type: 'png' });
    return target;
  } finally {
    await page.close();
  }
}

const SIZES = {
  'screenshot-video.html': [1280, 800, 'screenshot-01-popup-video.png'],
  'screenshot-live.html': [1280, 800, 'screenshot-02-popup-live.png'],
  'diagram.html': [1280, 800, 'screenshot-03-racing-diagram.png'],
  'tile.html': [440, 280, 'promo-tile-440x280.png'],
  'marquee.html': [1400, 560, 'marquee-1400x560.png'],
};

// Honest live caption: replace the LIVE_NOTE comment based on what was actually captured.
async function adjustLiveCaption(report) {
  const liveHtml = path.join(srcDir, 'screenshot-live.html');
  let html = await fs.readFile(liveHtml, 'utf8');
  const state = report?.scenarios?.live?.readout?.liveTakeover;
  const note = state === '正在按两条线路竞速下载'
    ? '配对后两条线路同时下载，'
    : state === '单路接管（无可用备用线路）'
      ? '此直播间无可用备用线路，单路接管，'
      : '此直播间未发现 FLV 流，弹窗如实显示未接管，';
  html = html.replace('<!--LIVE_NOTE-->', note);
  await fs.writeFile(liveHtml, html);
  return note;
}

const browser = await chromium.launch({ executablePath, headless: true });
try {
  const report = await fs.readFile(path.join(rawDir, 'report.json'), 'utf8').then(JSON.parse).catch(() => undefined);
  const note = await adjustLiveCaption(report);
  console.log('live caption note:', note);
  await cropPopup(browser, 'video-popup-light.png', 'popup-video.png');
  await cropPopup(browser, 'live-popup-light.png', 'popup-live.png');
  for (const [htmlName, [width, height, outName]] of Object.entries(SIZES)) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    try {
      await page.goto(`file://${path.join(srcDir, htmlName)}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(250);
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
