import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { all, get, run } from '../lib/db.ts';
import { absFile, offload, removeFile, writeUpload } from '../lib/files.ts';
import { badRequest, forbidden, newId, notFound, now, parse } from '../lib/util.ts';
import { emitAll } from '../realtime.ts';

export interface SoundRow {
  id: string;
  name: string;
  emoji: string;
  path: string;
  duration: number;
  volume: number;
  creator_id: string;
  created_at: number;
}

export function soundOut(s: SoundRow) {
  return {
    id: s.id,
    name: s.name,
    emoji: s.emoji,
    url: `/files/${s.path}`,
    duration: s.duration,
    volume: s.volume,
    creatorId: s.creator_id,
    createdAt: s.created_at,
  };
}

export const allSounds = () => all<SoundRow>('SELECT * FROM sounds ORDER BY created_at').map(soundOut);

/** Identify real audio files by their first bytes. */
function sniffAudio(abs: string): { ext: string } | null {
  const fd = fs.openSync(abs, 'r');
  const b = Buffer.alloc(16);
  fs.readSync(fd, b, 0, 16, 0);
  fs.closeSync(fd);
  const ascii = (start: number, len: number) => b.toString('latin1', start, start + len);
  if (ascii(0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { ext: 'mp3' };
  if (ascii(0, 4) === 'OggS') return { ext: 'ogg' };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return { ext: 'wav' };
  if (ascii(0, 4) === 'fLaC') return { ext: 'flac' };
  if (ascii(4, 4) === 'ftyp') return { ext: 'm4a' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { ext: 'webm' };
  return null;
}

const SoundName = z.string().trim().min(1, 'Give the sound a name').max(32);
const SoundEmoji = z.string().trim().max(64).default('');

export default async function soundRoutes(app: FastifyInstance) {
  app.post('/api/sounds', async (req) => {
    const me = auth(req);
    const file = await req.file();
    if (!file) throw badRequest('Pick a sound file first');
    const field = (n: string) => (file.fields[n] as { value?: unknown } | undefined)?.value;
    const name = SoundName.safeParse(field('name'));
    if (!name.success) {
      file.file.resume();
      throw badRequest(name.error.issues[0]?.message ?? 'Invalid name');
    }
    const id = newId();
    const tmp = `sounds/${id}.upload`;
    const { abs } = await writeUpload(file, tmp, 20 * 1024 * 1024);
    const audio = sniffAudio(abs);
    if (!audio) {
      removeFile(tmp);
      throw badRequest("That doesn't look like a sound file (MP3, WAV, OGG, M4A, FLAC or WebM work)");
    }
    const rel = `sounds/${id}.${audio.ext}`;
    fs.renameSync(abs, absFile(rel));
    const duration = Math.max(0, Math.min(36000, Number(field('duration')) || 0));
    const volume = Math.max(0.05, Math.min(1, Number(field('volume')) || 1));
    const emoji = SoundEmoji.safeParse(field('emoji'));
    run(
      'INSERT INTO sounds (id, name, emoji, path, duration, volume, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      name.data,
      emoji.success ? emoji.data : '',
      rel,
      duration,
      volume,
      me.id,
      now(),
    );
    offload(rel);
    const sound = soundOut(get<SoundRow>('SELECT * FROM sounds WHERE id = ?', id)!);
    emitAll('sound:create', sound);
    return sound;
  });

  app.patch('/api/sounds/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const sound = get<SoundRow>('SELECT * FROM sounds WHERE id = ?', id);
    if (!sound) throw notFound('That sound was deleted');
    if (sound.creator_id !== me.id && !me.is_admin) throw forbidden('Only the person who uploaded it can edit it');
    const body = parse(
      z.object({ name: SoundName.optional(), emoji: z.string().trim().max(64).optional(), volume: z.number().min(0.05).max(1).optional() }),
      req.body,
    );
    if (body.name !== undefined) run('UPDATE sounds SET name = ? WHERE id = ?', body.name, id);
    if (body.emoji !== undefined) run('UPDATE sounds SET emoji = ? WHERE id = ?', body.emoji, id);
    if (body.volume !== undefined) run('UPDATE sounds SET volume = ? WHERE id = ?', body.volume, id);
    const out = soundOut(get<SoundRow>('SELECT * FROM sounds WHERE id = ?', id)!);
    emitAll('sound:update', out);
    return out;
  });

  app.delete('/api/sounds/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const sound = get<SoundRow>('SELECT * FROM sounds WHERE id = ?', id);
    if (!sound) return { ok: true };
    if (sound.creator_id !== me.id && !me.is_admin) throw forbidden('Only the person who uploaded it can delete it');
    removeFile(sound.path);
    run('DELETE FROM sounds WHERE id = ?', id);
    emitAll('sound:delete', { id });
    return { ok: true };
  });
}
