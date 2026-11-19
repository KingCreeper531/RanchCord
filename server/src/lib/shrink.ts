/**
 * Shrinks old uploads so storage stays small: after a while (30 days by default) photos become
 * WebP no bigger than the chosen size, videos are re-encoded to a small MP4 and audio to AAC.
 * Old links keep working because /files/attachments/<id>/... always resolves to the current file.
 * Runs one file at a time at low priority so chat and calls stay smooth, even on a Raspberry Pi.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config.ts';
import { all, run } from './db.ts';
import { safeFilename } from './files.ts';
import type { AttachmentRow } from './model.ts';
import { getSetting } from './settings.ts';
import { adoptFile, fetchToFile, localPath, offloadBusy, putIntoUserStorage, removeStored } from './storage.ts';
import { now } from './util.ts';

export const SHRINK_LEVELS = {
  gentle: { maxSide: 2560, quality: 82, videoSide: 720, crf: 28, audioKbps: 128 },
  strong: { maxSide: 1600, quality: 72, videoSide: 480, crf: 31, audioKbps: 96 },
  extreme: { maxSide: 1080, quality: 55, videoSide: 360, crf: 34, audioKbps: 64 },
} as const;
export type ShrinkLevel = keyof typeof SHRINK_LEVELS;
type Level = (typeof SHRINK_LEVELS)[ShrinkLevel];

const DAY = 24 * 60 * 60 * 1000;
const tmpDir = path.join(config.dataDir, 'tmp');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export function shrinkDays(): number {
  const n = Number(getSetting('shrink_days') ?? process.env.SHRINK_AFTER_DAYS ?? 30);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 30;
}

export function shrinkLevel(): ShrinkLevel {
  const raw = getSetting('shrink_level') ?? process.env.SHRINK_LEVEL ?? 'strong';
  return raw in SHRINK_LEVELS ? (raw as ShrinkLevel) : 'strong';
}

/* ---------------- tools ---------------- */

let ffmpegOk: boolean | null = null;
let ffmpegCheckedAt = 0;
export function hasFfmpeg(): boolean {
  if (ffmpegOk !== null && Date.now() - ffmpegCheckedAt < 10 * 60 * 1000) return ffmpegOk;
  try {
    ffmpegOk = spawnSync(FFMPEG, ['-version'], { stdio: 'ignore', timeout: 15_000, windowsHide: true }).status === 0;
  } catch {
    ffmpegOk = false;
  }
  ffmpegCheckedAt = Date.now();
  return ffmpegOk;
}

type SharpFn = (typeof import('sharp'))['default'];
let sharpPromise: Promise<SharpFn | null> | null = null;
export function loadSharp(): Promise<SharpFn | null> {
  sharpPromise ??= import('sharp')
    .then((m) => {
      m.default.cache(false);
      m.default.concurrency(1);
      return m.default;
    })
    .catch(() => null);
  return sharpPromise;
}

