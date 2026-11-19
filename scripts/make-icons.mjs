// Turns assets/logo-source.webp (the ranch bottle on a white background) into every icon the apps need.
// Usage: node scripts/make-icons.mjs [--preview]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(root, 'assets', 'logo-source.webp');
const BG = process.env.ICON_BG || '#39b5e0';
const BG_2 = process.env.ICON_BG_2 || '#2c6fcb';

const out = (...p) => {
  const file = path.join(root, ...p);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return file;
};

/** Removes the white background by flood-filling from the edges, with soft anti-aliased edges. */
async function cutout() {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const px = (x, y) => (y * W + x) * 4;
  const isBg = (i) => {
    const a = data[i + 3];
    if (a < 16) return true;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const min = Math.min(r, g, b);
    const max = Math.max(r, g, b);
    return min > 222 && max - min < 34;
  };
  const seen = new Uint8Array(W * H);
  const queue = new Int32Array(W * H);
  let head = 0;
  let tail = 0;
  const push = (x, y) => {
    const k = y * W + x;
    if (seen[k] || !isBg(k * 4)) return;
    seen[k] = 1;
    queue[tail++] = k;
  };
  for (let x = 0; x < W; x++) {
    push(x, 0);
    push(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    push(0, y);
    push(W - 1, y);
  }
  while (head < tail) {
    const k = queue[head++];
    const x = k % W;
    const y = (k / W) | 0;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }
  const outBuf = Buffer.from(data);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      const i = k * 4;
      if (seen[k]) {
        outBuf[i + 3] = 0;
        continue;
      }
      // Pixels touching the background: turn leftover white into transparency ("color to alpha").
      let edge = false;
      for (let dy = -2; dy <= 2 && !edge; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && seen[ny * W + nx]) {
            edge = true;
            break;
          }
        }
      }
      if (!edge) continue;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      const a = Math.max((255 - r) / 255, (255 - g) / 255, (255 - b) / 255);
      if (a >= 0.999) continue;
      const alpha = Math.max(0, Math.min(1, a * 1.15));
      if (alpha < 0.02) {
        outBuf[i + 3] = 0;
        continue;
      }
      outBuf[i] = Math.round(Math.max(0, Math.min(255, (r - (1 - alpha) * 255) / alpha)));
      outBuf[i + 1] = Math.round(Math.max(0, Math.min(255, (g - (1 - alpha) * 255) / alpha)));
      outBuf[i + 2] = Math.round(Math.max(0, Math.min(255, (b - (1 - alpha) * 255) / alpha)));
      outBuf[i + 3] = Math.round(alpha * data[i + 3]);
    }
  }
  const trimmed = await sharp(outBuf, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toBuffer()
    .then((b) => sharp(b).trim({ threshold: 1 }).png().toBuffer());
  return trimmed;
}

/** Fit the mascot into a square canvas of `size`, occupying `fill` of it. */
async function mascotSquare(mascot, size, fill) {
  const inner = Math.round(size * fill);
  const resized = await sharp(mascot).resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: resized, gravity: 'center' }])
    .png()
    .toBuffer();
}

