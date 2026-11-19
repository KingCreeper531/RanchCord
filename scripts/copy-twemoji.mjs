// Copies Discord's Twemoji SVGs (from @discordapp/twemoji) into the web app so every emoji
// looks the same as on Discord, on every device, even offline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'client', 'node_modules', '@discordapp', 'twemoji', 'dist', 'svg');
const dest = path.join(root, 'client', 'public', 'twemoji');

if (!fs.existsSync(src)) {
  console.error('Twemoji not installed. Run "npm install" in the client folder first.');
  process.exit(1);
}

const files = fs.readdirSync(src).filter((f) => f.endsWith('.svg'));
const marker = path.join(dest, '.count');
if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === String(files.length)) process.exit(0);

fs.rmSync(dest, { recursive: true, force: true });
fs.mkdirSync(dest, { recursive: true });
for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dest, f));
fs.writeFileSync(marker, String(files.length));
console.log(`Copied ${files.length} Twemoji images`);
