import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { endCall } from '../calls.ts';
import { config } from '../config.ts';
import { all, get, qs, run, tx } from '../lib/db.ts';
import { guessMime, removeDir, safeFilename } from '../lib/files.ts';
import { activeUserStorage, presignUpload, storedSize } from '../lib/storage.ts';
import {
  type AttachmentRow,
  type ChannelRow,
  type Embed,
  type MessageRow,
  type UserRow,
  REL,
  attachmentOut,
  channelMembers,
  channelOut,
  dmOut,
  dmRecipientId,
  getChannel,
  getUser,
  groupMemberIds,
  hydrateMessages,
  isBlockedEither,
  relationship,
  requireChannel,
  requireMember,
  sharesGroup,
} from '../lib/model.ts';
import { PERM, hasPerm, membersWithRoles, requirePerm, rolesOf } from '../lib/perms.ts';
import { HttpError, ID_RE, badRequest, forbidden, newId, notFound, now, parse } from '../lib/util.ts';
import { sendPush } from '../push.ts';
import { maxUploadBytes } from '../lib/settings.ts';
import { emitTo, isActive, isDnd } from '../realtime.ts';

const MENTION_RE = /<@([0-9A-HJKMNP-TV-Z]{26})>/g;
const ROLE_MENTION_RE = /<@&([0-9A-HJKMNP-TV-Z]{26})>/g;

const klipyUrl = z
  .string()
  .max(2000)
  .refine((value) => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && (u.hostname === 'klipy.com' || u.hostname.endsWith('.klipy.com'));
    } catch {
      return false;
    }
  }, 'Unsupported media link');

export const EmbedSchema = z.object({
  kind: z.literal('klipy'),
  type: z.enum(['gif', 'sticker']),
  slug: z.string().max(300),
  title: z.string().max(300).default(''),
  url: klipyUrl,
  mp4: klipyUrl.nullable().default(null),
  webp: klipyUrl.nullable().default(null),
  preview: klipyUrl.nullable().default(null),
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
});

const MessageSchema = z.object({
  content: z.string().max(8000, 'That message is too long (8000 characters max)').default(''),
  replyToId: z.string().regex(ID_RE).nullish(),
  attachmentIds: z.array(z.string().regex(ID_RE)).max(20).default([]),
  embeds: z.array(EmbedSchema).max(4).default([]),
  nonce: z.string().max(64).optional(),
  replyPing: z.boolean().default(true),
});

export function channelName(raw: string) {
  return (
    raw
      .trim()
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}_-]+/gu, '')
      .replace(/-{2,}/g, '-')
      .slice(0, 48) || 'channel'
  );
}

function isEmoji(value: string): boolean {
  if (value.startsWith('c:')) return Boolean(get('SELECT 1 FROM emojis WHERE id = ?', value.slice(2)));
  if (value.length === 0 || value.length > 40 || /[a-zA-Z<>\s]/.test(value)) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u.test(value);
}

function previewText(m: { content: string; attachments: unknown[]; embeds: Embed[] }, names: Map<string, string>) {
  let text = m.content.replace(MENTION_RE, (_, id: string) => `@${names.get(id) ?? 'someone'}`);
  text = text.replace(/<a?:([a-zA-Z0-9_]+):[0-9A-Z]{26}>/g, ':$1:');
  if (!text.trim()) {
    if (m.embeds.length) text = m.embeds[0].type === 'sticker' ? 'Sent a sticker' : 'Sent a GIF';
    else if (m.attachments.length) text = m.attachments.length > 1 ? `Sent ${m.attachments.length} files` : 'Sent a file';
  }
  return text.length > 180 ? text.slice(0, 177) + '…' : text;
}

