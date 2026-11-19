import { all, get } from './db.ts';
import type { MemberRow } from './model.ts';
import { forbidden } from './util.ts';

/** Discord-style permission bits for group roles. */
export const PERM = {
  ADMINISTRATOR: 1 << 0,
  MANAGE_GROUP: 1 << 1,
  MANAGE_CHANNELS: 1 << 2,
  MANAGE_ROLES: 1 << 3,
  KICK_MEMBERS: 1 << 4,
  MANAGE_MESSAGES: 1 << 5,
  MENTION_EVERYONE: 1 << 6,
  CREATE_INVITE: 1 << 7,
  MANAGE_NICKNAMES: 1 << 8,
  SEND_MESSAGES: 1 << 9,
  ATTACH_FILES: 1 << 10,
  CONNECT_VOICE: 1 << 11,
  USE_SOUNDBOARD: 1 << 12,
} as const;

export const ALL_PERMS = (1 << 13) - 1;
export const DEFAULT_EVERYONE =
  PERM.CREATE_INVITE | PERM.MENTION_EVERYONE | PERM.SEND_MESSAGES | PERM.ATTACH_FILES | PERM.CONNECT_VOICE | PERM.USE_SOUNDBOARD;

export interface RoleRow {
  id: string;
  group_id: string;
  name: string;
  color: string | null;
  position: number;
  permissions: number;
  hoist: number;
  mentionable: number;
  created_at: number;
}

export function roleOut(r: RoleRow) {
  return {
    id: r.id,
    groupId: r.group_id,
    name: r.name,
    color: r.color,
    position: r.position,
    permissions: r.permissions,
    hoist: Boolean(r.hoist),
    mentionable: Boolean(r.mentionable),
  };
}

export const rolesOf = (groupId: string) => all<RoleRow>('SELECT * FROM roles WHERE group_id = ? ORDER BY position DESC, created_at', groupId);
export const getRole = (groupId: string, roleId: string) => get<RoleRow>('SELECT * FROM roles WHERE id = ? AND group_id = ?', roleId, groupId);

export function memberRoleIds(groupId: string, userId: string): string[] {
  return all<{ role_id: string }>('SELECT role_id FROM member_roles WHERE group_id = ? AND user_id = ?', groupId, userId).map((r) => r.role_id);
}

export function everyonePermissions(groupId: string): number {
  return get<{ everyone_permissions: number }>('SELECT everyone_permissions FROM groups WHERE id = ?', groupId)?.everyone_permissions ?? DEFAULT_EVERYONE;
}

export function permissionsFor(member: MemberRow | null | undefined): number {
  if (!member) return 0;
  if (member.role === 'owner' || member.role === 'admin') return ALL_PERMS;
  let p = everyonePermissions(member.group_id);
  for (const r of all<{ permissions: number }>(
    'SELECT r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.group_id = ? AND mr.user_id = ?',
    member.group_id,
    member.user_id,
  )) {
    p |= r.permissions;
  }
  return p & PERM.ADMINISTRATOR ? ALL_PERMS : p;
}

export const hasPerm = (member: MemberRow | null | undefined, perm: number) => (permissionsFor(member) & perm) === perm;

export function requirePerm(member: MemberRow | null | undefined, perm: number, message = "You don't have permission to do that") {
  if (!hasPerm(member, perm)) throw forbidden(message);
}

/** Highest role position a member holds. Owners and admins outrank every custom role. */
export function topPosition(member: MemberRow): number {
  if (member.role === 'owner') return Number.MAX_SAFE_INTEGER;
  if (member.role === 'admin') return Number.MAX_SAFE_INTEGER - 1;
  return (
    get<{ p: number | null }>(
      'SELECT MAX(r.position) AS p FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.group_id = ? AND mr.user_id = ?',
      member.group_id,
      member.user_id,
    )?.p ?? 0
  );
}

/** Members holding any of these roles (for @role pings). */
export function membersWithRoles(groupId: string, roleIds: string[]): string[] {
  if (!roleIds.length) return [];
  return all<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM member_roles WHERE group_id = ? AND role_id IN (${roleIds.map(() => '?').join(',')})`,
    groupId,
    ...roleIds,
  ).map((r) => r.user_id);
}
