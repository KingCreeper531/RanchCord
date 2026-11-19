/**
 * Where uploaded files live.
 *
 * Files people send in chats go to *their own* storage (an S3-compatible bucket like Backblaze B2
 * or Cloudflare R2). The app uploads them straight from the sender's device using a short-lived
 * signed link, so the bytes never pass through this server.
 *
 * Small shared things (profile pictures, emojis, sounds, icons) are kept by the server: on its own
 * disk, or moved in the background to the server's cloud bucket when the admin sets one up.
 *
 * Every file is still requested through /files/... on this server, which answers with the file
 * itself or a signed link to whichever bucket holds it.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { S3Client } from '@aws-sdk/client-s3';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { filesDir } from '../config.ts';
import { all, get, run } from './db.ts';
import { INLINE_EXT, contentDisposition, mimeFromName } from './mime.ts';
import { unseal } from './secretbox.ts';
import { getSetting } from './settings.ts';
import { HttpError, badRequest, notFound, now, randomCode } from './util.ts';

const env = process.env;
const TOP_DIRS = new Set(['attachments', 'avatars', 'emojis', 'icons', 'sounds', 'stickers']);

/* ---------------- settings ---------------- */

export type StorageMode = 'local' | 'cloud';

export interface BucketSettings {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional public address of the bucket (custom domain). Without it files get signed links. */
  publicUrl: string;
  /** Optional folder inside the bucket, so one bucket can hold several things. */
  prefix: string;
}

function setting(key: string, envKey: string, fallback = ''): string {
  return getSetting(key) ?? env[envKey] ?? fallback;
}

export function storageMode(): StorageMode {
  const raw = setting('storage_mode', 'STORAGE', 'local').trim().toLowerCase();
  return raw === 'cloud' || raw === 's3' ? 'cloud' : 'local';
}

const normalizePrefix = (raw: string) => {
  const p = raw.trim().replace(/^\/+|\/+$/g, '');
  return p ? `${p}/` : '';
};

export function bucketSettings(): BucketSettings {
  return {
    endpoint: setting('s3_endpoint', 'S3_ENDPOINT').trim().replace(/\/+$/, ''),
    region: setting('s3_region', 'S3_REGION', 'auto').trim() || 'auto',
    bucket: setting('s3_bucket', 'S3_BUCKET').trim(),
    accessKeyId: setting('s3_access_key', 'S3_ACCESS_KEY_ID').trim(),
    secretAccessKey: setting('s3_secret_key', 'S3_SECRET_ACCESS_KEY').trim(),
    publicUrl: setting('s3_public_url', 'S3_PUBLIC_URL').trim().replace(/\/+$/, ''),
    prefix: normalizePrefix(setting('s3_prefix', 'S3_PREFIX')),
  };
}

export const bucketComplete = (s: BucketSettings) => Boolean(s.bucket && s.accessKeyId && s.secretAccessKey);

/* ---------------- the S3 client (loaded only when a bucket is used) ---------------- */

type Sdk = {
  s3: typeof import('@aws-sdk/client-s3');
  lib: typeof import('@aws-sdk/lib-storage');
  presign: typeof import('@aws-sdk/s3-request-presigner');
};

let sdkPromise: Promise<Sdk> | null = null;
function loadSdk(): Promise<Sdk> {
  sdkPromise ??= Promise.all([
    import('@aws-sdk/client-s3'),
    import('@aws-sdk/lib-storage'),
    import('@aws-sdk/s3-request-presigner'),
  ]).then(([s3, lib, presign]) => ({ s3, lib, presign }));
  return sdkPromise;
}

interface Bucket {
  /** null for the server's own bucket, otherwise the user_storage id. */
  id: string | null;
  settings: BucketSettings;
  client: S3Client;
  sdk: Sdk;
}

/** B2 and Wasabi sign requests with the region in their address; R2 and most others accept "auto". */
function regionFor(s: BucketSettings): string {
  if (s.region && s.region !== 'auto') return s.region;
  const fromHost = /s3[.-]([a-z0-9-]+)\.(?:backblazeb2\.com|wasabisys\.com|amazonaws\.com)/i.exec(s.endpoint);
  if (fromHost) return fromHost[1];
  return s.endpoint ? 'auto' : 'us-east-1';
}

