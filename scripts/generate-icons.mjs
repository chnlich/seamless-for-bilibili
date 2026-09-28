import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const svgPath = path.join(root, 'assets', 'icon.svg');
const outputDirectory = path.join(root, 'src', 'extension', 'icons');
const sizes = [16, 32, 48, 128];

const svg = await fs.readFile(svgPath, 'utf8');
await fs.mkdir(outputDirectory, { recursive: true });

for (const size of sizes) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  if (png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
    throw new Error(`icon${size}.png rendered with wrong dimensions ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
  }
  await fs.writeFile(path.join(outputDirectory, `icon${size}.png`), png);
  console.log(`wrote src/extension/icons/icon${size}.png (${png.length} bytes)`);
}
