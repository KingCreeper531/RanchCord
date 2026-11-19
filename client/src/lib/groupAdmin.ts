import { data, useData } from '../store/data';
import type { ChannelCategory, Member, User } from '../types';
import { api } from './api';

/* Group settings that go beyond roles: categories and channel order, bans, timeouts, audit log. */

export type AuditAction =
  | 'group_update'
  | 'channel_create'
  | 'channel_update'
  | 'channel_delete'
  | 'category_create'
  | 'category_update'
  | 'category_delete'
  | 'channels_move'
  | 'role_create'
  | 'role_update'
  | 'role_delete'
  | 'roles_reorder'
  | 'member_role_add'
  | 'member_role_remove'
  | 'member_kick'
  | 'member_ban'
  | 'member_unban'
  | 'member_timeout'
  | 'member_timeout_remove'
  | 'member_nickname'
  | 'member_admin'
  | 'owner_transfer'
  | 'invite_create'
  | 'invite_reset'
  | 'message_delete';

export interface AuditEntry {
  id: string;
  action: AuditAction;
  actorId: string | null;
  targetId: string | null;
  targetName: string | null;
  details: Record<string, unknown> | null;
  createdAt: number;
}

export interface AuditPage {
  entries: AuditEntry[];
  users: Record<string, User>;
  hasMore: boolean;
}

export interface Ban {
  user: User;
  reason: string;
  createdAt: number;
  bannedBy: User | null;
}

export function getAuditLog(groupId: string, opts: { before?: string; action?: AuditAction | ''; actor?: string } = {}) {
  const params = new URLSearchParams({ limit: '50' });
  if (opts.before) params.set('before', opts.before);
  if (opts.action) params.set('action', opts.action);
  if (opts.actor) params.set('actor', opts.actor);
  return api.get<AuditPage>(`/api/groups/${groupId}/audit-log?${params}`);
}

export const listBans = (groupId: string) => api.get<Ban[]>(`/api/groups/${groupId}/bans`);
export const banMember = (groupId: string, userId: string, reason: string) => api.put(`/api/groups/${groupId}/bans/${userId}`, { reason });
export const unbanMember = (groupId: string, userId: string) => api.del(`/api/groups/${groupId}/bans/${userId}`);

/** Times someone out for `minutes` (0 ends it early). */
export async function timeoutMember(groupId: string, userId: string, minutes: number) {
  const member = await api.put<Member>(`/api/groups/${groupId}/members/${userId}/timeout`, { minutes });
  data.upsertMember(groupId, member);
  return member;
}

export const TIMEOUT_CHOICES: { label: string; minutes: number }[] = [
  { label: '60 seconds', minutes: 1 },
  { label: '5 minutes', minutes: 5 },
  { label: '10 minutes', minutes: 10 },
  { label: '1 hour', minutes: 60 },
  { label: '1 day', minutes: 24 * 60 },
  { label: '1 week', minutes: 7 * 24 * 60 },
];

export function updateGroupSettings(groupId: string, patch: { description?: string; systemChannelId?: string | null }) {
  return api.patch(`/api/groups/${groupId}`, patch);
}

export const createCategory = (groupId: string, name: string) => api.post<ChannelCategory>(`/api/groups/${groupId}/categories`, { name });
export const renameCategory = (groupId: string, categoryId: string, name: string) =>
  api.patch<ChannelCategory>(`/api/groups/${groupId}/categories/${categoryId}`, { name });
export const deleteCategory = (groupId: string, categoryId: string) => api.del(`/api/groups/${groupId}/categories/${categoryId}`);
export const moveChannelToCategory = (channelId: string, categoryId: string | null) => api.patch(`/api/channels/${channelId}`, { categoryId });

/**
 * Saves a rearranged channel list: categories top to bottom, and every channel top to bottom with
 * the category it's in. It shows straight away and goes back if the server says no.
 */
export async function saveLayout(groupId: string, categoryIds: string[], channels: { id: string; categoryId: string | null }[]) {
  const s = useData.getState();
  const g = s.groups[groupId];
  if (!g) return;
  const undo = {
    groupId,
    categories: g.categories,
    channels: g.channelIds.map((id) => ({ id, categoryId: s.channels[id]?.categoryId ?? null, position: s.channels[id]?.position ?? 0 })),
  };
  const byId = new Map(g.categories.map((c) => [c.id, c]));
  data.applyLayout({
    groupId,
    categories: categoryIds.flatMap((id, i) => {
      const c = byId.get(id);
      return c ? [{ ...c, position: i }] : [];
    }),
    channels: channels.map((c, i) => ({ ...c, position: i })),
  });
  try {
    await api.put(`/api/groups/${groupId}/layout`, { categories: categoryIds, channels });
  } catch (err) {
    data.applyLayout(undo);
    throw err;
  }
}

/** The channel list in display order: channels without a category first, then each category's. */
export function channelLayout(groupId: string) {
  const s = useData.getState();
  const g = s.groups[groupId];
  if (!g) return { categories: [] as string[], channels: [] as { id: string; categoryId: string | null }[] };
  const known = new Set(g.categories.map((c) => c.id));
  const catOf = (id: string) => {
    const c = s.channels[id]?.categoryId ?? null;
    return c && known.has(c) ? c : null;
  };
  const ordered = [
    ...g.channelIds.filter((id) => catOf(id) === null),
    ...g.categories.flatMap((cat) => g.channelIds.filter((id) => catOf(id) === cat.id)),
  ];
  return { categories: g.categories.map((c) => c.id), channels: ordered.map((id) => ({ id, categoryId: catOf(id) })) };
}
