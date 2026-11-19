import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth, bearerToken } from '../auth.ts';
import { ringsFor, voiceStatesFor } from '../calls.ts';
import { all, get, qs, run } from '../lib/db.ts';
import { removeFile, saveImage } from '../lib/files.ts';
import {
  type ChannelRow,
  type EmojiRow,
  type PublicUser,
  type UserRow,
  dmOut,
  emojiOut,
  type StickerRow,
  stickerOut,
  getGroup,
  getUser,
  groupOut,
  publicUser,
  relatedUserIds,
  requireChannel,
  requireMember,
  selfUser,
} from '../lib/model.ts';
import {
  HttpError,
  ID_RE,
  badRequest,
  hashPassword,
  notFound,
  now,
  parse,
  randomCode,
  sha256,
  verifyPassword,
} from '../lib/util.ts';
import { disconnectUserExcept, emitTo, presencesFor, refreshPresence, setChosenStatus } from '../realtime.ts';
import { Password, Username, instanceInfo, uniqueFriendCode } from './auth.ts';
import { allSounds } from './sounds.ts';
import { EmbedSchema } from './channels.ts';
import { myStorageStatus } from './mystorage.ts';

export function broadcastUser(userId: string) {
  const user = getUser(userId);
  if (!user) return;
  emitTo(relatedUserIds(userId), 'user:update', publicUser(user));
  emitTo([userId], 'self:update', selfUser(user));
}

/** Someone's muted DMs, channels and groups (ones that have run out are cleared away). */
function mutesOf(userId: string) {
  run('DELETE FROM mutes WHERE user_id = ? AND until IS NOT NULL AND until <= ?', userId, now());
  return all<{ target_id: string; until: number | null }>('SELECT target_id, until FROM mutes WHERE user_id = ?', userId).map((r) => ({
    targetId: r.target_id,
    until: r.until,
  }));
}

