import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { get, run } from '../lib/db.ts';
import { removeFile, saveImage } from '../lib/files.ts';
import { type StickerRow, stickerOut } from '../lib/model.ts';
import { badRequest, forbidden, newId, notFound, now, parse } from '../lib/util.ts';
import { emitAll } from '../realtime.ts';

const StickerName = z.string().trim().min(1, 'Give the sticker a name').max(32, 'Sticker names are 32 characters at most');

/** Animated stickers are kept as they are, so they need a size cap. */
const MAX_BYTES = 4 * 1024 * 1024;

/** Stickers people upload are shared by everyone on the server, like photo emojis. */
export default async function stickerRoutes(app: FastifyInstance) {
  app.post('/api/stickers', async (req) => {
    const me = auth(req);
    const file = await req.file();
    if (!file) throw badRequest('Pick a picture first');
    const parsed = StickerName.safeParse((file.fields.name as { value?: unknown } | undefined)?.value);
    if (!parsed.success) {
      file.file.resume();
      throw badRequest(parsed.error.issues[0]?.message ?? 'Give the sticker a name');
    }
    const id = newId();
    const { rel, width, height } = await saveImage(file, `stickers/${id}`, MAX_BYTES);
    run(
      'INSERT INTO stickers (id, name, path, width, height, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      parsed.data,
      rel,
      width,
      height,
      me.id,
      now(),
    );
    const sticker = stickerOut(get<StickerRow>('SELECT * FROM stickers WHERE id = ?', id)!);
    emitAll('sticker:create', sticker);
    return sticker;
  });

  app.patch('/api/stickers/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const sticker = get<StickerRow>('SELECT * FROM stickers WHERE id = ?', id);
    if (!sticker) throw notFound('That sticker was deleted');
    if (sticker.creator_id !== me.id && !me.is_admin) throw forbidden('Only the person who added it can rename it');
    const { name } = parse(z.object({ name: StickerName }), req.body);
    run('UPDATE stickers SET name = ? WHERE id = ?', name, id);
    const out = stickerOut(get<StickerRow>('SELECT * FROM stickers WHERE id = ?', id)!);
    emitAll('sticker:update', out);
    return out;
  });

  app.delete('/api/stickers/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const sticker = get<StickerRow>('SELECT * FROM stickers WHERE id = ?', id);
    if (!sticker) return { ok: true };
    if (sticker.creator_id !== me.id && !me.is_admin) throw forbidden('Only the person who added it can delete it');
    removeFile(sticker.path);
    run('DELETE FROM stickers WHERE id = ?', id);
    emitAll('sticker:delete', { id });
    return { ok: true };
  });
}
