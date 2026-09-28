import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionDirectory = path.join(root, 'dist', 'extension');
const outputDirectory = path.join(root, 'release');
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));

const manifest = JSON.parse(await fs.readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
if (manifest.version !== packageMetadata.version) {
  throw new Error(`manifest version ${manifest.version} does not match package.json version ${packageMetadata.version}`);
}
for (const iconPath of [...new Set([...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})])]) {
  await fs.access(path.join(extensionDirectory, iconPath));
}

const zip = new AdmZip();
zip.addLocalFolder(extensionDirectory, false);
const entryNames = new Set(zip.getEntries().map((entry) => entry.entryName));
if (!entryNames.has('manifest.json')) {
  throw new Error('zip 缺少根级 manifest.json');
}
for (const iconPath of new Set([...Object.values(manifest.icons ?? {}), ...Object.values(manifest.action?.default_icon ?? {})])) {
  if (!entryNames.has(iconPath)) throw new Error(`zip 缺少 ${iconPath}`);
}

await fs.mkdir(outputDirectory, { recursive: true });
const zipPath = path.join(outputDirectory, `seamless-for-bilibili-${manifest.version}.zip`);
await zip.writeZipPromise(zipPath);
const { size } = await fs.stat(zipPath);
console.log(`wrote ${path.relative(root, zipPath)} (${size} bytes)`);
