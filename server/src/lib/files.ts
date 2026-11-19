import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { MultipartFile } from '@fastify/multipart';
import { imageSizeFromFile } from 'image-size/fromFile';
import { config, filesDir } from '../config.ts';
import { doneWriting, markWriting, offload, removeStored } from './storage.ts';
import { HttpError, badRequest } from './util.ts';

export { INLINE_EXT, guessMime } from './mime.ts';
export { offload } from './storage.ts';

export function safeFilename(name: string): string {
  const base = path.basename(name || 'file').normalize('NFKC');
  const cleaned = base.replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/\s+/g, ' ').trim();
  const trimmed = cleaned.length > 120 ? cleaned.slice(0, 80) + cleaned.slice(-40) : cleaned;
  return trimmed.replace(/^\.+/, '') || 'file';
}

export function absFile(rel: string) {
  const abs = path.resolve(filesDir, rel);
  if (!abs.startsWith(path.resolve(filesDir) + path.sep)) throw badRequest('Bad file path');
  return abs;
}

/** Deletes a stored file, here and in the cloud bucket. */
export function removeFile(rel: string | null | undefined) {
  removeStored(rel);
}

/** Deletes a folder of stored files, here and in whichever bucket holds them. */
export function removeDir(rel: string, storageId?: string | null) {
  removeStored(rel, { dir: true, storageId });
}

export async function writeUpload(file: MultipartFile, rel: string, maxBytes = config.maxUploadBytes) {
  const abs = absFile(rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  markWriting(rel);
  try {
    await pipeline(file.file, fs.createWriteStream(abs));
  } finally {
    doneWriting(rel);
  }
  const size = fs.statSync(abs).size;
  if (file.file.truncated || size > maxBytes) {
    fs.rmSync(abs, { force: true });
    const mb = Math.round(maxBytes / 1024 / 1024);
    throw new HttpError(413, `That file is too big (the limit on this server is ${mb} MB)`, 'too_large');
  }
  return { abs, size };
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  heif: 'image/avif',
};

/** Detects real image files by their bytes (not the name) and returns their display size. */
export async function probeImage(abs: string): Promise<{ mime: string; ext: string; width: number; height: number } | null> {
  try {
    const info = await imageSizeFromFile(abs);
    const type = info.type ?? '';
    const mime = IMAGE_TYPES[type];
    if (!mime || !info.width || !info.height) return null;
    let { width, height } = info;
    // EXIF orientations 5-8 are rotated 90 degrees; browsers apply them, so swap to match what people will see.
    if (info.orientation && info.orientation >= 5) [width, height] = [height, width];
    return { mime, ext: type === 'jpg' ? 'jpg' : type === 'heif' ? 'avif' : type, width, height };
  } catch {
    return null;
  }
}

/** Saves an uploaded image as `<relBase>.<real extension>`. Rejects anything that isn't actually an image. */
export async function saveImage(file: MultipartFile, relBase: string, maxBytes: number) {
  const tmpRel = `${relBase}.upload`;
  const { abs } = await writeUpload(file, tmpRel, maxBytes);
  const image = await probeImage(abs);
  if (!image) {
    removeFile(tmpRel);
    throw badRequest("That doesn't look like an image (PNG, JPG, GIF or WebP work)");
  }
  const rel = `${relBase}.${image.ext}`;
  fs.renameSync(abs, absFile(rel));
  offload(rel);
  return { rel, ...image };
}
