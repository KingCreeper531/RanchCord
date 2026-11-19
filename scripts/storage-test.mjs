// Storage test: everyone's own bucket for sent files (direct uploads), the server's bucket for
// profile pictures, and shrinking. Needs a FRESH server (its first account becomes admin) and an
// S3-compatible endpoint (e.g. s3rver or MinIO) with two empty buckets.
// Usage: node scripts/storage-test.mjs <server> <s3 endpoint> <server bucket> <personal bucket> <access key> <secret> [data dir]
// Example: node scripts/storage-test.mjs http://localhost:6498 http://127.0.0.1:4569 ranchcord carrot-files S3RVER S3RVER server/data-storage-test
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'server', 'package.json'));
const sharp = require('sharp');

const [
  BASE = 'http://localhost:6498',
  ENDPOINT = 'http://127.0.0.1:4569',
  SERVER_BUCKET = 'ranchcord',
  MY_BUCKET = 'carrot-files',
  KEY = 'S3RVER',
  SECRET = 'S3RVER',
  DATA = 'server/data-storage-test',
] = process.argv.slice(2);
const dbPath = path.resolve(root, DATA, 'ranchcord.db');
const filesDir = path.resolve(root, DATA, 'files');

let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
};

async function api(method, p, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`${method} ${p} -> ${res.status} ${data?.error}`), { status: res.status, data });
  return data;
}

async function refused(promise, check, label) {
  try {
    await promise;
    ok(false, label);
  } catch (e) {
    ok(check(e), `${label} ("${e.data?.error ?? e.message}")`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await sleep(300);
  }
}

const localCount = () => {
  let n = 0;
  for (const top of ['attachments', 'avatars', 'emojis', 'icons', 'sounds']) {
    const dir = path.join(filesDir, top);
    if (fs.existsSync(dir)) n += fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).length;
  }
  return n;
};

/** What the app does: ask for an upload link, send the bytes straight to the bucket, confirm. */
async function sendFile(token, buf, filename, contentType, dims = {}) {
  const ticket = await api('POST', '/api/uploads', token, { filename, size: buf.length, contentType, ...dims });
  const put = await fetch(ticket.upload.url, { method: 'PUT', headers: ticket.upload.headers, body: buf });
  if (!put.ok) throw new Error(`bucket PUT failed ${put.status}`);
  return api('POST', `/api/uploads/${ticket.attachment.id}/finish`, token);
}

console.log(`Storage test against ${BASE} (buckets "${SERVER_BUCKET}" and "${MY_BUCKET}" at ${ENDPOINT})`);
const tag = Math.random().toString(36).slice(2, 7);
const admin = await api('POST', '/api/auth/register', undefined, { username: `boss_${tag}`, password: 'test-password-1' });
ok(admin.user.isAdmin, 'first account is the admin');
const T = admin.token;

// Test media: a noisy 1600x1200 photo (a few MB as PNG), a 6s 720p video and 20s of WAV audio.
const photo = await sharp({ create: { width: 1600, height: 1200, channels: 3, background: '#88aa55', noise: { type: 'gaussian', mean: 120, sigma: 40 } } })
  .png()
  .toBuffer();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-storage-'));
const videoPath = path.join(tmp, 'clip.mp4');
const audioPath = path.join(tmp, 'song.wav');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '6', '-c:v', 'libx264', '-crf', '12', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', videoPath]);
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-ac', '2', '-t', '20', audioPath]);
const video = fs.readFileSync(videoPath);
const audio = fs.readFileSync(audioPath);

const g = await api('POST', '/api/groups', T, { name: 'Storage Ranch' });
const text = g.channels.find((c) => c.type === 'text');

/* ---------- 1. no storage, no uploads ---------- */
await refused(api('POST', '/api/uploads', T, { filename: 'a.png', size: 10, contentType: 'image/png' }), (e) => e.status === 403 && e.data?.code === 'storage_required', 'sending files needs your own storage');

