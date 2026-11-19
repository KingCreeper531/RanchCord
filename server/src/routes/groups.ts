import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { endCall, kickFromCalls } from '../calls.ts';
import { config } from '../config.ts';
import { all, get, run, tx } from '../lib/db.ts';
import { removeFile, saveImage } from '../lib/files.ts';
import {
  type ChannelRow,
  type GroupRow,
  type MemberRow,
  type UserRow,
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
import { badRequest, forbidden, inviteCode, newId, notFound, now, parse, randomCode } from '../lib/util.ts';
import { emitTo, presenceOf, presencesFor } from '../realtime.ts';
import { createMessage, deleteChannelFiles } from './channels.ts';

function groupMeta(g: GroupRow) {
  const everyone = get<{ everyone_permissions: number }>('SELECT everyone_permissions FROM groups WHERE id = ?', g.id);
  return { id: g.id, name: g.name, icon: g.icon, ownerId: g.owner_id, everyonePermissions: everyone?.everyone_permissions };
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
    tx(() => {
      run('INSERT INTO groups (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)', id, name, me.id, t);
      run('INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)', id, me.id, 'owner', t);
      run('INSERT INTO channels (id, type, group_id, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), 'text', id, 'general', 0, t);
      run('INSERT INTO channels (id, type, group_id, name, position, created_at) VALUES (?, ?, ?, ?, ?, ?)', newId(), 'voice', id, 'Hangout', 1, t);
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
      z.object({ name: z.string().trim().min(1).max(64).optional(), everyonePermissions: z.number().int().min(0).max(ALL_PERMS).optional() }),
      req.body,
    );
    if (body.name !== undefined) {
      requirePerm(member, PERM.MANAGE_GROUP, 'You need the Manage Group permission');
      run('UPDATE groups SET name = ? WHERE id = ?', body.name, id);
    }
    if (body.everyonePermissions !== undefined) {
      requirePerm(member, PERM.MANAGE_ROLES, 'You need the Manage Roles permission');
      // Nobody can hand @everyone Administrator except the owner.
      if (body.everyonePermissions & PERM.ADMINISTRATOR && member.role !== 'owner') throw forbidden('Only the owner can do that');
      run('UPDATE groups SET everyone_permissions = ? WHERE id = ?', body.everyonePermissions, id);
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
    const meta = groupMeta(getGroup(id)!);
    emitTo(groupMemberIds(id), 'group:update', meta);
    return meta;
  });

  app.delete('/api/groups/:id/icon', async (req) => {
    const me = auth(req);
    const { id } = req.params as { id: string };
    requirePerm(requireMember(me.id, id), PERM.MANAGE_GROUP, 'You need the Manage Group permission');
    removeFile(getGroup(id)!.icon?.replace(/^\/files\//, ''));
    run('UPDATE groups SET icon = NULL WHERE id = ?', id);
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
      if (actor.role !== 'owner') throw forbidden('Only the owner can make people admins');
      if (target.role === 'owner') throw badRequest('Use transfer ownership instead');
      run('UPDATE group_members SET role = ? WHERE group_id = ? AND user_id = ?', body.role, id, targetId);
    }
    if (body.nickname !== undefined) {
      if (targetId !== me.id) {
        requirePerm(actor, PERM.MANAGE_NICKNAMES, 'You need the Manage Nicknames permission');
        if (!outranks(actor, target)) throw forbidden("You can't change the nickname of someone ranked above you");
      }
      run('UPDATE group_members SET nickname = ? WHERE group_id = ? AND user_id = ?', body.nickname || null, id, targetId);
    }
    broadcastMember(id, targetId);
    return memberOut(getMember(id, targetId)!);
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
    emitTo(groupMemberIds(id), 'group:update', groupMeta(getGroup(id)!));
    for (const uid of [me.id, userId]) broadcastMember(id, uid);
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
    tx(() => {
      ids.forEach((roleId, i) => {
        const position = ids.length - i;
        const role = roles.find((r) => r.id === roleId)!;
        if (role.position !== position && (role.position >= top || position >= top)) {
          throw forbidden("You can't move roles at or above your highest role");
        }
        run('UPDATE roles SET position = ? WHERE id = ?', position, roleId);
      });
    });
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
    run('INSERT OR IGNORE INTO member_roles (group_id, user_id, role_id) VALUES (?, ?, ?)', id, userId, roleId);
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
    run('DELETE FROM member_roles WHERE group_id = ? AND user_id = ? AND role_id = ?', id, userId, roleId);
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

    const welcome = get<ChannelRow>(
      "SELECT * FROM channels WHERE group_id = ? AND type = 'text' ORDER BY position, created_at LIMIT 1",
      groupId,
    );
    if (welcome) createMessage({ channel: welcome, author: me as UserRow, type: 'join' });
    return group;
  });
}