function makeClient(sdk: Sdk, s: BucketSettings): S3Client {
  return new sdk.s3.S3Client({
    endpoint: s.endpoint || undefined,
    region: regionFor(s),
    forcePathStyle: Boolean(s.endpoint) && env.S3_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey },
    // R2, B2 and friends don't all understand the newest AWS checksum headers.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 15_000, requestTimeout: 120_000 },
  });
}

/* ---------------- the server's bucket ---------------- */

let serverBucketCache: Bucket | null = null;
let serverBucketKey = '';
let settingsCache: { mode: StorageMode; bucket: BucketSettings } | null = null;

function current() {
  settingsCache ??= { mode: storageMode(), bucket: bucketSettings() };
  return settingsCache;
}

/** Call after changing any server storage setting. */
export function storageSettingsChanged() {
  settingsCache = null;
  presignCache.clear();
  void scanLocalFiles();
}

async function serverBucket(): Promise<Bucket | null> {
  const s = current().bucket;
  if (!bucketComplete(s)) {
    serverBucketCache?.client.destroy();
    serverBucketCache = null;
    serverBucketKey = '';
    return null;
  }
  const key = JSON.stringify(s);
  if (serverBucketCache && key === serverBucketKey) return serverBucketCache;
  const sdk = await loadSdk();
  serverBucketCache?.client.destroy();
  serverBucketCache = { id: null, settings: s, client: makeClient(sdk, s), sdk };
  serverBucketKey = key;
  presignCache.clear();
  return serverBucketCache;
}

/* ---------------- everyone's own buckets ---------------- */

export interface UserStorageRow {
  id: string;
  user_id: string;
  endpoint: string;
  region: string;
  bucket: string;
  access_key_id: string;
  secret: string;
  public_url: string;
  prefix: string;
  active: number;
  created_at: number;
}

/** The bucket someone currently sends files to, if they've linked one. */
export function activeUserStorage(userId: string): UserStorageRow | null {
  return get<UserStorageRow>('SELECT * FROM user_storage WHERE user_id = ? AND active = 1 ORDER BY created_at DESC LIMIT 1', userId) ?? null;
}

const userBuckets = new Map<string, Promise<Bucket | null>>();

/** Storage rows never change (a new bucket is a new row), so clients are cached for good. */
function userBucket(storageId: string): Promise<Bucket | null> {
  let bucket = userBuckets.get(storageId);
  if (!bucket) {
    bucket = (async () => {
      const row = get<UserStorageRow>('SELECT * FROM user_storage WHERE id = ?', storageId);
      if (!row) return null;
      let secret: string;
      try {
        secret = unseal(row.secret);
      } catch {
        return null;
      }
      const settings: BucketSettings = {
        endpoint: row.endpoint,
        region: row.region,
        bucket: row.bucket,
        accessKeyId: row.access_key_id,
        secretAccessKey: secret,
        publicUrl: row.public_url,
        prefix: row.prefix,
      };
      const sdk = await loadSdk();
      return { id: row.id, settings, client: makeClient(sdk, settings), sdk };
    })();
    userBuckets.set(storageId, bucket);
  }
  return bucket;
}

const bucketFor = (storageId: string | null | undefined) => (storageId ? userBucket(storageId) : serverBucket());

const offloadOn = () => current().mode === 'cloud' && bucketComplete(current().bucket);
const keyFor = (b: Bucket, rel: string) => b.settings.prefix + rel;
const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

