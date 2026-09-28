import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(root, 'assets', 'icon.svg');
const outputDirectory = path.join(root, 'src', 'extension', 'icons');
// 128 是商店图标：96×96 图形加 16px 透明边；16/32/48 是工具栏与扩展页图标，只取图形区铺满画布，16px 下才看得清。
const STORE_VIEWBOX = 'viewBox="0 0 128 128"';
const ARTWORK_VIEWBOX = 'viewBox="16 16 96 96"';
const sizes = [16, 32, 48, 128];

const svg = await fs.readFile(svgPath, 'utf8');
if (!svg.includes(STORE_VIEWBOX)) throw new Error(`assets/icon.svg 缺少 ${STORE_VIEWBOX}`);
await fs.mkdir(outputDirectory, { recursive: true });

for (const size of sizes) {
  const source = size === 128 ? svg : svg.replace(STORE_VIEWBOX, ARTWORK_VIEWBOX);
  const png = new Resvg(source, { fitTo: { mode: 'width', value: size } }).render().asPng();
  if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
    throw new Error(`icon${size}.png rendered with wrong dimensions ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  }
  await fs.writeFile(path.join(outputDirectory, `icon${size}.png`), png);
  console.log(`wrote src/extension/icons/icon${size}.png (${png.length} bytes)`);
}
