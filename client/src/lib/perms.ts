import type { DataState } from '../store/data';

/** Mirrors server/src/lib/perms.ts. */
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

export const PERM_INFO: { bit: number; name: string; hint: string }[] = [
  { bit: PERM.ADMINISTRATOR, name: 'Administrator', hint: 'Every permission. Can do anything in the group, so give it out carefully.' },
  { bit: PERM.MANAGE_GROUP, name: 'Manage group', hint: 'Change the group name and icon.' },
  { bit: PERM.MANAGE_CHANNELS, name: 'Manage channels', hint: 'Create, edit and delete channels.' },
  { bit: PERM.MANAGE_ROLES, name: 'Manage roles', hint: 'Create and edit roles below their own, and give them to people.' },
  { bit: PERM.KICK_MEMBERS, name: 'Kick members', hint: 'Remove people ranked below them from the group.' },
  { bit: PERM.MANAGE_MESSAGES, name: 'Manage messages', hint: "Delete other people's messages." },
  { bit: PERM.MANAGE_NICKNAMES, name: 'Manage nicknames', hint: "Change other people's nicknames." },
  { bit: PERM.MENTION_EVERYONE, name: 'Mention @everyone and all roles', hint: 'Ping the whole group with @everyone or @here, and ping any role.' },
  { bit: PERM.CREATE_INVITE, name: 'Create invites', hint: 'Invite new people to the group.' },
  { bit: PERM.SEND_MESSAGES, name: 'Send messages', hint: 'Talk in text channels.' },
  { bit: PERM.ATTACH_FILES, name: 'Attach files', hint: 'Upload pictures, videos and files.' },
  { bit: PERM.CONNECT_VOICE, name: 'Join voice', hint: 'Join voice channels.' },
  { bit: PERM.USE_SOUNDBOARD, name: 'Use soundboard', hint: 'Play soundboard sounds in voice channels.' },
];

export function memberPerms(s: DataState, groupId: string, userId: string): number {
  const g = s.groups[groupId];
  const m = g?.members[userId];
  if (!g || !m) return 0;
  if (m.role === 'owner' || m.role === 'admin') return ALL_PERMS;
  let p = g.everyonePermissions;
  for (const id of m.roles) p |= g.roles[id]?.permissions ?? 0;
  return p & PERM.ADMINISTRATOR ? ALL_PERMS : p;
}

export function can(s: DataState, groupId: string | null | undefined, perm: number): boolean {
  if (!groupId || !s.me) return false;
  return (memberPerms(s, groupId, s.me.id) & perm) === perm;
}

/** Highest role position. Owners and admins outrank every role. */
export function topPosition(s: DataState, groupId: string, userId: string): number {
  const g = s.groups[groupId];
  const m = g?.members[userId];
  if (!g || !m) return 0;
  if (m.role === 'owner') return Number.MAX_SAFE_INTEGER;
  if (m.role === 'admin') return Number.MAX_SAFE_INTEGER - 1;
  return Math.max(0, ...m.roles.map((id) => g.roles[id]?.position ?? 0));
}

/** Name colour is the colour of the highest role that has one. */
export function memberColor(s: DataState, groupId: string | null | undefined, userId: string): string | undefined {
  if (!groupId) return undefined;
  const g = s.groups[groupId];
  const m = g?.members[userId];
  if (!g || !m) return undefined;
  let best: { position: number; color: string } | undefined;
  for (const id of m.roles) {
    const r = g.roles[id];
    if (r?.color && (!best || r.position > best.position)) best = { position: r.position, color: r.color };
  }
  return best?.color;
}

export function sortedRoles(s: DataState, groupId: string) {
  return Object.values(s.groups[groupId]?.roles ?? {}).sort((a, b) => b.position - a.position);
}