export default async function userRoutes(app: FastifyInstance) {
  app.get('/api/bootstrap', async (req) => {
    const me = auth(req);

    const relationships = all<{ target_id: string; type: number; created_at: number }>(
      'SELECT target_id, type, created_at FROM relationships WHERE user_id = ?',
      me.id,
    );
    const dmChannels = all<ChannelRow>(
      `SELECT c.* FROM channels c JOIN dm_members dm ON dm.channel_id = c.id
        WHERE dm.user_id = ? AND dm.open = 1`,
      me.id,
    );
    const groupIds = all<{ group_id: string }>(
      'SELECT group_id FROM group_members WHERE user_id = ? ORDER BY joined_at',
      me.id,
    );

    const users = new Map<string, PublicUser>();
    users.set(me.id, publicUser(me));
    if (relationships.length) {
      const ids = relationships.map((r) => r.target_id);
      for (const u of all<UserRow>(`SELECT * FROM users WHERE id IN (${qs(ids.length)})`, ...ids)) {
        users.set(u.id, publicUser(u));
      }
    }
    const dms = dmChannels.map((c) => {
      const { recipient, ...dm } = dmOut(c, me.id);
      if (recipient) users.set(recipient.id, recipient);
      return dm;
    });
    const groups = groupIds.flatMap(({ group_id }) => {
      const g = groupOut(group_id);
      if (!g) return [];
      const { users: members, ...rest } = g;
      for (const u of members) users.set(u.id, u);
      return [rest];
    });

    const readStates = all<{ channel_id: string; last_read_id: string | null; mention_count: number }>(
      'SELECT channel_id, last_read_id, mention_count FROM read_states WHERE user_id = ?',
      me.id,
    );
    const emojis = all<EmojiRow>('SELECT * FROM emojis ORDER BY name COLLATE NOCASE').map(emojiOut);
    const stickers = all<StickerRow>('SELECT * FROM stickers ORDER BY created_at DESC').map(stickerOut);

    return {
      user: selfUser(me),
      users: [...users.values()],
      relationships: relationships.map((r) => ({ userId: r.target_id, type: r.type, since: r.created_at })),
      dms,
      groups,
      readStates: readStates.map((r) => ({
        channelId: r.channel_id,
        lastReadId: r.last_read_id,
        mentionCount: r.mention_count,
      })),
      emojis,
      stickers,
      sounds: allSounds(),
      myStorage: myStorageStatus(me.id),
      favorites: all<{ embed: string }>('SELECT embed FROM gif_favorites WHERE user_id = ? ORDER BY created_at DESC', me.id).map((r) =>
        JSON.parse(r.embed),
      ),
      mutes: mutesOf(me.id),
      presences: presencesFor(users.keys()),
      voiceStates: voiceStatesFor(me.id),
      rings: ringsFor(me.id),
      instance: instanceInfo(),
    };
  });

  app.get('/api/users/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const user = getUser(id);
    if (!user) throw notFound('That user no longer exists');
    const mutualFriends = all<{ id: string }>(
      `SELECT a.target_id AS id FROM relationships a JOIN relationships b ON a.target_id = b.target_id
        WHERE a.user_id = ? AND b.user_id = ? AND a.type = 1 AND b.type = 1`,
      me.id,
      id,
    ).map((r) => r.id);
    const mutualGroups = all<{ group_id: string }>(
      `SELECT x.group_id FROM group_members x JOIN group_members y ON x.group_id = y.group_id
        WHERE x.user_id = ? AND y.user_id = ?`,
      me.id,
      id,
    ).map((r) => r.group_id);
    return { user: publicUser(user), mutualFriends, mutualGroups };
  });

  app.patch('/api/users/@me', async (req) => {
    const me = auth(req);
    const body = parse(
      z.object({
        displayName: z.string().trim().min(1, 'Display name cannot be empty').max(32).optional(),
        username: Username.optional(),
        bio: z.string().max(400).optional(),
        customStatus: z.string().trim().max(80).optional(),
        bannerColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .optional(),
        accentColor: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .nullable()
          .optional(),
        status: z.enum(['online', 'idle', 'dnd', 'invisible']).optional(),
        background: z
          .string()
          .regex(/^preset:[a-z0-9-]{1,32}$/)
          .nullable()
          .optional(),
      }),
      req.body,
    );
    if (body.username && body.username !== me.username) {
      const taken = get<{ id: string }>('SELECT id FROM users WHERE username = ?', body.username);
      if (taken && taken.id !== me.id) throw badRequest('That username is already taken', 'username_taken');
    }
    const sets: string[] = [];
    const values: (string | number)[] = [];
    const col = (name: string, value: string | undefined) => {
      if (value === undefined) return;
      sets.push(`${name} = ?`);
      values.push(value);
    };
    col('display_name', body.displayName);
    col('username', body.username);
    col('bio', body.bio);
    col('custom_status', body.customStatus);
    col('banner_color', body.bannerColor);
    col('status', body.status);
    if (body.background !== undefined) {
      if (me.background?.startsWith('/files/')) removeFile(me.background.replace(/^\/files\//, ''));
      sets.push('background = ?');
      values.push(body.background ?? '');
    }
    if (body.accentColor !== undefined) {
      sets.push('accent_color = ?');
      values.push(body.accentColor ?? '');
    }
    if (sets.length) run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...values, me.id);
    if (body.status) {
      setChosenStatus(me.id, body.status);
      refreshPresence(me.id);
    }
    broadcastUser(me.id);
    return selfUser(getUser(me.id)!);
  });

  app.post('/api/users/@me/avatar', async (req) => {
    const me = auth(req);
    const file = await req.file();
    if (!file) throw badRequest('Pick an image first');
    const { rel } = await saveImage(file, `avatars/${me.id}-${randomCode(6).toLowerCase()}`, 16 * 1024 * 1024);
    removeFile(me.avatar?.replace(/^\/files\//, ''));
    run('UPDATE users SET avatar = ? WHERE id = ?', `/files/${rel}`, me.id);
    broadcastUser(me.id);
    return selfUser(getUser(me.id)!);
  });

  app.delete('/api/users/@me/avatar', async (req) => {
    const me = auth(req);
    removeFile(me.avatar?.replace(/^\/files\//, ''));
    run('UPDATE users SET avatar = NULL WHERE id = ?', me.id);
    broadcastUser(me.id);
    return selfUser(getUser(me.id)!);
  });

  app.post('/api/users/@me/banner', async (req) => {
    const me = auth(req);
    const file = await req.file();
    if (!file) throw badRequest('Pick an image first');
    const { rel } = await saveImage(file, `avatars/${me.id}-banner-${randomCode(6).toLowerCase()}`, 24 * 1024 * 1024);
    removeFile(me.banner?.replace(/^\/files\//, ''));
    run('UPDATE users SET banner = ? WHERE id = ?', `/files/${rel}`, me.id);
    broadcastUser(me.id);
    return selfUser(getUser(me.id)!);
  });

  app.delete('/api/users/@me/banner', async (req) => {
    const me = auth(req);
    removeFile(me.banner?.replace(/^\/files\//, ''));
    run('UPDATE users SET banner = NULL WHERE id = ?', me.id);
    broadcastUser(me.id);
    return selfUser(getUser(me.id)!);
  });

  app.post('/api/users/@me/background', async (req) => {
    const me = auth(req);
    const file = await req.file({ limits: { fileSize: 32 * 1024 * 1024 } });
    if (!file) throw badRequest('Pick an image first');
    const { rel } = await saveImage(file, `avatars/${me.id}-bg-${randomCode(6).toLowerCase()}`, 32 * 1024 * 1024);
    if (me.background?.startsWith('/files/')) removeFile(me.background.replace(/^\/files\//, ''));
    run('UPDATE users SET background = ? WHERE id = ?', `/files/${rel}`, me.id);
    emitTo([me.id], 'self:update', selfUser(getUser(me.id)!));
    return selfUser(getUser(me.id)!);
  });

  /* ---------- favourite GIFs & stickers ---------- */

  const favs = (userId: string) =>
    all<{ embed: string }>('SELECT embed FROM gif_favorites WHERE user_id = ? ORDER BY created_at DESC', userId).map((r) => JSON.parse(r.embed));

  app.put('/api/favorites', async (req) => {
    const me = auth(req);
    const embed = parse(EmbedSchema, req.body);
    run(
      `INSERT INTO gif_favorites (user_id, kind, slug, embed, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, kind, slug) DO UPDATE SET embed = excluded.embed`,
      me.id,
      embed.type,
      embed.slug,
      JSON.stringify(embed),
      now(),
    );
    const list = favs(me.id);
    emitTo([me.id], 'favorites:update', list);
    return list;
  });

  app.delete('/api/favorites/:kind/:slug', async (req) => {
    const me = auth(req);
    const { kind, slug } = req.params as { kind: string; slug: string };
    run('DELETE FROM gif_favorites WHERE user_id = ? AND kind = ? AND slug = ?', me.id, kind, slug);
    const list = favs(me.id);
    emitTo([me.id], 'favorites:update', list);
    return list;
  });

  /* ---------- mutes ---------- */

  // Mute a DM, a channel or a whole group, for some minutes or (minutes: null) until it's unmuted.
  app.put('/api/mutes/:targetId', async (req) => {
    const me = auth(req);
    const { targetId } = parse(z.object({ targetId: z.string().regex(ID_RE) }), req.params);
    const { minutes } = parse(z.object({ minutes: z.number().int().min(1).max(366 * 24 * 60).nullable() }), req.body);
    if (getGroup(targetId)) requireMember(me.id, targetId);
    else requireChannel(me.id, targetId);
    run(
      `INSERT INTO mutes (user_id, target_id, until) VALUES (?, ?, ?)
       ON CONFLICT(user_id, target_id) DO UPDATE SET until = excluded.until`,
      me.id,
      targetId,
      minutes === null ? null : now() + minutes * 60_000,
    );
    const list = mutesOf(me.id);
    emitTo([me.id], 'mutes:update', list);
    return list;
  });

  app.delete('/api/mutes/:targetId', async (req) => {
    const me = auth(req);
    const { targetId } = parse(z.object({ targetId: z.string().regex(ID_RE) }), req.params);
    run('DELETE FROM mutes WHERE user_id = ? AND target_id = ?', me.id, targetId);
    const list = mutesOf(me.id);
    emitTo([me.id], 'mutes:update', list);
    return list;
  });

  app.post('/api/users/@me/password', async (req) => {
    const me = auth(req);
    const body = parse(
      z.object({ currentPassword: z.string(), newPassword: Password, logoutOthers: z.boolean().default(true) }),
      req.body,
    );
    if (!(await verifyPassword(body.currentPassword, me.password_hash))) {
      throw new HttpError(400, 'Your current password is wrong', 'bad_password');
    }
    run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.newPassword), me.id);
    if (body.logoutOthers) {
      const keep = sha256(bearerToken(req)!);
      run('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?', me.id, keep);
      disconnectUserExcept(me.id, keep);
    }
    return { ok: true };
  });

  app.post('/api/users/@me/friend-code', async (req) => {
    const me = auth(req);
    run('UPDATE users SET friend_code = ? WHERE id = ?', uniqueFriendCode(), me.id);
    broadcastUser(me.id);
    return selfUser(getUser(me.id)!);
  });

  app.post('/api/push/subscribe', async (req) => {
    const me = auth(req);
    const body = parse(
      z.object({
        endpoint: z.string().url().max(2000),
        keys: z.object({ p256dh: z.string().max(300), auth: z.string().max(300) }),
      }),
      req.body,
    );
    run(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
      body.endpoint,
      me.id,
      body.keys.p256dh,
      body.keys.auth,
      now(),
    );
    return { ok: true };
  });

  app.post('/api/push/unsubscribe', async (req) => {
    const me = auth(req);
    const body = parse(z.object({ endpoint: z.string() }), req.body);
    run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', body.endpoint, me.id);
    return { ok: true };
  });
}