/* ---------- 2. linking your own bucket ---------- */
const mine = { endpoint: ENDPOINT, region: 'us-east-1', bucket: MY_BUCKET, accessKeyId: KEY, secretAccessKey: SECRET };
await refused(api('POST', '/api/storage/check', T, { ...mine, accessKeyId: 'WRONG-KEY' }), (e) => e.status === 400 && /wrong/i.test(e.data?.error), 'wrong key is refused');
await refused(api('POST', '/api/storage/check', T, { ...mine, bucket: 'no-such-bucket' }), (e) => e.status === 400, 'missing bucket is refused');
let check = await api('POST', '/api/storage/check', T, mine);
await refused(api('PUT', '/api/storage', T, { ...mine, checkKey: check.checkKey }), (e) => e.data?.code === 'storage_cors', "linking fails if the device can't upload");
check = await api('POST', '/api/storage/check', T, mine);
const testPut = await fetch(check.upload.url, { method: 'PUT', headers: check.upload.headers, body: 'ok' });
ok(testPut.ok, "the device's test upload reaches the bucket");
let st = await api('PUT', '/api/storage', T, { ...mine, checkKey: check.checkKey });
ok(st.linked && st.bucket === MY_BUCKET && !('secretAccessKey' in st), 'storage linked (secret never sent back)');
const raw = new DatabaseSync(dbPath);
raw.exec('PRAGMA busy_timeout = 5000');
const saved = raw.prepare('SELECT secret FROM user_storage WHERE user_id = ? AND active = 1').get(admin.user.id);
ok(saved && !saved.secret.includes(SECRET) && saved.secret.startsWith('v1.'), 'the secret key is stored encrypted');

/* ---------- 3. sending files straight to your bucket ---------- */
const ticket = await api('POST', '/api/uploads', T, { filename: 'early.png', size: photo.length, contentType: 'image/png' });
ok(ticket.upload.url.startsWith(`${ENDPOINT}/${MY_BUCKET}/`) && ticket.upload.method === 'PUT', 'upload link points at your own bucket');
await refused(api('POST', `/api/uploads/${ticket.attachment.id}/finish`, T), (e) => e.data?.code === 'upload_incomplete', "can't finish before the file arrives");
await refused(
  api('POST', `/api/channels/${text.id}/messages`, T, { content: 'x', attachmentIds: [ticket.attachment.id] }),
  (e) => e.status === 400,
  "can't send a file that hasn't finished uploading",
);
await refused(api('POST', '/api/uploads', T, { filename: 'huge.mp4', size: 60 * 1024 * 1024, contentType: 'video/mp4' }), (e) => e.status === 413, '50 MB limit still applies');

const att1 = await sendFile(T, photo, 'my photo.png', 'image/png', { width: 1600, height: 1200 });
ok(att1.width === 1600 && att1.contentType === 'image/png' && att1.size === photo.length, 'photo uploaded straight to the bucket');
const vid = await sendFile(T, video, 'clip.mp4', 'video/mp4', { width: 1280, height: 720 });
const wav = await sendFile(T, audio, 'song.wav', 'audio/wav');
ok(localCount() === 0, 'nothing was stored on the server');
const msg1 = await api('POST', `/api/channels/${text.id}/messages`, T, { content: 'my files', attachmentIds: [att1.id, vid.id, wav.id] });
ok(msg1.attachments.length === 3, 'message with files from your own storage');

let res = await fetch(BASE + att1.url, { redirect: 'manual' });
const loc = res.headers.get('location') ?? '';
ok(res.status === 302 && loc.startsWith(`${ENDPOINT}/${MY_BUCKET}/`) && loc.includes('X-Amz-Signature'), 'file link redirects to a signed link in your bucket');
res = await fetch(loc);
ok(res.ok && (await res.arrayBuffer()).byteLength === photo.length, 'friends get the same bytes from your bucket');
res = await fetch(BASE + att1.url + '?download=1');
ok(res.ok && /attachment/.test(res.headers.get('content-disposition') ?? ''), 'download link saves the file');

/* ---------- 4. the server's own bucket still holds profile pictures ---------- */
st = await api('PATCH', '/api/instance/storage', T, { mode: 'cloud', endpoint: ENDPOINT, region: 'us-east-1', bucket: SERVER_BUCKET, accessKeyId: KEY, secretAccessKey: SECRET });
ok(st.storage.mode === 'cloud', 'server bucket for profile pictures saved');
const av = new FormData();
av.append('file', new Blob([await sharp(photo).resize(256, 256).png().toBuffer()], { type: 'image/png' }), 'me.png');
const me = await api('POST', '/api/users/@me/avatar', T, av);
await until(() => localCount() === 0, 'avatar moves to the server bucket');
res = await fetch(BASE + me.avatar, { redirect: 'manual' });
ok(res.status === 302 && (res.headers.get('location') ?? '').startsWith(`${ENDPOINT}/${SERVER_BUCKET}/`), 'avatars load from the server bucket');