/** Creates a message and fans it out. Used by the REST route and by system messages. */
export function createMessage(opts: {
  channel: ChannelRow;
  author: UserRow;
  type?: string;
  content?: string;
  replyToId?: string | null;
  attachments?: AttachmentRow[];
  embeds?: Embed[];
  nonce?: string;
  mentions?: string[];
  everyone?: boolean;
  /** System notices: no unread mention badge for the other person. */
  silent?: boolean;
}) {
  const { channel, author } = opts;
  const id = newId();
  const created = now();
  const members = channelMembers(channel);
  const memberSet = new Set(members);
  const mentioned = new Set((opts.mentions ?? []).filter((uid) => uid !== author.id && memberSet.has(uid)));
  if (opts.everyone) for (const uid of members) if (uid !== author.id) mentioned.add(uid);
  if (channel.type === 'dm' && !opts.silent) for (const uid of members) if (uid !== author.id) mentioned.add(uid);

  const reopened: string[] = [];
  tx(() => {
    run(
      `INSERT INTO messages (id, channel_id, author_id, type, content, reply_to_id, embeds, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      channel.id,
      author.id,
      opts.type ?? 'default',
      opts.content ?? '',
      opts.replyToId ?? null,
      opts.embeds?.length ? JSON.stringify(opts.embeds) : null,
      created,
    );
    for (const a of opts.attachments ?? []) run('UPDATE attachments SET message_id = ? WHERE id = ?', id, a.id);
    run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, channel.id);
    run(
      `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_id = excluded.last_read_id, mention_count = 0`,
      author.id,
      channel.id,
      id,
    );
    for (const uid of mentioned) {
      run(
        `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, NULL, 1)
         ON CONFLICT(user_id, channel_id) DO UPDATE SET mention_count = mention_count + 1`,
        uid,
        channel.id,
      );
    }
    if (channel.type === 'dm') {
      for (const row of all<{ user_id: string }>('SELECT user_id FROM dm_members WHERE channel_id = ? AND open = 0', channel.id)) {
        reopened.push(row.user_id);
      }
      if (reopened.length) run('UPDATE dm_members SET open = 1 WHERE channel_id = ?', channel.id);
    }
  });

  for (const uid of reopened) emitTo([uid], 'dm:open', dmOut(getChannel(channel.id)!, uid));

  const row = get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)!;
  const message = { ...hydrateMessages([row], author.id)[0], reactions: [], nonce: opts.nonce };
  emitTo(members, 'message:create', message);

  // Web push for people who aren't looking at RanchCord right now.
  const targets = [...mentioned].filter((uid) => !isActive(uid) && !isDnd(uid));
  if (targets.length && message.type === 'default') {
    const names = new Map<string, string>();
    for (const uid of opts.mentions ?? []) {
      const u = getUser(uid);
      if (u) names.set(uid, u.display_name);
    }
    let title = author.display_name;
    let url = `/#/channels/@me/${channel.id}`;
    if (channel.type !== 'dm') {
      const group = get<{ name: string }>('SELECT name FROM groups WHERE id = ?', channel.group_id);
      title = `${author.display_name} in #${channel.name} (${group?.name ?? 'group'})`;
      url = `/#/channels/${channel.group_id}/${channel.id}`;
    }
    void sendPush(targets, {
      title,
      body: previewText(message, names),
      icon: author.avatar,
      tag: channel.id,
      url,
    });
  }
  return message;
}

function deleteAttachmentFiles(messageIds: string[]) {
  if (!messageIds.length) return;
  const rows = all<{ id: string; storage_id: string | null }>(
    `SELECT id, storage_id FROM attachments WHERE message_id IN (${qs(messageIds.length)})`,
    ...messageIds,
  );
  for (const r of rows) removeDir(`attachments/${r.id}`, r.storage_id);
}

export function deleteChannelFiles(channelIds: string[]) {
  if (!channelIds.length) return;
  const rows = all<{ id: string; storage_id: string | null }>(
    `SELECT a.id, a.storage_id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.channel_id IN (${qs(channelIds.length)})`,
    ...channelIds,
  );
  for (const r of rows) removeDir(`attachments/${r.id}`, r.storage_id);
}

export default async function channelRoutes(app: FastifyInstance) {
  /* ---------- DMs ---------- */

  app.post('/api/dms', async (req) => {
    const me = auth(req);
    const { userId } = parse(z.object({ userId: z.string().regex(ID_RE) }), req.body);
    const target = getUser(userId);
    if (!target || target.id === me.id) throw notFound('That user no longer exists');
    if (isBlockedEither(me.id, target.id)) throw forbidden("You can't message this person");
    if (relationship(me.id, target.id) !== REL.FRIEND && !sharesGroup(me.id, target.id)) {
      throw forbidden('You can message friends and people in your groups');
    }
    let channel = get<ChannelRow>(
      `SELECT c.* FROM channels c
         JOIN dm_members a ON a.channel_id = c.id AND a.user_id = ?
         JOIN dm_members b ON b.channel_id = c.id AND b.user_id = ?
        WHERE c.type = 'dm' LIMIT 1`,
      me.id,
      target.id,
    );
    if (channel) {
      run('UPDATE dm_members SET open = 1 WHERE channel_id = ? AND user_id = ?', channel.id, me.id);
    } else {
      const id = newId();
      tx(() => {
        run('INSERT INTO channels (id, type, created_at) VALUES (?, ?, ?)', id, 'dm', now());
        run('INSERT INTO dm_members (channel_id, user_id, open) VALUES (?, ?, 1)', id, me.id);
        run('INSERT INTO dm_members (channel_id, user_id, open) VALUES (?, ?, 0)', id, target.id);
      });
      channel = getChannel(id)!;
    }
    const dm = dmOut(channel, me.id);
    emitTo([me.id], 'dm:open', dm);
    return dm;
  });

  app.delete('/api/dms/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const { channel } = requireChannel(me.id, id);
    if (channel.type !== 'dm') throw badRequest('Not a DM');
    run('UPDATE dm_members SET open = 0 WHERE channel_id = ? AND user_id = ?', id, me.id);
    emitTo([me.id], 'dm:close', { id });
    return { ok: true };
  });

  /* ---------- messages ---------- */

  app.get('/api/channels/:id/messages', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requireChannel(me.id, id);
    const q = parse(
      z.object({
        before: z.string().regex(ID_RE).optional(),
        after: z.string().regex(ID_RE).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    let rows: MessageRow[];
    if (q.before) {
      rows = all<MessageRow>(
        'SELECT * FROM messages WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?',
        id,
        q.before,
        q.limit,
      ).reverse();
    } else if (q.after) {
      rows = all<MessageRow>('SELECT * FROM messages WHERE channel_id = ? AND id > ? ORDER BY id ASC LIMIT ?', id, q.after, q.limit);
    } else {
      rows = all<MessageRow>('SELECT * FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT ?', id, q.limit).reverse();
    }
    return hydrateMessages(rows, me.id);
  });

  app.post('/api/channels/:id/messages', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const { channel, member } = requireChannel(me.id, id);
    if (channel.type === 'voice') throw badRequest("Voice channels don't have a text chat");
    const body = parse(MessageSchema, req.body);
    if (member) {
      requirePerm(member, PERM.SEND_MESSAGES, "You don't have permission to send messages here");
      if (body.attachmentIds.length) requirePerm(member, PERM.ATTACH_FILES, "You don't have permission to upload files here");
    }

    if (channel.type === 'dm') {
      const other = dmRecipientId(channel.id, me.id);
      if (other && isBlockedEither(me.id, other)) throw forbidden("You can't message this person right now");
    }

    const content = body.content.replace(/\r\n/g, '\n').trim();
    const attachments = body.attachmentIds.length
      ? all<AttachmentRow>(
          `SELECT * FROM attachments WHERE id IN (${qs(body.attachmentIds.length)}) AND uploader_id = ? AND message_id IS NULL AND pending = 0`,
          ...body.attachmentIds,
          me.id,
        )
      : [];
    if (attachments.length !== body.attachmentIds.length) {
      throw badRequest('Some of your files are missing. Try attaching them again.');
    }
    if (!content && !attachments.length && !body.embeds.length) throw badRequest("You can't send an empty message");

    let replyToId: string | null = null;
    const mentions = [...content.matchAll(MENTION_RE)].map((m) => m[1]);
    if (body.replyToId) {
      const ref = get<{ id: string; author_id: string }>(
        'SELECT id, author_id FROM messages WHERE id = ? AND channel_id = ?',
        body.replyToId,
        channel.id,
      );
      if (ref) {
        replyToId = ref.id;
        if (body.replyPing) mentions.push(ref.author_id);
      }
    }

    const canPingAll = Boolean(member && hasPerm(member, PERM.MENTION_EVERYONE));
    if (member) {
      const roleIds = [...content.matchAll(ROLE_MENTION_RE)].map((m) => m[1]);
      if (roleIds.length) {
        const roles = rolesOf(channel.group_id!).filter((r) => roleIds.includes(r.id) && (r.mentionable || canPingAll));
        mentions.push(...membersWithRoles(channel.group_id!, roles.map((r) => r.id)));
      }
    }

    return createMessage({
      channel,
      author: me,
      content,
      replyToId,
      attachments,
      embeds: body.embeds as Embed[],
      nonce: body.nonce,
      mentions,
      everyone: channel.type !== 'dm' && canPingAll && /(^|\s)@(everyone|here)\b/.test(content),
    });
  });

  app.patch('/api/channels/:id/messages/:messageId', async (req) => {
    const me = auth(req);
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { channel } = requireChannel(me.id, id);
    const msg = get<MessageRow>('SELECT * FROM messages WHERE id = ? AND channel_id = ?', messageId, id);
    if (!msg) throw notFound('That message was deleted');
    if (msg.author_id !== me.id) throw forbidden('You can only edit your own messages');
    const { content } = parse(z.object({ content: z.string().max(8000) }), req.body);
    const text = content.replace(/\r\n/g, '\n').trim();
    const hasOther = msg.embeds || get('SELECT 1 FROM attachments WHERE message_id = ?', msg.id);
    if (!text && !hasOther) throw badRequest('Use delete to remove a message completely');
    const editedAt = now();
    run('UPDATE messages SET content = ?, edited_at = ? WHERE id = ?', text, editedAt, msg.id);
    const update = { id: msg.id, channelId: id, content: text, editedAt };
    emitTo(channelMembers(channel), 'message:update', update);
    return update;
  });

  app.delete('/api/channels/:id/messages/:messageId', async (req) => {
    const me = auth(req);
    const { id, messageId } = req.params as { id: string; messageId: string };
    const { channel, member } = requireChannel(me.id, id);
    const msg = get<MessageRow>('SELECT * FROM messages WHERE id = ? AND channel_id = ?', messageId, id);
    if (!msg) return { ok: true };
    if (msg.author_id !== me.id && !hasPerm(member, PERM.MANAGE_MESSAGES)) throw forbidden('You can only delete your own messages');
    deleteAttachmentFiles([msg.id]);
    tx(() => {
      run('DELETE FROM messages WHERE id = ?', msg.id);
      if (channel.last_message_id === msg.id) {
        const prev = get<{ id: string }>('SELECT id FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1', id);
        run('UPDATE channels SET last_message_id = ? WHERE id = ?', prev?.id ?? null, id);
      }
    });
    emitTo(channelMembers(channel), 'message:delete', { id: msg.id, channelId: id });
    return { ok: true };
  });

  // Wipes a whole DM, for both people: every message, reaction and file (from their own storage too).
  app.post('/api/channels/:id/nuke', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const { channel } = requireChannel(me.id, id);
    if (channel.type !== 'dm') throw badRequest('Only DMs can be nuked');
    const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ?', id)!.n;
    deleteChannelFiles([id]);
    tx(() => {
      run('DELETE FROM messages WHERE channel_id = ?', id);
      run('UPDATE channels SET last_message_id = NULL WHERE id = ?', id);
      run('UPDATE read_states SET last_read_id = NULL, mention_count = 0 WHERE channel_id = ?', id);
    });
    emitTo(channelMembers(channel), 'channel:nuked', { channelId: id, by: me.id });
    // A small notice so the other person knows what happened to the chat.
    createMessage({ channel: getChannel(id)!, author: getUser(me.id)!, type: 'nuke', silent: true });
    return { ok: true, deleted: count };
  });

  /* ---------- reactions ---------- */

  const reactionRoute = '/api/channels/:id/messages/:messageId/reactions/:emoji';

  app.put(reactionRoute, async (req) => {
    const me = auth(req);
    const { id, messageId, emoji } = req.params as { id: string; messageId: string; emoji: string };
    const { channel } = requireChannel(me.id, id);
    if (!get('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?', messageId, id)) throw notFound('That message was deleted');
    if (!isEmoji(emoji)) throw badRequest("That emoji can't be used as a reaction");
    const res = run(
      'INSERT OR IGNORE INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      messageId,
      me.id,
      emoji,
      now(),
    );
    if (Number(res.changes) > 0) {
      emitTo(channelMembers(channel), 'reaction:add', { channelId: id, messageId, userId: me.id, emoji });
    }
    return { ok: true };
  });

  app.delete(reactionRoute, async (req) => {
    const me = auth(req);
    const { id, messageId, emoji } = req.params as { id: string; messageId: string; emoji: string };
    const { channel } = requireChannel(me.id, id);
    const res = run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', messageId, me.id, emoji);
    if (Number(res.changes) > 0) {
      emitTo(channelMembers(channel), 'reaction:remove', { channelId: id, messageId, userId: me.id, emoji });
    }
    return { ok: true };
  });

  /* ---------- read state ---------- */

  app.post('/api/channels/:id/ack', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requireChannel(me.id, id);
    const { messageId } = parse(z.object({ messageId: z.string().regex(ID_RE) }), req.body);
    run(
      `INSERT INTO read_states (user_id, channel_id, last_read_id, mention_count) VALUES (?, ?, ?, 0)
       ON CONFLICT(user_id, channel_id) DO UPDATE SET
         last_read_id = CASE WHEN read_states.last_read_id IS NULL OR excluded.last_read_id > read_states.last_read_id
                             THEN excluded.last_read_id ELSE read_states.last_read_id END,
         mention_count = 0`,
      me.id,
      id,
      messageId,
    );
    const state = get<{ last_read_id: string | null }>(
      'SELECT last_read_id FROM read_states WHERE user_id = ? AND channel_id = ?',
      me.id,
      id,
    );
    emitTo([me.id], 'readstate:update', { channelId: id, lastReadId: state?.last_read_id ?? messageId, mentionCount: 0 });
    return { ok: true };
  });

  /* ---------- group channels ---------- */

  app.post('/api/groups/:groupId/channels', async (req) => {
    const me = auth(req);
    const { groupId } = req.params as { groupId: string };
    requirePerm(requireMember(me.id, groupId), PERM.MANAGE_CHANNELS, 'You need the Manage Channels permission');
    const body = parse(
      z.object({ name: z.string().trim().min(1, 'Give the channel a name').max(48), type: z.enum(['text', 'voice']).default('text') }),
      req.body,
    );
    const name = body.type === 'text' ? channelName(body.name) : body.name.trim().slice(0, 48);
    const position = (get<{ p: number | null }>('SELECT MAX(position) AS p FROM channels WHERE group_id = ?', groupId)?.p ?? 0) + 1;
    const id = newId();
    run(
      'INSERT INTO channels (id, type, group_id, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      body.type,
      groupId,
      name,
      position,
      now(),
    );
    const out = channelOut(getChannel(id)!);
    emitTo(groupMemberIds(groupId), 'channel:create', out);
    return out;
  });

  app.patch('/api/channels/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const { channel, member } = requireChannel(me.id, id);
    if (channel.type === 'dm') throw badRequest("DMs can't be renamed");
    requirePerm(member, PERM.MANAGE_CHANNELS, 'You need the Manage Channels permission');
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(48).optional(), topic: z.string().trim().max(300).optional() }),
      req.body,
    );
    if (body.name !== undefined) {
      run('UPDATE channels SET name = ? WHERE id = ?', channel.type === 'text' ? channelName(body.name) : body.name, id);
    }
    if (body.topic !== undefined) run('UPDATE channels SET topic = ? WHERE id = ?', body.topic, id);
    const out = channelOut(getChannel(id)!);
    emitTo(groupMemberIds(channel.group_id!), 'channel:update', out);
    return out;
  });

  app.delete('/api/channels/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const { channel, member } = requireChannel(me.id, id);
    if (channel.type === 'dm') throw badRequest('Use close to hide a DM');
    requirePerm(member, PERM.MANAGE_CHANNELS, 'You need the Manage Channels permission');
    const textCount = get<{ n: number }>("SELECT COUNT(*) AS n FROM channels WHERE group_id = ? AND type = 'text'", channel.group_id)!.n;
    if (channel.type === 'text' && textCount <= 1) throw badRequest('A group needs at least one text channel');
    const members = groupMemberIds(channel.group_id!);
    endCall(id, 'channel_deleted');
    deleteChannelFiles([id]);
    run('DELETE FROM channels WHERE id = ?', id);
    emitTo(members, 'channel:delete', { id, groupId: channel.group_id });
    return { ok: true };
  });

  /* ---------- uploads ---------- */

  // Files go straight from the sender's device into their own storage: the server only signs a
  // one-time upload link and checks the file arrived.
  app.post('/api/uploads', async (req) => {
    const me = auth(req);
    if (req.isMultipart()) throw badRequest('Update the app to send files', 'update_required');
    const body = parse(UploadStart, req.body);
    const storage = activeUserStorage(me.id);
    if (!storage) throw new HttpError(403, 'Link your own storage in Settings → My Storage to send files', 'storage_required');
    const limit = maxUploadBytes();
    if (body.size > limit) {
      throw new HttpError(413, `That file is too big (the limit on this server is ${Math.round(limit / 1024 / 1024)} MB)`, 'too_large');
    }
    const id = newId();
    const filename = safeFilename(body.filename);
    const rel = `attachments/${id}/${filename}`;
    const contentType = guessMime(filename, body.contentType);
    run(
      `INSERT INTO attachments (id, uploader_id, filename, path, content_type, size, width, height, storage_id, pending, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      id,
      me.id,
      filename,
      rel,
      contentType,
      body.size,
      body.width ?? null,
      body.height ?? null,
      storage.id,
      now(),
    );
    const upload = await presignUpload(storage.id, rel, { contentType, size: body.size, filename });
    return { attachment: attachmentOut(get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id)!), upload };
  });

  app.post('/api/uploads/:id/finish', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const row = get<AttachmentRow>('SELECT * FROM attachments WHERE id = ? AND uploader_id = ?', id, me.id);
    if (!row) throw notFound('That upload was cancelled');
    if (row.pending && row.storage_id) {
      const size = await storedSize(row.storage_id, row.path);
      if (size === null) throw badRequest("The file didn't finish uploading. Try again.", 'upload_incomplete');
      if (size !== row.size) {
        removeDir(`attachments/${row.id}`, row.storage_id);
        run('DELETE FROM attachments WHERE id = ?', id);
        throw badRequest('That upload got mixed up. Try sending it again.');
      }
      run('UPDATE attachments SET pending = 0 WHERE id = ?', id);
    }
    return attachmentOut(get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id)!);
  });
}

const UploadStart = z.object({
  filename: z.string().trim().min(1).max(300),
  size: z.number().int().min(0),
  contentType: z.string().max(200).default(''),
  width: z.number().int().min(1).max(100000).nullish(),
  height: z.number().int().min(1).max(100000).nullish(),
});

/** Removes uploads that were never attached to a message (e.g. the user cancelled). */
export function cleanupOrphanUploads() {
  const cutoff = now() - 24 * 60 * 60 * 1000;
  const rows = all<{ id: string; storage_id: string | null }>('SELECT id, storage_id FROM attachments WHERE message_id IS NULL AND created_at < ?', cutoff);
  for (const r of rows) removeDir(`attachments/${r.id}`, r.storage_id);
  if (rows.length) run('DELETE FROM attachments WHERE message_id IS NULL AND created_at < ?', cutoff);
}
