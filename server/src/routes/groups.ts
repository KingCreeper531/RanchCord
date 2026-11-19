import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { endCall, kickFromCalls } from '../calls.ts';
import { config } from '../config.ts';
import { AUDIT_ACTIONS, type AuditRow, audit, auditOut, changes } from '../lib/audit.ts';
import { all, get, qs, run, tx } from '../lib/db.ts';
import { removeFile, saveImage } from '../lib/files.ts';
import {
  type CategoryRow,
  type ChannelRow,
  type GroupRow,
  type MemberRow,
  type UserRow,
  categoriesOf,
  categoryOut,
  getGroup,
  getMember,
  getUser,
  groupMemberIds,
  groupOut,
  memberOut,
  publicUser,
  requireMember,
} from '../lib/model.ts';
import { ALL_PERMS, PERM, getRole, hasPerm, requirePerm, roleOut, rolesOf, topPosition } from '../lib/perms.ts';
import { ID_RE, badRequest, forbidden, inviteCode, newId, notFound, now, parse, randomCode } from '../lib/util.ts';
import { emitTo, presenceOf, presencesFor } from '../realtime.ts';
import { createMessage, deleteChannelFiles } from './channels.ts';

/** system_channel_id value meaning "don't post join messages". */
const JOIN_MESSAGES_OFF = 'off';

function groupMeta(g: GroupRow) {
  const everyone = get<{ everyone_permissions: number }>('SELECT everyone_permissions FROM groups WHERE id = ?', g.id);
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    ownerId: g.owner_id,
    everyonePermissions: everyone?.everyone_permissions,
    description: g.description ?? '',
    systemChannelId: g.system_channel_id ?? null,
  };
}

function groupChannelIds(groupId: string) {
  return all<{ id: string }>('SELECT id FROM channels WHERE group_id = ?', groupId).map((r) => r.id);
}

function inviteUrl(code: string, origin?: string) {
  const base = config.publicUrl || origin || '';
  return `${base}/invite/${code}`;
}

function broadcastRoles(groupId: string) {
  emitTo(groupMemberIds(groupId), 'group:roles', { groupId, roles: rolesOf(groupId).map(roleOut) });
}

function broadcastMember(groupId: string, userId: string) {
  const m = getMember(groupId, userId);
  if (m) emitTo(groupMemberIds(groupId), 'group:member-update', { groupId, member: memberOut(m) });
}

/** Category order and where every channel sits, sent whenever any of it changes. */
function broadcastLayout(groupId: string) {
  emitTo(groupMemberIds(groupId), 'group:layout', {
    groupId,
    categories: categoriesOf(groupId).map(categoryOut),
    channels: all<{ id: string; category_id: string | null; position: number }>(
      'SELECT id, category_id, position FROM channels WHERE group_id = ?',
      groupId,
    ).map((c) => ({ id: c.id, categoryId: c.category_id ?? null, position: c.position })),
  });
}

/** Removes a member and tells everyone involved. */
function removeMember(groupId: string, userId: string) {
  const remaining = groupMemberIds(groupId).filter((id) => id !== userId);
  kickFromCalls(userId, groupChannelIds(groupId));
  run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId);
  emitTo([userId], 'group:delete', { id: groupId });
  emitTo(remaining, 'group:member-remove', { groupId, userId });
}

/** You can only manage people and roles ranked below you. */
function outranks(actor: MemberRow, target: MemberRow) {
  if (actor.role === 'owner') return target.role !== 'owner';
  return topPosition(actor) > topPosition(target);
}

/** Who an audit entry is about, with their name saved for later. */
function userTarget(userId: string) {
  const u = getUser(userId);
  return { id: userId, name: u ? u.display_name || u.username : null };
}

/** Which permission bits were turned on and off, for the audit log. */
function permissionChanges(before: number, after: number) {
  const bits = Array.from({ length: 16 }, (_, i) => 1 << i);
  return { added: bits.filter((b) => after & b && !(before & b)), removed: bits.filter((b) => before & b && !(after & b)) };
}

function channelLabel(id: string | null | undefined) {
  if (!id) return null;
  if (id === JOIN_MESSAGES_OFF) return 'off';
  const c = get<{ name: string | null }>('SELECT name FROM channels WHERE id = ?', id);
  return c?.name ? `#${c.name}` : null;
}