async function remoteSize(b: Bucket, rel: string): Promise<number | null> {
  try {
    const head = await b.client.send(new b.sdk.s3.HeadObjectCommand({ Bucket: b.settings.bucket, Key: keyFor(b, rel) }));
    return head.ContentLength ?? null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Size of a file in someone's bucket, or null if it isn't there. */
export async function storedSize(storageId: string, rel: string): Promise<number | null> {
  const b = await userBucket(storageId);
  if (!b) throw badRequest('That storage is no longer linked');
  return remoteSize(b, rel);
}

/** A link the sender's device uploads one file to, straight into their own bucket. */
export async function presignUpload(storageId: string, rel: string, opts: { contentType: string; size: number; filename: string }) {
  const b = await userBucket(storageId);
  if (!b) throw badRequest('Link your storage again in Settings → My Storage');
  const disposition = contentDisposition(opts.filename, !INLINE_EXT.test(opts.filename));
  const url = await b.sdk.presign.getSignedUrl(
    b.client,
    new b.sdk.s3.PutObjectCommand({
      Bucket: b.settings.bucket,
      Key: keyFor(b, rel),
      ContentType: opts.contentType,
      ContentLength: opts.size,
      ContentDisposition: disposition,
    }),
    // Type, size and name are part of the signature, so the link only accepts exactly this file.
    { expiresIn: 60 * 60, signableHeaders: new Set(['content-type', 'content-length', 'content-disposition']) },
  );
  return { url, method: 'PUT' as const, headers: { 'Content-Type': opts.contentType, 'Content-Disposition': disposition } };
}

/* ---------------- local paths ---------------- */

/** Absolute path for a stored file, or null if the path tries to leave the files folder. */
export function localPath(rel: string): string | null {
  const abs = path.resolve(filesDir, rel);
  return abs.startsWith(path.resolve(filesDir) + path.sep) ? abs : null;
}

function isFile(abs: string): boolean {
  try {
    return fs.statSync(abs).isFile();
  } catch {
    return false;
  }
}

interface AttachmentInfo {
  path: string;
  filename: string;
  content_type: string;
  storage_id: string | null;
  pending: number;
}

function attachmentInfo(rel: string): AttachmentInfo | null {
  const [top, id] = rel.split('/');
  if (top !== 'attachments' || !id) return null;
  return get<AttachmentInfo>('SELECT path, filename, content_type, storage_id, pending FROM attachments WHERE id = ?', id) ?? null;
}

/* ---------------- moving the server's files to its bucket ---------------- */

/** Files that are still being written by an upload. */
const writing = new Set<string>();
export const markWriting = (rel: string) => void writing.add(rel);
export const doneWriting = (rel: string) => void writing.delete(rel);

const queue = new Set<string>();
const inFlight = new Set<string>();
let pumping = false;

export const status = {
  lastError: '',
  lastErrorAt: 0,
  uploaded: 0,
};

function fail(err: unknown, what: string) {
  const message = err instanceof Error ? err.message : String(err);
  status.lastError = `${what}: ${message}`;
  status.lastErrorAt = now();
  console.warn(`[storage] ${what}:`, message);
}

/** Queue a finished local file for upload to the server's bucket (does nothing when files stay on this server). */
export function offload(rel: string) {
  if (!offloadOn()) return;
  queue.add(rel);
  void pump();
}

/** True while a file is being moved to the server's bucket. */
export const offloadBusy = (rel: string) => inFlight.has(rel) || queue.has(rel);

async function pump() {
  if (pumping) return;
  pumping = true;
  try {
    while (queue.size && offloadOn()) {
      const rel = queue.values().next().value as string;
      queue.delete(rel);
      if (writing.has(rel)) continue;
      const abs = localPath(rel);
      if (!abs || !isFile(abs)) continue;
      const b = await serverBucket();
      if (!b) break;
      inFlight.add(rel);
      try {
        await putFile(b, rel, abs);
        // The bucket has it now, so free the space here.
        try {
          fs.rmSync(abs, { force: true });
          if (rel.startsWith('attachments/')) fs.rmdirSync(path.dirname(abs));
        } catch {
          /* in use right now or folder not empty; the next scan tidies up */
        }
        status.uploaded++;
        status.lastError = '';
      } catch (err) {
        // Most likely the bucket is unreachable right now. Everything left stays on this server
        // (and keeps working) until the next check in a few minutes.
        fail(err, `Couldn't move ${rel} to the bucket`);
        queue.clear();
        break;
      } finally {
        inFlight.delete(rel);
      }
    }
  } finally {
    pumping = false;
  }
}

/** Uploads a local file to a bucket (skipped if an identical copy is already there). */
async function putFile(b: Bucket, rel: string, abs: string, meta?: { contentType: string; filename: string }) {
  const size = fs.statSync(abs).size;
  if ((await remoteSize(b, rel)) === size) return;
  const info = meta ? { content_type: meta.contentType, filename: meta.filename } : attachmentInfo(rel);
  const name = info?.filename ?? path.basename(rel);
  const upload = new b.sdk.lib.Upload({
    client: b.client,
    params: {
      Bucket: b.settings.bucket,
      Key: keyFor(b, rel),
      Body: fs.createReadStream(abs),
      ContentType: info?.content_type ?? mimeFromName(rel) ?? 'application/octet-stream',
      ContentDisposition: contentDisposition(name, !INLINE_EXT.test(name)),
      CacheControl: 'public, max-age=31536000, immutable',
    },
    queueSize: 2,
    partSize: 16 * 1024 * 1024,
    leavePartsOnError: false,
  });
  await upload.done();
  const stored = await remoteSize(b, rel);
  if (stored !== size) throw new Error(`the bucket has ${stored ?? 'nothing'} bytes instead of ${size}`);
}

/** Puts a finished local file (e.g. a shrunk copy) into someone's own bucket. */
export async function putIntoUserStorage(storageId: string, rel: string, abs: string, meta: { contentType: string; filename: string }) {
  const b = await userBucket(storageId);
  if (!b) throw new Error('that storage is no longer linked');
  await putFile(b, rel, abs, meta);
}

/** Finds local files that should be in the server's bucket (after switching to cloud storage, or after an outage). */
export async function scanLocalFiles() {
  if (!offloadOn()) return;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  for (const { rel, abs, stat } of localFiles()) {
    if (writing.has(rel) || inFlight.has(rel)) continue;
    if (rel.endsWith('.upload')) {
      if (stat.mtimeMs < dayAgo) fs.rmSync(abs, { force: true });
      continue;
    }
    // Half-finished uploads with no message are left for the orphan cleanup.
    if (rel.startsWith('attachments/') && !attachmentInfo(rel)) continue;
    queue.add(rel);
  }
  removeEmptyAttachmentDirs();
  await pump();
}

function* localFiles(): Generator<{ rel: string; abs: string; stat: fs.Stats }> {
  for (const top of TOP_DIRS) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(filesDir, top), { withFileTypes: true, recursive: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const abs = path.join(entry.parentPath, entry.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(abs);
      } catch {
        continue;
      }
      yield { rel: path.relative(filesDir, abs).split(path.sep).join('/'), abs, stat };
    }
  }
}

function removeEmptyAttachmentDirs() {
  const root = path.join(filesDir, 'attachments');
  let dirs: string[];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const d of dirs) {
    try {
      fs.rmdirSync(path.join(root, d));
    } catch {
      /* not empty */
    }
  }
}