function ffmpeg(args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    try {
      if (child.pid) os.setPriority(child.pid, 19);
    } catch {
      /* not allowed here; fine */
    }
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg stopped (${code ?? 'killed'}): ${stderr.trim().split('\n').pop() ?? ''}`));
    });
  });
}

/* ---------------- shrinking one file ---------------- */

interface Result {
  ext: string;
  type: string;
  width: number | null;
  height: number | null;
}

async function shrinkImage(sharp: SharpFn, src: string, out: string, level: Level): Promise<Result> {
  const meta = await sharp(src, { limitInputPixels: 268_402_689 }).metadata();
  const animated = (meta.pages ?? 1) > 1;
  const max = animated ? Math.min(level.maxSide, 640) : level.maxSide;
  let img = sharp(src, { animated, limitInputPixels: 268_402_689 });
  if (!animated) img = img.rotate(); // bake in the phone's EXIF rotation
  const info = await img
    .resize({ width: max, height: max, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: level.quality, effort: 4 })
    .toFile(out);
  return { ext: 'webp', type: 'image/webp', width: info.width, height: info.pageHeight ?? info.height };
}

const AUDIO_LAYOUT = ['-af', 'aformat=channel_layouts=mono|stereo'];

async function shrinkVideo(src: string, out: string, level: Level): Promise<Result> {
  const s = level.videoSide;
  // Shorter side becomes at most `s` pixels (480p by default), keeping the shape and even sizes.
  const scale = `scale=w='if(gt(iw,ih),-2,trunc(min(${s},iw)/2)*2)':h='if(gt(iw,ih),trunc(min(${s},ih)/2)*2,-2)'`;
  await ffmpeg(
    [
      '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?', '-sn', '-dn', '-map_metadata', '-1',
      '-vf', scale,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(level.crf), '-pix_fmt', 'yuv420p',
      ...AUDIO_LAYOUT, '-c:a', 'aac', '-b:a', `${Math.min(level.audioKbps, 96)}k`,
      '-movflags', '+faststart', '-threads', '2',
      out,
    ],
    4 * 60 * 60 * 1000,
  );
  return { ext: 'mp4', type: 'video/mp4', width: null, height: null };
}

async function shrinkAudio(src: string, out: string, level: Level): Promise<Result> {
  await ffmpeg(
    ['-i', src, '-map', '0:a:0', '-vn', '-sn', '-dn', '-map_metadata', '-1', ...AUDIO_LAYOUT, '-c:a', 'aac', '-b:a', `${level.audioKbps}k`, '-movflags', '+faststart', out],
    60 * 60 * 1000,
  );
  return { ext: 'm4a', type: 'audio/mp4', width: null, height: null };
}

/** Thrown when the bucket can't be reached: stop for now and try again on the next run. */
class RetryLater extends Error {}

const mark = (id: string, state: 1 | 2) => run('UPDATE attachments SET shrunk = ? WHERE id = ?', state, id);

/** Smallest files worth re-encoding. */
const MIN_SIZE: Record<string, number> = { image: 150_000, audio: 400_000, video: 1_500_000 };

async function shrinkOne(row: AttachmentRow, sharp: SharpFn | null, level: Level) {
  const kind = row.content_type.split('/')[0];
  if (row.size < (MIN_SIZE[kind] ?? Infinity)) return mark(row.id, 2);
  const ext = kind === 'image' ? 'webp' : kind === 'video' ? 'mp4' : 'm4a';
  const out = path.join(tmpDir, `${row.id}.out.${ext}`);
  let tmpSrc: string | null = null;
  try {
    let src = row.storage_id ? null : localPath(row.path);
    if (!src || !fs.existsSync(src)) {
      tmpSrc = path.join(tmpDir, `${row.id}.src`);
      const found = await fetchToFile(row.path, tmpSrc, row.storage_id).catch((err: unknown) => {
        // Someone's own bucket being unreachable shouldn't hold up everyone else's files.
        if (row.storage_id) return false;
        throw new RetryLater(err instanceof Error ? err.message : String(err));
      });
      if (!found) return mark(row.id, 2);
      src = tmpSrc;
    }

    let result: Result;
    try {
      if (kind === 'image') result = await shrinkImage(sharp!, src, out, level);
      else if (kind === 'video') result = await shrinkVideo(src, out, level);
      else result = await shrinkAudio(src, out, level);
    } catch (err) {
      console.warn(`[shrink] left ${row.filename} as it was:`, err instanceof Error ? err.message : err);
      return mark(row.id, 2);
    }

    const size = fs.statSync(out).size;
    // Only worth it if the copy is clearly smaller.
    if (size <= 0 || size > row.size * 0.85) return mark(row.id, 2);

    const base = (row.filename.replace(/\.[^.]*$/, '') || 'file').slice(0, 100);
    let name = safeFilename(`${base}.${result.ext}`);
    if (`attachments/${row.id}/${name}` === row.path) name = safeFilename(`${base}-small.${result.ext}`);
    const rel = `attachments/${row.id}/${name}`;
    if (row.storage_id) {
      // Files people sent go back into their own bucket.
      try {
        await putIntoUserStorage(row.storage_id, rel, out, { contentType: result.type, filename: name });
      } catch (err) {
        console.warn(`[shrink] couldn't save the smaller ${row.filename}:`, err instanceof Error ? err.message : err);
        return mark(row.id, 2);
      }
    } else {
      adoptFile(out, rel);
    }
    const changed = run(
      `UPDATE attachments SET path = ?, filename = ?, content_type = ?, size = ?, width = ?, height = ?, shrunk = 1, original_size = ?
       WHERE id = ? AND path = ?`,
      rel,
      name,
      result.type,
      size,
      result.width ?? row.width,
      result.height ?? row.height,
      row.size,
      row.id,
      row.path,
    );
    if (Number(changed.changes) === 0) {
      removeStored(rel, { storageId: row.storage_id }); // the message was deleted meanwhile
      return;
    }
    removeStored(row.path, { storageId: row.storage_id });
    state.shrunk++;
    state.saved += row.size - size;
  } finally {
    fs.rmSync(out, { force: true });
    if (tmpSrc) fs.rmSync(tmpSrc, { force: true });
  }
}

