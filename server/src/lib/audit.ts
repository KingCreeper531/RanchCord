import { run } from './db.ts';
import { newId, now } from './util.ts';

/** Everything a group's audit log records (Group settings > Audit log). */
export const AUDIT_ACTIONS = [
  'group_update',
  'channel_create',
  'channel_update',
  'channel_delete',
  'category_create',
  'category_update',
  'category_delete',
  'channels_move',
  'role_create',
  'role_update',
  'role_delete',
  'roles_reorder',
  'member_role_add',
  'member_role_remove',
  'member_kick',
  'member_ban',
  'member_unban',
  'member_timeout',
  'member_timeout_remove',
  'member_nickname',
  'member_admin',
  'owner_transfer',
  'invite_create',
  'invite_reset',
  'message_delete',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/** How long entries are kept. */
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

export interface AuditRow {
  id: string;
  group_id: string;
  actor_id: string | null;
  action: string;
  target_id: string | null;
  target_name: string | null;
  details: string | null;
  created_at: number;
}

/**
 * Records who did what in a group. `target` is what it was done to (a person, channel, role…),
 * with its name saved too so the entry still reads well after the thing is deleted. `details`
 * holds what changed, for example `{ name: ['old', 'new'] }`.
 */
export function audit(
  groupId: string,
  actorId: string,
  action: AuditAction,
  target: { id?: string | null; name?: string | null } = {},
  details: Record<string, unknown> | null = null,
) {
  const t = now();
  run(
    'INSERT INTO audit_log (id, group_id, actor_id, action, target_id, target_name, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    newId(),
    groupId,
    actorId,
    action,
    target.id ?? null,
    target.name ?? null,
    details && Object.keys(details).length ? JSON.stringify(details) : null,
    t,
  );
  run('DELETE FROM audit_log WHERE group_id = ? AND created_at < ?', groupId, t - KEEP_MS);
}

export function auditOut(r: AuditRow) {
  return {
    id: r.id,
    action: r.action,
    actorId: r.actor_id,
    targetId: r.target_id,
    targetName: r.target_name,
    details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null,
    createdAt: r.created_at,
  };
}

/** `{ field: [before, after] }` for the fields that actually changed. */
export function changes<T extends Record<string, unknown>>(before: T, after: Partial<T>): Record<string, [unknown, unknown]> {
  const out: Record<string, [unknown, unknown]> = {};
  for (const key of Object.keys(after)) {
    const next = after[key];
    if (next !== undefined && next !== before[key]) out[key] = [before[key] ?? null, next];
  }
  return out;
}