/* ---------------- deleting ---------------- */

/** Deletes a stored file (or a whole folder) here and in whichever bucket holds it. */
export function removeStored(rel: string | null | undefined, opts: { dir?: boolean; storageId?: string | null } = {}) {
  if (!rel) return;
  const abs = localPath(rel);
  if (!abs) return;
  try {
    fs.rmSync(abs, { force: true, recursive: Boolean(opts.dir) });
  } catch {
    /* already gone */
  }
  for (const q of queue) if (q === rel || (opts.dir && q.startsWith(`${rel}/`))) queue.delete(q);
  if (!opts.storageId && !bucketComplete(current().bucket)) return;
  run(
    'INSERT OR IGNORE INTO storage_deletes (key, is_prefix, storage_id, created_at) VALUES (?, ?, ?, ?)',
    opts.dir ? `${rel}/` : rel,
    opts.dir ? 1 : 0,
    opts.storageId ?? null,
    now(),
  );
  void processDeletes();
}

let deleting = false;
let deletesRequested = false;
export async function processDeletes() {
  // Deletes queued while a run is going get picked up by that run instead of waiting for the next one.
  deletesRequested = true;
  if (deleting) return;
  deleting = true;
  try {
    while (deletesRequested) {
      deletesRequested = false;
      await deleteQueuedBatches();
    }
  } catch (err) {
    fail(err, "Couldn't delete files from a bucket");
  } finally {
    deleting = false;
  }
}