/* ---------------- the job ---------------- */

export const state = {
  running: false,
  current: '',
  lastRun: 0,
  lastError: '',
  shrunk: 0,
  saved: 0,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runShrink() {
  if (state.running || shrinkDays() <= 0) return;
  state.running = true;
  state.lastError = '';
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    const sharp = await loadSharp();
    const canVideo = hasFfmpeg();
    // Documents, zips and so on can't get smaller; mark them once so they're never looked at again.
    run(
      `UPDATE attachments SET shrunk = 2 WHERE shrunk = 0
         AND content_type NOT LIKE 'image/%' AND content_type NOT LIKE 'video/%' AND content_type NOT LIKE 'audio/%'`,
    );
    const kinds: string[] = [];
    if (sharp) kinds.push(`content_type LIKE 'image/%'`);
    if (canVideo) kinds.push(`content_type LIKE 'video/%'`, `content_type LIKE 'audio/%'`);
    if (!kinds.length) return;

    for (;;) {
      const days = shrinkDays();
      if (days <= 0) break;
      const rows = all<AttachmentRow>(
        `SELECT * FROM attachments
          WHERE shrunk = 0 AND pending = 0 AND message_id IS NOT NULL AND created_at < ? AND (${kinds.join(' OR ')})
          ORDER BY created_at LIMIT 25`,
        now() - days * DAY,
      );
      let progressed = false;
      for (const row of rows) {
        if (offloadBusy(row.path)) continue;
        state.current = row.filename;
        await shrinkOne(row, sharp, SHRINK_LEVELS[shrinkLevel()]);
        progressed = true;
        await sleep(250);
      }
      if (!progressed) break;
    }
  } catch (err) {
    state.lastError = err instanceof Error ? err.message : String(err);
    console.warn('[shrink] stopped for now:', state.lastError);
  } finally {
    state.running = false;
    state.current = '';
    state.lastRun = now();
  }
}

export async function shrinkStatus() {
  return {
    days: shrinkDays(),
    level: shrinkLevel(),
    images: Boolean(await loadSharp()),
    videos: hasFfmpeg(),
    running: state.running,
    current: state.current || null,
    lastRun: state.lastRun || null,
    lastError: state.lastError || null,
  };
}

export function initShrink() {
  setTimeout(() => void runShrink(), 2 * 60 * 1000).unref();
  setInterval(() => void runShrink(), 6 * 60 * 60 * 1000).unref();
}

export function describeShrink(): string {
  const days = shrinkDays();
  if (days <= 0) return 'off';
  const tools = hasFfmpeg() ? 'photos, videos and audio' : 'photos (install ffmpeg for videos and audio)';
  return `${tools} older than ${days} days (${shrinkLevel()})`;
}
