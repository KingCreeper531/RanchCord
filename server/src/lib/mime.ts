import path from 'node:path';

/** File types browsers show in place. Everything else is sent as a download. */
export const INLINE_EXT = /\.(png|jpe?g|gif|webp|avif|mp4|webm|m4v|mov|mp3|ogg|oga|opus|wav|m4a|aac|flac)$/i;

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pdf: 'application/pdf',
  txt: 'text/plain',
  zip: 'application/zip',
};

export function mimeFromName(name: string): string | null {
  return TYPES[path.extname(name).slice(1).toLowerCase()] ?? null;
}

export function guessMime(filename: string, provided: string): string {
  return mimeFromName(filename) ?? (provided && /^[\w.+-]+\/[\w.+-]+$/.test(provided) ? provided : 'application/octet-stream');
}

/** A Content-Disposition value that survives any filename (spaces, emoji, accents). */
export function contentDisposition(filename: string, download: boolean): string {
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${download ? 'attachment' : 'inline'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