async function deleteQueuedBatches() {
  {
    for (;;) {
      const rows = all<{ key: string; is_prefix: number; storage_id: string | null }>(
        'SELECT key, is_prefix, storage_id FROM storage_deletes ORDER BY created_at LIMIT 200',
      );
      let done = 0;
      for (const row of rows) {
        // Wait for an upload of the same file to finish, or it would come back.
        if (!row.storage_id && [...inFlight].some((f) => f === row.key || (row.is_prefix && f.startsWith(row.key)))) continue;
        const b = await bucketFor(row.storage_id);
        if (b) {
          if (row.is_prefix) {
            let token: string | undefined;
            do {
              const list = await b.client.send(
                new b.sdk.s3.ListObjectsV2Command({ Bucket: b.settings.bucket, Prefix: keyFor(b, row.key), ContinuationToken: token }),
              );
              for (const obj of list.Contents ?? []) {
                if (obj.Key) await b.client.send(new b.sdk.s3.DeleteObjectCommand({ Bucket: b.settings.bucket, Key: obj.Key }));
              }
              token = list.IsTruncated ? list.NextContinuationToken : undefined;
            } while (token);
          } else {
            await b.client.send(new b.sdk.s3.DeleteObjectCommand({ Bucket: b.settings.bucket, Key: keyFor(b, row.key) }));
          }
        }
        run('DELETE FROM storage_deletes WHERE key = ?', row.key);
        done++;
      }
      if (rows.length < 200 || done === 0) break;
    }
  }
}

/* ---------------- reading ---------------- */

/** Downloads a file from whichever bucket holds it. Returns false if it isn't there. */
export async function fetchToFile(rel: string, dest: string, storageId?: string | null): Promise<boolean> {
  const b = await bucketFor(storageId);
  if (!b) return false;
  try {
    const res = await b.client.send(new b.sdk.s3.GetObjectCommand({ Bucket: b.settings.bucket, Key: keyFor(b, rel) }));
    await pipeline(res.Body as Readable, fs.createWriteStream(dest));
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw err;
  }
}

/** Moves a finished file (e.g. a shrunk copy) into the files folder and sends it on to the server's bucket. */
export function adoptFile(tmpAbs: string, rel: string) {
  const abs = localPath(rel);
  if (!abs) throw badRequest('Bad file path');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.renameSync(tmpAbs, abs);
  offload(rel);
}

const SIGN_WINDOW = 12 * 60 * 60 * 1000;
const presignCache = new Map<string, { url: string; until: number }>();

async function bucketUrl(b: Bucket, rel: string, downloadName: string | null): Promise<string> {
  if (b.settings.publicUrl && !downloadName) return `${b.settings.publicUrl}/${encodePath(keyFor(b, rel))}`;
  const cacheKey = `${b.id ?? 'server'}\n${rel}\n${downloadName ?? ''}`;
  const t = Date.now();
  const hit = presignCache.get(cacheKey);
  if (hit && hit.until > t) return hit.url;
  // Links are signed for fixed 12-hour windows so the same file keeps the same link for a while
  // and stays in everyone's browser cache.
  const windowStart = Math.floor(t / SIGN_WINDOW) * SIGN_WINDOW;
  const url = await b.sdk.presign.getSignedUrl(
    b.client,
    new b.sdk.s3.GetObjectCommand({
      Bucket: b.settings.bucket,
      Key: keyFor(b, rel),
      ResponseContentDisposition: downloadName ? contentDisposition(downloadName, true) : undefined,
      ResponseCacheControl: 'private, max-age=31536000, immutable',
    }),
    { expiresIn: (3 * SIGN_WINDOW) / 1000, signingDate: new Date(windowStart) },
  );
  if (presignCache.size > 20_000) presignCache.clear();
  presignCache.set(cacheKey, { url, until: windowStart + SIGN_WINDOW });
  return url;
}

