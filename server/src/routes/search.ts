import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { all, qs } from '../lib/db.ts';
import { type MessageRow, hydrateMessages, requireChannel, requireMember } from '../lib/model.ts';
import { ID_RE, parse } from '../lib/util.ts';

/** Every text chat this person can read: their DMs and the text channels of their groups. */
function readableChannelIds(userId: string): string[] {
  const dms = all<{ channel_id: string }>('SELECT channel_id FROM dm_members WHERE user_id = ?', userId).map((r) => r.channel_id);
  const groupChannels = all<{ id: string }>(
    `SELECT c.id FROM channels c JOIN group_members gm ON gm.group_id = c.group_id
      WHERE gm.user_id = ? AND c.type = 'text'`,
    userId,
  ).map((r) => r.id);
  return [...dms, ...groupChannels];
}

/** Message search: words in a chat, a group, or everywhere you can read. */
export default async function searchRoutes(app: FastifyInstance) {
  app.get('/api/search', async (req) => {
    const me = auth(req);
    const q = parse(
      z.object({
        q: z.string().trim().max(200).default(''),
        channelId: z.string().regex(ID_RE).optional(),
        groupId: z.string().regex(ID_RE).optional(),
        from: z.string().regex(ID_RE).optional(),
        before: z.string().regex(ID_RE).optional(),
        limit: z.coerce.number().int().min(1).max(50).default(25),
      }),
      req.query,
    );
    if (!q.q && !q.from) return { messages: [], hasMore: false };

    let channels: string[];
    if (q.channelId) {
      requireChannel(me.id, q.channelId);
      channels = [q.channelId];
    } else if (q.groupId) {
      requireMember(me.id, q.groupId);
      channels = all<{ id: string }>("SELECT id FROM channels WHERE group_id = ? AND type = 'text'", q.groupId).map((r) => r.id);
    } else {
      channels = readableChannelIds(me.id);
    }
    if (!channels.length) return { messages: [], hasMore: false };

    const where = [`channel_id IN (${qs(channels.length)})`, "type = 'default'"];
    const args: (string | number)[] = [...channels];
    for (const word of q.q.split(/\s+/).filter(Boolean).slice(0, 8)) {
      // Every word has to appear; % and _ in what people typed are searched for literally.
      where.push("content LIKE ? ESCAPE '\\'");
      args.push(`%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    if (q.from) (where.push('author_id = ?'), args.push(q.from));
    if (q.before) (where.push('id < ?'), args.push(q.before));
    const rows = all<MessageRow>(`SELECT * FROM messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...args, q.limit + 1);
    return { messages: hydrateMessages(rows.slice(0, q.limit), me.id), hasMore: rows.length > q.limit };
  });
}
