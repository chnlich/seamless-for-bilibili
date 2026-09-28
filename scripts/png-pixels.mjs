// Pixel-level self-check for written capture PNGs: a capture can clip a region that
// Chrome never painted (the 63950b9 video popup shipped 70 CSS px of unpainted strip
// where the footer log link belongs), and no DOM readout can see that - only the written
// image can. decodePng handles what Chrome's Page.captureScreenshot emits: 8-bit
// non-interlaced truecolor, with or without alpha. assertInkPainted fails loudly unless
// the given document rect carries real ink (pixels away from the surrounding background
// and more than one flat color), so an unpainted strip can never pass as a store image.
import fs from 'node:fs/promises';
import zlib from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

// Returns { width, height, channels, data } with data as rows of packed channel bytes,
// filters undone.
export function decodePng(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (bitDepth !== 8 || channels === undefined || interlace !== 0) {
    throw new Error(`unsupported PNG: depth=${bitDepth} color=${colorType} interlace=${interlace}`);
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  const previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const current = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = line[x];
      if (filter === 1) {
        value += left;
      } else if (filter === 2) {
        value += up;
      } else if (filter === 3) {
        value += (left + up) >> 1;
      } else if (filter === 4) {
        const predictor = left + up - upLeft;
        const distanceLeft = Math.abs(predictor - left);
        const distanceUp = Math.abs(predictor - up);
        const distanceUpLeft = Math.abs(predictor - upLeft);
        value += distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft
          ? left
          : (distanceUp <= distanceUpLeft ? up : upLeft);
      } else if (filter !== 0) {
        throw new Error(`corrupt PNG: unknown filter ${filter} on row ${y}`);
      }
      current[x] = value & 0xff;
    }
    previous.set(current);
  }
  return { width, height, channels, data: out };
}

export async function decodePngFile(file) {
  return decodePng(await fs.readFile(file));
}

function pixelAt(png, x, y) {
  const offset = (y * png.width + x) * png.channels;
  return [png.data[offset], png.data[offset + 1], png.data[offset + 2]];
}

function differs(pixel, background) {
  for (let channel = 0; channel < background.length; channel += 1) {
    if (Math.abs(pixel[channel] - background[channel]) > 2) return true;
  }
  return false;
}

// The surrounding background is read from the image itself: the modal color of the rect
// expanded by `margin` CSS px on every side, so the check stays theme- and palette-free.
// Failures carry the counts, so a red run explains itself.
export function assertInkPainted({ png, rect, scale, margin = 6, minInkPixels = 20, minColors = 3 }) {
  const box = {
    left: Math.max(0, Math.floor((rect.x - margin) * scale)),
    top: Math.max(0, Math.floor((rect.y - margin) * scale)),
    right: Math.min(png.width, Math.ceil((rect.x + rect.width + margin) * scale)),
    bottom: Math.min(png.height, Math.ceil((rect.y + rect.height + margin) * scale)),
  };
  const ink = {
    left: Math.floor(rect.x * scale),
    top: Math.floor(rect.y * scale),
    right: Math.ceil((rect.x + rect.width) * scale),
    bottom: Math.ceil((rect.y + rect.height) * scale),
  };
  if (ink.left < box.left || ink.top < box.top || ink.right > box.right || ink.bottom > box.bottom) {
    throw new Error(`rect ${JSON.stringify(rect)} at scale ${scale} does not fit the ${png.width}x${png.height} image; the capture is smaller than the document`);
  }
  const colorCounts = new Map();
  for (let y = box.top; y < box.bottom; y += 1) {
    for (let x = box.left; x < box.right; x += 1) {
      const pixel = pixelAt(png, x, y);
      const key = `${pixel[0]},${pixel[1]},${pixel[2]}`;
      colorCounts.set(key, (colorCounts.get(key) ?? 0) + 1);
    }
  }
  const background = [...colorCounts.entries()].sort((left, right) => right[1] - left[1])[0][0]
    .split(',').map(Number);
  let inkPixels = 0;
  const inkColors = new Set();
  for (let y = ink.top; y < ink.bottom; y += 1) {
    for (let x = ink.left; x < ink.right; x += 1) {
      const pixel = pixelAt(png, x, y);
      if (differs(pixel, background)) {
        inkPixels += 1;
        inkColors.add(`${pixel[0]},${pixel[1]},${pixel[2]}`);
      }
    }
  }
  if (inkPixels < minInkPixels || inkColors.size < minColors) {
    throw new Error(
      `${JSON.stringify(rect)} carries no ink in ${png.width}x${png.height} image`
      + ` (ink pixels ${inkPixels} < ${minInkPixels}, ink colors ${inkColors.size} < ${minColors},`
      + ` background rgb(${background.join(',')}), box ${JSON.stringify(box)});`
      + ' the capture left this region unpainted',
    );
  }
  return { inkPixels, inkColors: inkColors.size, background };
}