/** GET /files/* */
export async function serveFile(req: FastifyRequest, reply: FastifyReply) {
  const rel = (req.params as Record<string, string | undefined>)['*'] ?? '';
  const parts = rel.split('/');
  if (!TOP_DIRS.has(parts[0]) || parts.length < 2 || parts.some((p) => !p || p.startsWith('.')) || rel.endsWith('.upload')) {
    throw notFound('File not found');
  }
  const download = (req.query as Record<string, string | undefined>).download === '1';
  let name = parts[parts.length - 1];
  const info = attachmentInfo(rel);
  if (parts[0] === 'attachments') {
    if (!info || info.pending) throw notFound('File not found');
    if (info.path !== rel) {
      // An older link to a file that has since been shrunk.
      reply.header('Cache-Control', 'public, max-age=3600');
      return reply.redirect(`/files/${encodePath(info.path)}${download ? '?download=1' : ''}`, 302);
    }
    name = info.filename;
  }

  const abs = info?.storage_id ? null : localPath(rel);
  if (abs && isFile(abs)) {
    // Sent so it can never run as a web page on this site.
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    if (download || !INLINE_EXT.test(name)) reply.header('Content-Disposition', contentDisposition(name, true));
    return reply.sendFile(rel, filesDir, { cacheControl: false });
  }

  const b = await bucketFor(info?.storage_id);
  if (!b) throw new HttpError(404, info?.storage_id ? "This file is in storage that's no longer linked" : 'File not found', 'not_found');
  const url = await bucketUrl(b, rel, download ? name : null);
  reply.header('Cache-Control', b.settings.publicUrl && !download ? 'public, max-age=86400' : 'private, max-age=3600');
  return reply.redirect(url, 302);
}

/* ---------------- checking a bucket works ---------------- */

function friendlyError(err: unknown, s: BucketSettings): string {
  const e = err as { name?: string; code?: string; message?: string; $metadata?: { httpStatusCode?: number }; cause?: { code?: string } };
  const name = e?.name ?? '';
  const code = e?.code ?? e?.cause?.code ?? '';
  const http = e?.$metadata?.httpStatusCode;
  if (['InvalidAccessKeyId', 'SignatureDoesNotMatch', 'InvalidToken', 'Unauthorized', 'InvalidArgument'].includes(name) || http === 401) {
    return 'The key ID or secret key is wrong.';
  }
  if (name === 'NoSuchBucket') return `There's no bucket called "${s.bucket}". Check the name (capitals matter).`;
  if (name === 'AccessDenied' || http === 403) return "That key isn't allowed to use this bucket. Give it read and write access to the bucket.";
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED'].includes(code) || name === 'TimeoutError') {
    return `Couldn't reach ${s.endpoint || 'the storage service'}. Check the endpoint address.`;
  }
  return `The bucket said: ${e?.message || name || 'unknown error'}`;
}

/** Writes, reads back and deletes a small file to prove the details work. */
export async function testBucket(s: BucketSettings): Promise<{ publicUrlWorks: boolean | null }> {
  const sdk = await loadSdk();
  const client = makeClient(sdk, s);
  const key = `${s.prefix}.ranchcord-check-${randomCode(10).toLowerCase()}.txt`;
  const body = 'RanchCord storage check';
  try {
    await client.send(new sdk.s3.PutObjectCommand({ Bucket: s.bucket, Key: key, Body: body, ContentType: 'text/plain' }));
    const url = await sdk.presign.getSignedUrl(client, new sdk.s3.GetObjectCommand({ Bucket: s.bucket, Key: key }), { expiresIn: 300 });
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok || (await res.text()) !== body) throw new Error(`files upload fine but can't be read back with a signed link (HTTP ${res.status})`);
    let publicUrlWorks: boolean | null = null;
    if (s.publicUrl) {
      const pub = await fetch(`${s.publicUrl}/${encodePath(key)}`, { signal: AbortSignal.timeout(20_000) }).catch(() => null);
      publicUrlWorks = Boolean(pub?.ok);
    }
    await client.send(new sdk.s3.DeleteObjectCommand({ Bucket: s.bucket, Key: key }));
    return { publicUrlWorks };
  } catch (err) {
    throw badRequest(friendlyError(err, s), 'storage_test_failed');
  } finally {
    client.destroy();
  }
}

