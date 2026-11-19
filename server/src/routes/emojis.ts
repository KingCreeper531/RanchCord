import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { get, run } from '../lib/db.ts';
import { removeFile, saveImage } from '../lib/files.ts';
import { type EmojiRow, emojiOut } from '../lib/model.ts';
import { badRequest, forbidden, newId, notFound, now, parse } from '../lib/util.ts';
import { emitAll } from '../realtime.ts';

const EmojiName = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_]{2,32}$/, 'Emoji names are 2-32 letters, numbers or underscores');

/** Custom emojis are shared by everyone on the server, so anyone can use anyone's photo emojis anywhere. */
export default async function emojiRoutes(app: FastifyInstance) {
  app.post('/api/emojis', async (req) => {
    const me = auth(req);
    const file = await req.file();
    if (!file) throw badRequest('Pick an image first');
    const rawName = (file.fields.name as { value?: unknown } | undefined)?.value;
    const parsed = EmojiName.safeParse(rawName);
    if (!parsed.success) {
      file.file.resume();
      throw badRequest(parsed.error.issues[0]?.message ?? 'Invalid emoji name');
    }
    const name = parsed.data;
    if (get('SELECT 1 FROM emojis WHERE name = ?', name)) {
      file.file.resume();
      throw badRequest(`There's already an emoji called :${name}:`);
    }
    const id = newId();
    const { rel, mime } = await saveImage(file, `emojis/${id}`, 16 * 1024 * 1024);
    run(
      'INSERT INTO emojis (id, name, path, animated, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      name,
      rel,
      mime === 'image/gif',
      me.id,
      now(),
    );
    const emoji = emojiOut(get<EmojiRow>('SELECT * FROM emojis WHERE id = ?', id)!);
    emitAll('emoji:create', emoji);
    return emoji;
  });

  app.patch('/api/emojis/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const emoji = get<EmojiRow>('SELECT * FROM emojis WHERE id = ?', id);
    if (!emoji) throw notFound('That emoji was deleted');
    if (emoji.creator_id !== me.id && !me.is_admin) throw forbidden('Only the person who added it can rename it');
    const { name } = parse(z.object({ name: EmojiName }), req.body);
    const clash = get<{ id: string }>('SELECT id FROM emojis WHERE name = ?', name);
    if (clash && clash.id !== id) throw badRequest(`There's already an emoji called :${name}:`);
    run('UPDATE emojis SET name = ? WHERE id = ?', name, id);
    const out = emojiOut(get<EmojiRow>('SELECT * FROM emojis WHERE id = ?', id)!);
    emitAll('emoji:update', out);
    return out;
  });

  app.delete('/api/emojis/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const emoji = get<EmojiRow>('SELECT * FROM emojis WHERE id = ?', id);
    if (!emoji) return { ok: true };
    if (emoji.creator_id !== me.id && !me.is_admin) throw forbidden('Only the person who added it can delete it');
    removeFile(emoji.path);
    run('DELETE FROM emojis WHERE id = ?', id);
    emitAll('emoji:delete', { id });
    return { ok: true };
  });
}