/* ---------- 5. shrinking files in your own bucket ---------- */
raw.prepare('UPDATE attachments SET created_at = ? WHERE id IN (?, ?, ?)').run(Date.now() - 40 * 86400000, att1.id, vid.id, wav.id);
await api('POST', '/api/instance/storage/shrink', T);
st = await until(async () => {
  const s = await api('GET', '/api/instance/storage', T);
  return !s.shrink.running && s.uploads.shrunk >= 3 ? s : null;
}, 'shrinking finishes', 120000);
ok(st.uploads.saved > 0, `shrinking saved ${(st.uploads.saved / 1024 / 1024).toFixed(1)} MB`);
const page = await api('GET', `/api/channels/${text.id}/messages?limit=10`, T);
const after = page.find((m) => m.id === msg1.id).attachments;
const p1 = after.find((a) => a.id === att1.id);
const v2 = after.find((a) => a.id === vid.id);
const a2 = after.find((a) => a.id === wav.id);
ok(p1.contentType === 'image/webp' && p1.filename === 'my photo.webp' && p1.size < photo.length / 2, `photo became WebP (${(photo.length / 1e6).toFixed(1)} MB -> ${(p1.size / 1e6).toFixed(2)} MB)`);
ok(v2.contentType === 'video/mp4' && v2.size < vid.size, `video shrunk (${(vid.size / 1e6).toFixed(1)} MB -> ${(v2.size / 1e6).toFixed(2)} MB)`);
ok(a2.contentType === 'audio/mp4' && a2.size < wav.size / 4, `audio became AAC (${(wav.size / 1e6).toFixed(1)} MB -> ${(a2.size / 1e6).toFixed(2)} MB)`);
ok(localCount() === 0, 'shrunk copies went back into your bucket, not the server');
res = await fetch(BASE + p1.url, { redirect: 'manual' });
ok(res.status === 302 && (res.headers.get('location') ?? '').startsWith(`${ENDPOINT}/${MY_BUCKET}/`), 'shrunk photo loads from your bucket');
res = await fetch(BASE + att1.url);
const meta = await sharp(Buffer.from(await res.arrayBuffer())).metadata();
ok(res.ok && meta.format === 'webp' && meta.width === 1600, 'old photo link still shows the picture');
await until(async () => (await api('GET', '/api/instance/storage', T)).storage.pendingDeletes === 0, 'old copies deleted');
res = await fetch(loc);
ok(res.status === 404 || res.status === 403, 'the original photo was removed from your bucket');

/* ---------- 6. deleting a message deletes its files from your bucket ---------- */
const vidLoc = (await fetch(BASE + v2.url, { redirect: 'manual' })).headers.get('location');
ok(Boolean(vidLoc) && (await fetch(vidLoc)).ok, 'video loads before deleting');
await api('DELETE', `/api/channels/${text.id}/messages/${msg1.id}`, T);
await until(async () => (await api('GET', '/api/instance/storage', T)).storage.pendingDeletes === 0, 'bucket deletes finish');
res = await fetch(vidLoc);
ok(res.status === 404 || res.status === 403, 'deleted message files are gone from your bucket');

/* ---------- 7. unlinking ---------- */
const keep = await sendFile(T, await sharp(photo).resize(320).jpeg().toBuffer(), 'keep.jpg', 'image/jpeg', { width: 320, height: 240 });
await api('POST', `/api/channels/${text.id}/messages`, T, { content: 'keep', attachmentIds: [keep.id] });
st = await api('DELETE', '/api/storage', T);
ok(!st.linked, 'storage unlinked');
await refused(api('POST', '/api/uploads', T, { filename: 'b.png', size: 10, contentType: 'image/png' }), (e) => e.data?.code === 'storage_required', 'no uploads after unlinking');
res = await fetch(BASE + keep.url);
ok(res.ok, 'files you already sent keep loading after unlinking');

await api('DELETE', `/api/groups/${g.id}`, T);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