/** Lets the app upload into the bucket from any device (browsers need this "CORS" rule). Best effort. */
async function allowBrowserUploads(sdk: Sdk, client: S3Client, bucket: string): Promise<boolean> {
  const command = new sdk.s3.PutBucketCorsCommand({
    Bucket: bucket,
    CORSConfiguration: {
      CORSRules: [
        {
          AllowedOrigins: ['*'],
          AllowedMethods: ['GET', 'PUT', 'HEAD'],
          AllowedHeaders: ['content-type', 'content-disposition'],
          ExposeHeaders: ['ETag'],
          MaxAgeSeconds: 86400,
        },
      ],
    },
  });
  // Some providers still insist on the older Content-MD5 header for this request.
  command.middlewareStack.add(
    (next) => async (args) => {
      const request = args.request as { headers?: Record<string, string>; body?: unknown };
      if (request.headers && typeof request.body === 'string') {
        request.headers['content-md5'] = createHash('md5').update(request.body).digest('base64');
      }
      return next(args);
    },
    { step: 'build', name: 'ranchcordContentMd5' },
  );
  try {
    await client.send(command);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks someone's own bucket before linking it: the server writes and deletes a test file, then
 * hands back a signed link so the person's device can prove it can upload there too.
 */
export async function checkUserBucket(s: BucketSettings): Promise<{ checkKey: string; corsSet: boolean; upload: Awaited<ReturnType<typeof presignUpload>> }> {
  await testBucket(s);
  const sdk = await loadSdk();
  const client = makeClient(sdk, s);
  try {
    const corsSet = await allowBrowserUploads(sdk, client, s.bucket);
    const checkKey = `.ranchcord-check/${randomCode(16).toLowerCase()}.txt`;
    const bucket: Bucket = { id: null, settings: s, client, sdk };
    const disposition = contentDisposition('check.txt', true);
    const url = await sdk.presign.getSignedUrl(
      client,
      new sdk.s3.PutObjectCommand({ Bucket: s.bucket, Key: keyFor(bucket, checkKey), ContentType: 'text/plain', ContentLength: 2, ContentDisposition: disposition }),
      { expiresIn: 15 * 60, signableHeaders: new Set(['content-type', 'content-length', 'content-disposition']) },
    );
    return { checkKey, corsSet, upload: { url, method: 'PUT', headers: { 'Content-Type': 'text/plain', 'Content-Disposition': disposition } } };
  } finally {
    // The client is only used for these quick calls.
    setTimeout(() => client.destroy(), 1000).unref();
  }
}

/** Confirms the device's test upload arrived, then removes it. */
export async function confirmUserBucket(s: BucketSettings, checkKey: string): Promise<boolean> {
  if (!/^\.ranchcord-check\/[a-z0-9]{16}\.txt$/.test(checkKey)) return false;
  const sdk = await loadSdk();
  const client = makeClient(sdk, s);
  const bucket: Bucket = { id: null, settings: s, client, sdk };
  try {
    const size = await remoteSize(bucket, checkKey);
    await client.send(new sdk.s3.DeleteObjectCommand({ Bucket: s.bucket, Key: keyFor(bucket, checkKey) })).catch(() => {});
    return size === 2;
  } catch (err) {
    throw badRequest(friendlyError(err, s), 'storage_test_failed');
  } finally {
    client.destroy();
  }
}

/* ---------------- admin status ---------------- */

export function localUsage() {
  let bytes = 0;
  let files = 0;
  for (const { stat } of localFiles()) {
    bytes += stat.size;
    files++;
  }
  return { bytes, files };
}

export function storageStatus() {
  const s = current().bucket;
  return {
    mode: current().mode,
    endpoint: s.endpoint,
    region: s.region,
    bucket: s.bucket,
    accessKeyId: s.accessKeyId,
    secretSet: Boolean(s.secretAccessKey),
    publicUrl: s.publicUrl,
    connected: bucketComplete(s),
    local: localUsage(),
    waiting: queue.size + inFlight.size,
    uploaded: status.uploaded,
    pendingDeletes: get<{ n: number }>('SELECT COUNT(*) AS n FROM storage_deletes')!.n,
    lastError: status.lastError || null,
    lastErrorAt: status.lastErrorAt || null,
  };
}

export function initStorage() {
  setTimeout(() => {
    void scanLocalFiles();
    void processDeletes();
  }, 5_000).unref();
  setInterval(() => {
    void scanLocalFiles();
    void processDeletes();
  }, 10 * 60 * 1000).unref();
}

export function describeStorage(): string {
  const { mode, bucket: s } = current();
  const shared = (() => {
    if (mode !== 'cloud' || !bucketComplete(s)) return 'on this server';
    let host = '';
    try {
      host = s.endpoint ? ` at ${new URL(s.endpoint).host}` : '';
    } catch {
      /* odd endpoint; just leave it out */
    }
    return `cloud bucket "${s.bucket}"${host}`;
  })();
  return `sent files go to each person's own storage; profile pictures and emojis ${shared}`;
}