function backgroundSvg(size, radius) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${BG}"/>
        <stop offset="1" stop-color="${BG_2}"/>
      </linearGradient>
      <radialGradient id="shine" cx="0.3" cy="0.2" r="0.8">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.22"/>
        <stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="${size}" height="${size}" rx="${radius}" fill="url(#g)"/>
    <rect width="${size}" height="${size}" rx="${radius}" fill="url(#shine)"/>
  </svg>`);
}

/** App icon: gradient tile + mascot with a soft shadow. */
async function appIcon(mascot, size, { rounded = true, fill = 0.78 } = {}) {
  const radius = rounded ? Math.round(size * 0.225) : 0;
  const fg = await mascotSquare(mascot, size, fill);
  const shadow = await sharp(fg)
    .ensureAlpha()
    .linear([0, 0, 0, 0.45], [0, 0, 0, 0])
    .blur(Math.max(1, size / 60))
    .png()
    .toBuffer();
  return sharp(backgroundSvg(size, radius))
    .composite([
      { input: shadow, top: Math.round(size * 0.015), left: 0 },
      { input: fg, top: 0, left: 0 },
    ])
    .png()
    .toBuffer();
}

/** White silhouette for Android notification icons. */
async function silhouette(mascot, size) {
  const sq = await mascotSquare(mascot, size, 0.92);
  const { data, info } = await sharp(sq).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i + 1] = data[i + 2] = 255;
  }
  return sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
}

/** Minimal .ico writer (PNG-compressed entries, supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  const dir = Buffer.alloc(16 * pngs.length);
  let offset = 6 + dir.length;
  pngs.forEach(({ size, buf }, n) => {
    const o = n * 16;
    dir.writeUInt8(size >= 256 ? 0 : size, o);
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1);
    dir.writeUInt8(0, o + 2);
    dir.writeUInt8(0, o + 3);
    dir.writeUInt16LE(1, o + 4);
    dir.writeUInt16LE(32, o + 6);
    dir.writeUInt32LE(buf.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += buf.length;
  });
  return Buffer.concat([header, dir, ...pngs.map((p) => p.buf)]);
}

const mascot = await cutout();
await sharp(mascot).png().toFile(out('assets', 'mascot-cutout.png'));

if (process.argv.includes('--preview')) {
  const tiles = await Promise.all(
    [
      ['#39b5e0', '#2c6fcb'],
      ['#5cc443', '#2f8f2a'],
      ['#1d211d', '#0f110f'],
      ['#f6c453', '#e8913a'],
    ].map(async ([a, b]) => {
      process.env.ICON_BG = a;
      return sharp(
        Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="256" height="256" rx="58" fill="url(#g)"/></svg>`),
      )
        .composite([{ input: await mascotSquare(mascot, 256, 0.78) }])
        .png()
        .toBuffer();
    }),
  );
  await sharp({ create: { width: 256 * 4 + 50, height: 276, channels: 4, background: '#ffffff' } })
    .composite(tiles.map((t, i) => ({ input: t, left: 10 + i * 266, top: 10 })))
    .png()
    .toFile(out('assets', 'icon-preview.png'));
  console.log('wrote assets/icon-preview.png');
  process.exit(0);
}

// --- web / PWA ---
await sharp(await mascotSquare(mascot, 512, 1)).png().toFile(out('client', 'public', 'icons', 'mascot.png'));
await sharp(await appIcon(mascot, 512)).toFile(out('client', 'public', 'icons', 'icon-512.png'));
await sharp(await appIcon(mascot, 192)).toFile(out('client', 'public', 'icons', 'icon-192.png'));
await sharp(await appIcon(mascot, 512, { rounded: false, fill: 0.62 })).toFile(out('client', 'public', 'icons', 'maskable-512.png'));
await sharp(await appIcon(mascot, 180, { rounded: false, fill: 0.74 })).toFile(out('client', 'public', 'icons', 'apple-touch-icon.png'));
await sharp(await appIcon(mascot, 64)).resize(32, 32).toFile(out('client', 'public', 'icons', 'favicon-32.png'));
await sharp(await silhouette(mascot, 96)).toFile(out('client', 'public', 'icons', 'badge-96.png'));
fs.writeFileSync(out('client', 'public', 'favicon.ico'), ico(await Promise.all([16, 32, 48].map(async (size) => ({ size, buf: await appIcon(mascot, size * 2).then((b) => sharp(b).resize(size, size).png().toBuffer()) })))));

// --- Windows app (Tauri) --- then `npm run icons --prefix desktop` makes every size Windows needs from app-icon.png
await sharp(await appIcon(mascot, 1024)).toFile(out('desktop', 'app-icon.png'));
await sharp(await mascotSquare(mascot, 64, 1)).toFile(out('desktop', 'src-tauri', 'icons', 'tray.png'));
await sharp(await mascotSquare(mascot, 256, 1)).toFile(out('desktop', 'launcher', 'mascot.png'));
await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><circle cx="16" cy="16" r="13.5" fill="#e5534b" stroke="#ffffff" stroke-width="3"/></svg>'))
  .png()
  .toFile(out('desktop', 'src-tauri', 'icons', 'badge.png'));

// --- Capacitor (Android + iOS) sources for `npx @capacitor/assets generate` ---
await sharp(await appIcon(mascot, 1024, { rounded: false, fill: 0.72 })).toFile(out('client', 'assets', 'icon-only.png'));
await sharp(await mascotSquare(mascot, 1024, 0.56)).toFile(out('client', 'assets', 'icon-foreground.png'));
await sharp(backgroundSvg(1024, 0)).png().toFile(out('client', 'assets', 'icon-background.png'));
for (const [name, color] of [
  ['splash.png', '#151815'],
  ['splash-dark.png', '#151815'],
]) {
  await sharp({ create: { width: 2732, height: 2732, channels: 4, background: color } })
    .composite([{ input: await mascotSquare(mascot, 640, 1), gravity: 'center' }])
    .png()
    .toFile(out('client', 'assets', name));
}
await sharp(await silhouette(mascot, 96)).toFile(out('client', 'assets', 'notification-icon.png'));

console.log('Icons written for web, Windows, Android and iOS.');