const RoleBody = z.object({
  name: z.string().trim().min(1, 'Give the role a name').max(32).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  permissions: z.number().int().min(0).max(ALL_PERMS).optional(),
  hoist: z.boolean().optional(),
  mentionable: z.boolean().optional(),
});

export default async function groupRoutes(app: FastifyInstance) {
  app.post('/api/groups', async (req) => {
    const me = auth(req);
    const { name } = parse(z.object({ name: z.string().trim().min(1, 'Give your group a name').max(64) }), req.body);
    const id = newId();
    const t = now();
    const textCategory = newId();
    const voiceCategory = newId();
    tx(() => {
      run('INSERT INTO groups (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)', id, name, me.id, t);
      run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', id, me.id, 'owner', t);
      run('INSERT INTO channel_categories (id, group_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)', textCategory, id, 'Text channels', 0, t);
      run('INSERT INTO channel_categories (id, group_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)', voiceCategory, id, 'Voice channels', 1, t);
      run(
        'INSERT INTO channels (id, type, group_id, name, position, category_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId(),
        'text',
        id,
        'general',
        0,
        textCategory,
        t,
      );
      run(
        'INSERT INTO channels (id, type, group_id, name, position, category_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        newId(),
        'voice',
        id,
        'Hangout',
        1,
        voiceCategory,
        t,
      );
    });
    const group = groupOut(id)!;
    emitTo([me.id], 'group:create', group);
    return group;
  });

  app.patch('/api/groups/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const member = requireMember(me.id, id);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(64).optional(),
        description: z.string().trim().max(300).optional(),
        /** A text channel's id, null for the first text channel, or "off". */
        systemChannelId: z.string().max(40).nullable().optional(),
        everyonePermissions: z.number().int().min(0).max(ALL_PERMS).optional(),
      }),
      req.body,
    );
    const before = getGroup(id)!;
    const beforeEveryone = groupMeta(before).everyonePermissions ?? 0;
    if (body.name !== undefined || body.description !== undefined || body.systemChannelId !== undefined) {
      requirePerm(member, PERM.MANAGE_GROUP, 'You need the Manage Group permission');
    }
    if (body.systemChannelId && body.systemChannelId !== JOIN_MESSAGES_OFF) {
      const ch = get<ChannelRow>('SELECT * FROM channels WHERE id = ? AND group_id = ?', body.systemChannelId, id);
      if (!ch || ch.type !== 'text') throw badRequest("Pick one of this group's text channels");
    }
    if (body.everyonePermissions !== undefined) {
      requirePerm(member, PERM.MANAGE_ROLES, 'You need the Manage Roles permission');
      // Nobody can hand @everyone Administrator except the owner.
      if (body.everyonePermissions & PERM.ADMINISTRATOR && member.role !== 'owner') throw forbidden('Only the owner can do that');
    }
    tx(() => {
      if (body.name !== undefined) run('UPDATE groups SET name = ? WHERE id = ?', body.name, id);
      if (body.description !== undefined) run('UPDATE groups SET description = ? WHERE id = ?', body.description, id);
      if (body.systemChannelId !== undefined) run('UPDATE groups SET system_channel_id = ? WHERE id = ?', body.systemChannelId, id);
      if (body.everyonePermissions !== undefined) run('UPDATE groups SET everyone_permissions = ? WHERE id = ?', body.everyonePermissions, id);
    });
    const diff = changes(
      { name: before.name, description: before.description ?? '', joinMessages: channelLabel(before.system_channel_id) },
      {
        name: body.name,
        description: body.description,
        joinMessages: body.systemChannelId === undefined ? undefined : channelLabel(body.systemChannelId),
      },
    );
    if (Object.keys(diff).length) audit(id, me.id, 'group_update', { id, name: body.name ?? before.name }, diff);
    if (body.everyonePermissions !== undefined && body.everyonePermissions !== beforeEveryone) {
      audit(id, me.id, 'role_update', { id: null, name: '@everyone' }, { permissions: permissionChanges(beforeEveryone, body.everyonePermissions) });
    }
    const meta = groupMeta(getGroup(id)!);
    emitTo(groupMemberIds(id), 'group:update', meta);
    return meta;
  });

  app.post('/api/groups/:id/icon', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requirePerm(requireMember(me.id, id), PERM.MANAGE_GROUP, 'You need the Manage Group permission');
    const file = await req.file();
    if (!file) throw badRequest('Pick an image first');
    const { rel } = await saveImage(file, `icons/${id}-${randomCode(6).toLowerCase()}`, 16 * 1024 * 1024);
    const group = getGroup(id)!;
    removeFile(group.icon?.replace(/^\/files\//, ''));
    run('UPDATE groups SET icon = ? WHERE id = ?', `/files/${rel}`, id);
    audit(id, me.id, 'group_update', { id, name: group.name }, { icon: 'changed' });
    const meta = groupMeta(getGroup(id)!);
    emitTo(groupMemberIds(id), 'group:update', meta);
    return meta;
  });

  app.delete('/api/groups/:id/icon', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requirePerm(requireMember(me.id, id), PERM.MANAGE_GROUP, 'You need the Manage Group permission');
    const group = getGroup(id)!;
    removeFile(group.icon?.replace(/^\/files\//, ''));
    run('UPDATE groups SET icon = NULL WHERE id = ?', id);
    if (group.icon) audit(id, me.id, 'group_update', { id, name: group.name }, { icon: 'removed' });
    const meta = groupMeta(getGroup(id)!);
    emitTo(groupMemberIds(id), 'group:update', meta);
    return meta;
  });

  app.delete('/api/groups/:id', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const member = requireMember(me.id, id);
    if (member.role !== 'owner') throw forbidden('Only the owner can delete the group');
    const members = groupMemberIds(id);
    const channels = groupChannelIds(id);
    for (const ch of channels) endCall(ch, 'group_deleted');
    deleteChannelFiles(channels);
    const group = getGroup(id)!;
    removeFile(group.icon?.replace(/^\/files\//, ''));
    run('DELETE FROM groups WHERE id = ?', id);
    emitTo(members, 'group:delete', { id });
    return { ok: true };
  });

  /* ---------- members ---------- */

  app.delete('/api/groups/:id/members/:userId', async (req) => {
    const me = auth(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const actor = requireMember(me.id, id);
    const targetId = userId === '@me' ? me.id : userId;
    const target = getMember(id, targetId);
    if (!target) throw notFound("They're not in this group");
    if (targetId === me.id) {
      if (actor.role === 'owner') throw badRequest('Owners have to transfer ownership or delete the group before leaving');
    } else {
      requirePerm(actor, PERM.KICK_MEMBERS, 'You need the Kick Members permission');
      if (!outranks(actor, target)) throw forbidden("You can't kick someone ranked the same as or above you");
      audit(id, me.id, 'member_kick', userTarget(targetId));
    }
    removeMember(id, targetId);
    return { ok: true };
  });

  app.patch('/api/groups/:id/members/:userId', async (req) => {
    const me = auth(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const actor = requireMember(me.id, id);
    const targetId = userId === '@me' ? me.id : userId;
    const target = getMember(id, targetId);
    if (!target) throw notFound("They're not in this group");
    const body = parse(
      z.object({ role: z.enum(['admin', 'member']).optional(), nickname: z.string().trim().max(32).nullable().optional() }),
      req.body,
    );
    if (body.role !== undefined) {
      if (actor.role !== 'owner') throw forbidden('Only the owner can change that');
      if (target.role === 'owner') throw badRequest('Use transfer ownership instead');
      // Admin powers come from roles now (the Administrator permission). Older admins can still be demoted.
      if (body.role === 'admin' && target.role !== 'admin') throw badRequest('Give them a role with the Administrator permission instead');
      run('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', body.role, id, targetId);
      if (body.role !== target.role) audit(id, me.id, 'member_admin', userTarget(targetId), { role: [target.role, body.role] });
    }
    if (body.nickname !== undefined) {
      if (targetId !== me.id) {
        requirePerm(actor, PERM.MANAGE_NICKNAMES, 'You need the Manage Nicknames permission');
        if (!outranks(actor, target)) throw forbidden("You can't change the nickname of someone ranked above you");
      }
      run('UPDATE group_members SET nickname = ? WHERE group_id = ? AND user_id = ?', body.nickname || null, id, targetId);
      if (targetId !== me.id && (body.nickname || null) !== target.nickname) {
        audit(id, me.id, 'member_nickname', userTarget(targetId), { nickname: [target.nickname, body.nickname || null] });
      }
    }
    broadcastMember(id, targetId);
    return memberOut(getMember(id, targetId)!);
  });

  /** Time someone out (they can't talk, react or join voice), or end it early with minutes: 0. */
  app.put('/api/groups/:id/members/:userId/timeout', async (req) => {
    const me = auth(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const actor = requireMember(me.id, id);
    requirePerm(actor, PERM.MODERATE_MEMBERS, 'You need the Time Out Members permission');
    const target = getMember(id, userId);
    if (!target) throw notFound("They're not in this group");
    if (userId === me.id) throw badRequest("You can't time yourself out");
    if (!outranks(actor, target)) throw forbidden("You can't time out someone ranked the same as or above you");
    if (hasPerm(target, PERM.ADMINISTRATOR)) throw forbidden("Admins can't be timed out");
    const { minutes } = parse(z.object({ minutes: z.number().int().min(0).max(28 * 24 * 60) }), req.body);
    const until = minutes ? now() + minutes * 60_000 : null;
    run('UPDATE group_members SET timeout_until = ? WHERE group_id = ? AND user_id = ?', until, id, userId);
    if (until) {
      kickFromCalls(userId, groupChannelIds(id));
      audit(id, me.id, 'member_timeout', userTarget(userId), { minutes });
    } else if (target.timeout_until && target.timeout_until > now()) {
      audit(id, me.id, 'member_timeout_remove', userTarget(userId));
    }
    broadcastMember(id, userId);
    return memberOut(getMember(id, userId)!);
  });

  app.post('/api/groups/:id/transfer', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const actor = requireMember(me.id, id);
    if (actor.role !== 'owner') throw forbidden('Only the owner can transfer ownership');
    const { userId } = parse(z.object({ userId: z.string() }), req.body);
    if (!getMember(id, userId) || userId === me.id) throw notFound("They're not in this group");
    tx(() => {
      run("UPDATE group_members SET role = 'admin' WHERE group_id = ? AND user_id = ?", id, me.id);
      run("UPDATE group_members SET role = 'owner' WHERE group_id = ? AND user_id = ?", id, userId);
      run('UPDATE groups SET owner_id = ? WHERE id = ?', userId, id);
    });
    audit(id, me.id, 'owner_transfer', userTarget(userId));
    emitTo(groupMemberIds(id), 'group:update', groupMeta(getGroup(id)!));
    for (const uid of [me.id, userId]) broadcastMember(id, uid);
    return { ok: true };
  });

  /* ---------- bans ---------- */

  app.get('/api/groups/:id/bans', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requirePerm(requireMember(me.id, id), PERM.BAN_MEMBERS, 'You need the Ban Members permission');
    const rows = all<{ user_id: string; reason: string; banned_by: string | null; created_at: number }>(
      'SELECT user_id, reason, banned_by, created_at FROM group_bans WHERE group_id = ? ORDER BY created_at DESC',
      id,
    );
    return rows.flatMap((r) => {
      const user = getUser(r.user_id);
      if (!user) return [];
      const by = r.banned_by ? getUser(r.banned_by) : undefined;
      return [{ user: publicUser(user), reason: r.reason, createdAt: r.created_at, bannedBy: by ? publicUser(by) : null }];
    });
  });

  /** Ban someone: they're removed if they're in the group, and invites stop working for them. */
  app.put('/api/groups/:id/bans/:userId', async (req) => {
    const me = auth(req);
    const { id, userId } = req.params as { id: string; userId: string };
    const actor = requireMember(me.id, id);
    requirePerm(actor, PERM.BAN_MEMBERS, 'You need the Ban Members permission');
    if (userId === me.id) throw badRequest("You can't ban yourself");
    if (!getUser(userId)) throw notFound("That person doesn't exist");
    const target = getMember(id, userId);
    if (target && !outranks(actor, target)) throw forbidden("You can't ban someone ranked the same as or above you");
    const { reason } = parse(z.object({ reason: z.string().trim().max(300).default('') }), req.body ?? {});
    run(
      `INSERT INTO group_bans (group_id, user_id, reason, banned_by, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(group_id, user_id) DO UPDATE SET reason = excluded.reason, banned_by = excluded.banned_by`,
      id,
      userId,
      reason,
      me.id,
      now(),
    );
    audit(id, me.id, 'member_ban', userTarget(userId), reason ? { reason } : null);
    if (target) removeMember(id, userId);
    return { ok: true };
  });

  app.delete('/api/groups/:id/bans/:userId', async (req) => {
    const me = auth(req);
    const { id, userId } = req.params as { id: string; userId: string };
    requirePerm(requireMember(me.id, id), PERM.BAN_MEMBERS, 'You need the Ban Members permission');
    const removed = run('DELETE FROM group_bans WHERE group_id = ? AND user_id = ?', id, userId);
    if (removed.changes) audit(id, me.id, 'member_unban', userTarget(userId));
    return { ok: true };
  });

  /* ---------- audit log ---------- */

  app.get('/api/groups/:id/audit-log', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requirePerm(requireMember(me.id, id), PERM.VIEW_AUDIT_LOG, 'You need the View Audit Log permission');
    const q = parse(
      z.object({
        before: z.string().regex(ID_RE).optional(),
        action: z.enum(AUDIT_ACTIONS).optional(),
        actor: z.string().regex(ID_RE).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
      req.query,
    );
    const where = ['group_id = ?'];
    const args: (string | number)[] = [id];
    if (q.before) (where.push('id < ?'), args.push(q.before));
    if (q.action) (where.push('action = ?'), args.push(q.action));
    if (q.actor) (where.push('actor_id = ?'), args.push(q.actor));
    const rows = all<AuditRow>(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, ...args, q.limit + 1);
    const entries = rows.slice(0, q.limit);
    const ids = [...new Set(entries.flatMap((r) => [r.actor_id, r.target_id]).filter((x): x is string => Boolean(x)))];
    const users = ids.length ? all<UserRow>(`SELECT * FROM users WHERE id IN (${qs(ids.length)})`, ...ids) : [];
    return {
      entries: entries.map(auditOut),
      users: Object.fromEntries(users.map((u) => [u.id, publicUser(u)])),
      hasMore: rows.length > q.limit,
    };
  });

  /* ---------- categories & channel order ---------- */

  const CategoryBody = z.object({ name: z.string().trim().min(1, 'Give the category a name').max(48) });

  app.post('/api/groups/:id/categories', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requirePerm(requireMember(me.id, id), PERM.MANAGE_CHANNELS, 'You need the Manage Channels permission');
    const { name } = parse(CategoryBody, req.body);
    const position = (get<{ p: number | null }>('SELECT MAX(position) AS p FROM channel_categories WHERE group_id = ?', id)?.p ?? -1) + 1;
    const categoryId = newId();
    run('INSERT INTO channel_categories (id, group_id, name, position, created_at) VALUES (?, ?, ?, ?, ?)', categoryId, id, name, position, now());
    audit(id, me.id, 'category_create', { id: categoryId, name });
    broadcastLayout(id);
    return categoryOut(get<CategoryRow>('SELECT * FROM channel_categories WHERE id = ?', categoryId)!);
  });

  app.patch('/api/groups/:id/categories/:categoryId', async (req) => {
    const me = auth(req);
    const { id, categoryId } = req.params as { id: string; categoryId: string };
    requirePerm(requireMember(me.id, id), PERM.MANAGE_CHANNELS, 'You need the Manage Channels permission');
    const category = get<CategoryRow>('SELECT * FROM channel_categories WHERE id = ? AND group_id = ?', categoryId, id);
    if (!category) throw notFound('That category was deleted');
    const { name } = parse(CategoryBody, req.body);
    run('UPDATE channel_categories SET name = ? WHERE id = ?', name, categoryId);
    if (name !== category.name) audit(id, me.id, 'category_update', { id: categoryId, name }, { name: [category.name, name] });
    broadcastLayout(id);
    return categoryOut(get<CategoryRow>('SELECT * FROM channel_categories WHERE id = ?', categoryId)!);
  });

  /** Deleting a category keeps its channels: they move to the top of the list. */
  app.delete('/api/groups/:id/categories/:categoryId', async (req) => {
    const me = auth(req);
    const { id, categoryId } = req.params as { id: string; categoryId: string };
    requirePerm(requireMember(me.id, id), PERM.MANAGE_CHANNELS, 'You need the Manage Channels permission');
    const category = get<CategoryRow>('SELECT * FROM channel_categories WHERE id = ? AND group_id = ?', categoryId, id);
    if (!category) return { ok: true };
    tx(() => {
      run('UPDATE channels SET category_id = NULL WHERE group_id = ? AND category_id = ?', id, categoryId);
      run('DELETE FROM channel_categories WHERE id = ?', categoryId);
    });
    audit(id, me.id, 'category_delete', { id: categoryId, name: category.name });
    broadcastLayout(id);
    return { ok: true };
  });

  /** Saves the whole channel list's order at once: categories top to bottom, and every channel
   *  top to bottom with the category it now sits in. */
  app.put('/api/groups/:id/layout', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requirePerm(requireMember(me.id, id), PERM.MANAGE_CHANNELS, 'You need the Manage Channels permission');
    const body = parse(
      z.object({
        categories: z.array(z.string()).max(200),
        channels: z.array(z.object({ id: z.string(), categoryId: z.string().nullable() })).max(500),
      }),
      req.body,
    );
    const categories = categoriesOf(id);
    const channels = all<ChannelRow>('SELECT * FROM channels WHERE group_id = ?', id);
    const sameSet = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && b.every((x) => a.includes(x));
    const categoryIds = categories.map((c) => c.id);
    if (!sameSet(body.categories, categoryIds) || !sameSet(body.channels.map((c) => c.id), channels.map((c) => c.id))) {
      throw badRequest('The channel list changed while you were moving things. Try again.');
    }
    if (body.channels.some((c) => c.categoryId !== null && !categoryIds.includes(c.categoryId))) throw badRequest('That category was deleted');
    const moved = body.channels.filter((c, i) => {
      const old = channels.find((x) => x.id === c.id)!;
      return (old.category_id ?? null) !== c.categoryId || old.position !== i;
    }).length;
    tx(() => {
      body.categories.forEach((categoryId, i) => run('UPDATE channel_categories SET position = ? WHERE id = ?', i, categoryId));
      body.channels.forEach((c, i) => run('UPDATE channels SET position = ?, category_id = ? WHERE id = ?', i, c.categoryId, c.id));
    });
    if (moved || body.categories.some((c, i) => categories.find((x) => x.id === c)!.position !== i)) {
      audit(id, me.id, 'channels_move', { id, name: getGroup(id)!.name }, moved ? { channels: moved } : null);
    }
    broadcastLayout(id);
    return { ok: true };
  });

  /* ---------- roles ---------- */

  app.post('/api/groups/:id/roles', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const actor = requireMember(me.id, id);
    requirePerm(actor, PERM.MANAGE_ROLES, 'You need the Manage Roles permission');
    const body = parse(RoleBody, req.body);
    if ((body.permissions ?? 0) & PERM.ADMINISTRATOR && actor.role !== 'owner' && actor.role !== 'admin') {
      throw forbidden('Only admins can create Administrator roles');
    }
    // New roles go to the bottom, just above @everyone (like Discord).
    run('UPDATE roles SET position = position + 1 WHERE group_id = ?', id);
    const roleId = newId();
    run(
      `INSERT INTO roles (id, group_id, name, color, position, permissions, hoist, mentionable, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      roleId,
      id,
      body.name ?? 'new role',
      body.color ?? null,
      body.permissions ?? 0,
      body.hoist ?? false,
      body.mentionable ?? true,
      now(),
    );
    audit(id, me.id, 'role_create', { id: roleId, name: body.name ?? 'new role' });
    broadcastRoles(id);
    return roleOut(getRole(id, roleId)!);
  });

  app.patch('/api/groups/:id/roles/:roleId', async (req) => {
    const me = auth(req);
    const { id, roleId } = req.params as { id: string; roleId: string };
    const actor = requireMember(me.id, id);
    requirePerm(actor, PERM.MANAGE_ROLES, 'You need the Manage Roles permission');
    const role = getRole(id, roleId);
    if (!role) throw notFound('That role was deleted');
    if (topPosition(actor) <= role.position) throw forbidden('You can only edit roles below your highest role');
    const body = parse(RoleBody, req.body);
    if (body.permissions !== undefined && body.permissions & PERM.ADMINISTRATOR && actor.role !== 'owner' && actor.role !== 'admin') {
      throw forbidden('Only admins can grant Administrator');
    }
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    if (body.name !== undefined) (sets.push('name = ?'), values.push(body.name));
    if (body.color !== undefined) (sets.push('color = ?'), values.push(body.color));
    if (body.permissions !== undefined) (sets.push('permissions = ?'), values.push(body.permissions));
    if (body.hoist !== undefined) (sets.push('hoist = ?'), values.push(body.hoist ? 1 : 0));
    if (body.mentionable !== undefined) (sets.push('mentionable = ?'), values.push(body.mentionable ? 1 : 0));
    if (sets.length) run(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, ...values, roleId);
    const details: Record<string, unknown> = changes(
      { name: role.name, color: role.color, hoist: Boolean(role.hoist), mentionable: Boolean(role.mentionable) },
      { name: body.name, color: body.color, hoist: body.hoist, mentionable: body.mentionable },
    );
    if (body.permissions !== undefined && body.permissions !== role.permissions) details.permissions = permissionChanges(role.permissions, body.permissions);
    if (Object.keys(details).length) audit(id, me.id, 'role_update', { id: roleId, name: body.name ?? role.name }, details);
    broadcastRoles(id);
    return roleOut(getRole(id, roleId)!);
  });

  app.delete('/api/groups/:id/roles/:roleId', async (req) => {
    const me = auth(req);
    const { id, roleId } = req.params as { id: string; roleId: string };
    const actor = requireMember(me.id, id);
    requirePerm(actor, PERM.MANAGE_ROLES, 'You need the Manage Roles permission');
    const role = getRole(id, roleId);
    if (!role) return { ok: true };
    if (topPosition(actor) <= role.position) throw forbidden('You can only delete roles below your highest role');
    const holders = all<{ user_id: string }>('SELECT user_id FROM member_roles WHERE role_id = ?', roleId).map((r) => r.user_id);
    run('DELETE FROM roles WHERE id = ?', roleId);
    audit(id, me.id, 'role_delete', { id: roleId, name: role.name });
    broadcastRoles(id);
    for (const uid of holders) broadcastMember(id, uid);
    return { ok: true };
  });

  /** Reorder roles: ids from highest to lowest. */
  app.put('/api/groups/:id/roles', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    const actor = requireMember(me.id, id);
    requirePerm(actor, PERM.MANAGE_ROLES, 'You need the Manage Roles permission');
    const { ids } = parse(z.object({ ids: z.array(z.string()).max(250) }), req.body);
    const roles = rolesOf(id);
    if (ids.length !== roles.length || !roles.every((r) => ids.includes(r.id))) throw badRequest('Role list is out of date, try again');
    const top = topPosition(actor);
    let changed = false;
    tx(() => {
      ids.forEach((roleId, i) => {
        const position = ids.length - i;
        const role = roles.find((r) => r.id === roleId)!;
        if (role.position !== position && (role.position >= top || position >= top)) {
          throw forbidden("You can't move roles at or above your highest role");
        }
        if (role.position !== position) changed = true;
        run('UPDATE roles SET position = ? WHERE id = ?', position, roleId);
      });
    });
    if (changed) audit(id, me.id, 'roles_reorder');
    broadcastRoles(id);
    return { ok: true };
  });

  const assignRoute = '/api/groups/:id/members/:userId/roles/:roleId';

  app.put(assignRoute, async (req) => {
    const me = auth(req);
    const { id, userId, roleId } = req.params as { id: string; userId: string; roleId: string };
    const actor = requireMember(me.id, id);
    requirePerm(actor, PERM.MANAGE_ROLES, 'You need the Manage Roles permission');
    const role = getRole(id, roleId);
    if (!role) throw notFound('That role was deleted');
    if (!getMember(id, userId)) throw notFound("They're not in this group");
    if (topPosition(actor) <= role.position) throw forbidden('You can only give out roles below your highest role');
    const added = run('INSERT OR IGNORE INTO member_roles (group_id, user_id, role_id) VALUES (?, ?, ?)', id, userId, roleId);
    if (added.changes) audit(id, me.id, 'member_role_add', userTarget(userId), { role: role.name });
    broadcastMember(id, userId);
    return { ok: true };
  });

  app.delete(assignRoute, async (req) => {
    const me = auth(req);
    const { id, userId, roleId } = req.params as { id: string; userId: string; roleId: string };
    const actor = requireMember(me.id, id);
    requirePerm(actor, PERM.MANAGE_ROLES, 'You need the Manage Roles permission');
    const role = getRole(id, roleId);
    if (role && topPosition(actor) <= role.position) throw forbidden('You can only take away roles below your highest role');
    const removed = run('DELETE FROM member_roles WHERE group_id = ? AND user_id = ? AND role_id = ?', id, userId, roleId);
    if (removed.changes && role) audit(id, me.id, 'member_role_remove', userTarget(userId), { role: role.name });
    broadcastMember(id, userId);
    return { ok: true };
  });

  /* ---------- invites ---------- */

  app.get('/api/groups/:id/invite', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requirePerm(requireMember(me.id, id), PERM.CREATE_INVITE, "You don't have permission to invite people here");
    let invite = get<{ code: string }>(
      'SELECT code FROM invites WHERE group_id = ? AND creator_id = ? ORDER BY created_at DESC LIMIT 1',
      id,
      me.id,
    );
    if (!invite) {
      const code = inviteCode();
      run('INSERT INTO invites (code, group_id, creator_id, created_at) VALUES (?, ?, ?, ?)', code, id, me.id, now());
      audit(id, me.id, 'invite_create', { id: null, name: code });
      invite = { code };
    }
    return { code: invite.code, url: inviteUrl(invite.code, req.headers.origin) };
  });

  app.post('/api/groups/:id/invite/reset', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requirePerm(requireMember(me.id, id), PERM.CREATE_INVITE, "You don't have permission to invite people here");
    const code = inviteCode();
    tx(() => {
      run('DELETE FROM invites WHERE group_id = ? AND creator_id = ?', id, me.id);
      run('INSERT INTO invites (code, group_id, creator_id, created_at) VALUES (?, ?, ?, ?)', code, id, me.id, now());
    });
    audit(id, me.id, 'invite_reset', { id: null, name: code });
    return { code, url: inviteUrl(code, req.headers.origin) };
  });

  app.get('/api/invites/:code', async (req) => {
    const me = auth(req);
    const { code } = req.params as { code: string };
    const invite = get<{ code: string; group_id: string; creator_id: string }>('SELECT * FROM invites WHERE code = ?', code);
    const group = invite ? getGroup(invite.group_id) : undefined;
    if (!invite || !group) throw notFound('This invite is invalid or has expired');
    const memberIds = groupMemberIds(group.id);
    const inviter = getUser(invite.creator_id);
    return {
      code,
      group: {
        id: group.id,
        name: group.name,
        icon: group.icon,
        description: group.description ?? '',
        memberCount: memberIds.length,
        onlineCount: Object.keys(presencesFor(memberIds)).length,
      },
      inviter: inviter ? publicUser(inviter) : null,
      joined: memberIds.includes(me.id),
    };
  });

  app.post('/api/invites/:code', async (req) => {
    const me = auth(req);
    const { code } = req.params as { code: string };
    const invite = get<{ code: string; group_id: string; creator_id: string }>('SELECT * FROM invites WHERE code = ?', code);
    if (!invite || !getGroup(invite.group_id)) throw notFound('This invite is invalid or has expired');
    // Invites from people who lost the invite permission stop working.
    if (!hasPerm(getMember(invite.group_id, invite.creator_id), PERM.CREATE_INVITE)) throw notFound('This invite is invalid or has expired');
    const groupId = invite.group_id;
    if (getMember(groupId, me.id)) return groupOut(groupId);
    if (get('SELECT 1 AS banned FROM group_bans WHERE group_id = ? AND user_id = ?', groupId, me.id)) throw forbidden("You're banned from this group");

    const existing = groupMemberIds(groupId);
    tx(() => {
      run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', groupId, me.id, 'member', now());
      run('UPDATE invites SET uses = uses + 1 WHERE code = ?', code);
    });
    const group = groupOut(groupId)!;
    emitTo([me.id], 'group:create', group);
    emitTo(existing, 'group:member-add', {
      groupId,
      member: memberOut(getMember(groupId, me.id) as MemberRow, []),
      user: publicUser(me),
      presence: presenceOf(me.id),
    });
    emitTo([me.id], 'presence:bulk', presencesFor(existing));

    // "X joined" goes to the channel picked in Group settings, or the first text channel.
    const system = getGroup(groupId)!.system_channel_id;
    if (system !== JOIN_MESSAGES_OFF) {
      const welcome =
        (system ? get<ChannelRow>("SELECT * FROM channels WHERE id = ? AND group_id = ? AND type = 'text'", system, groupId) : undefined) ??
        get<ChannelRow>("SELECT * FROM channels WHERE group_id = ? AND type = 'text' ORDER BY position, created_at LIMIT 1", groupId);
      if (welcome) createMessage({ channel: welcome, author: me as UserRow, type: 'join' });
    }
    return group;
  });
}
