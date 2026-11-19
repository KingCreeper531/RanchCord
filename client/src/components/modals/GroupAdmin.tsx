import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ArrowsDownUp,
  ChatTeardropText,
  Crown,
  Gavel,
  Hash,
  Hourglass,
  LinkSimple,
  MagnifyingGlass,
  PencilSimple,
  Prohibit,
  ShieldStar,
  SignOut,
  Tag,
  Trash,
  UserMinus,
  UserPlus,
} from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { kickMember, setMemberHasRole, setMemberRole, transferOwnership } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { formatFull, formatShortDate, formatTimestamp } from '../../lib/format';
import {
  TIMEOUT_CHOICES,
  banMember,
  createCategory,
  getAuditLog,
  listBans,
  renameCategory,
  timeoutMember,
  unbanMember,
  updateGroupSettings,
  type AuditAction,
  type AuditEntry,
  type Ban,
} from '../../lib/groupAdmin';
import { PERM, PERM_INFO, can, memberColor, topPosition } from '../../lib/perms';
import { displayNameIn, useData } from '../../store/data';
import { ui } from '../../store/ui';
import type { ChannelCategory, User } from '../../types';
import { Avatar, Button, ModalFrame, Spinner, TextField, openMenu, type MenuItem } from '../ui';

const showError = (err: unknown) => ui.toast(errorMessage(err), 'error');

/* ---------------- overview: description and join messages ---------------- */

export function GroupDetailsSection({ groupId }: { groupId: string }) {
  const group = useData((s) => s.groups[groupId]);
  // useShallow: a fresh array from the store each time would re-render forever.
  const textIds = useData(useShallow((s) => (s.groups[groupId]?.channelIds ?? []).filter((id) => s.channels[id]?.type === 'text')));
  const channels = useData((s) => s.channels);
  const textChannels = textIds.map((id) => channels[id]).filter(Boolean);
  const [description, setDescription] = useState(group?.description ?? '');
  const [busy, setBusy] = useState(false);
  if (!group) return null;
  const join = group.systemChannelId ?? '';
  return (
    <div className="gs-details">
      <div className="ui-field">
        <label className="ui-field-label" htmlFor="gs-description">
          Description
        </label>
        <textarea
          id="gs-description"
          className="ui-textarea"
          value={description}
          maxLength={300}
          placeholder="What's this group about? People see this on invites."
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="ui-row">
        <Button
          size="sm"
          loading={busy}
          disabled={description.trim() === group.description}
          onClick={async () => {
            setBusy(true);
            try {
              await updateGroupSettings(groupId, { description: description.trim() });
              ui.toast('Saved', 'success');
            } catch (err) {
              showError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          Save description
        </Button>
      </div>
      <div className="ui-field">
        <label className="ui-field-label" htmlFor="gs-join">
          "Joined the group" messages
        </label>
        <select
          id="gs-join"
          className="ui-select"
          value={join}
          onChange={(e) => {
            const v = e.target.value;
            void updateGroupSettings(groupId, { systemChannelId: v === '' ? null : v })
              .then(() => ui.toast('Saved', 'success'))
              .catch(showError);
          }}
        >
          <option value="">In the first text channel</option>
          {textChannels.map((c) => (
            <option key={c!.id} value={c!.id}>
              #{c!.name}
            </option>
          ))}
          <option value="off">Don't post them</option>
        </select>
      </div>
    </div>
  );
}

/* ---------------- members ---------------- */

function timeLeft(until: number) {
  const mins = Math.max(1, Math.round((until - Date.now()) / 60000));
  if (mins < 60) return `${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

export function MembersTab({ groupId, onRoles }: { groupId: string; onRoles: () => void }) {
  const group = useData((s) => s.groups[groupId]);
  const meId = useData((s) => s.me!.id);
  const users = useData((s) => s.users);
  const myTop = useData((s) => topPosition(s, groupId, s.me!.id));
  const canRoles = useData((s) => can(s, groupId, PERM.MANAGE_ROLES));
  const canKick = useData((s) => can(s, groupId, PERM.KICK_MEMBERS));
  const canBan = useData((s) => can(s, groupId, PERM.BAN_MEMBERS));
  const canTimeout = useData((s) => can(s, groupId, PERM.MODERATE_MEMBERS));
  const [query, setQuery] = useState('');
  const [, tick] = useState(0);

  // Keep "timed out for 4 min" counting down.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const roles = useMemo(() => Object.values(group?.roles ?? {}).sort((a, b) => b.position - a.position), [group?.roles]);
  const members = useMemo(() => {
    const s = useData.getState();
    const q = query.trim().toLowerCase();
    return Object.values(group?.members ?? {})
      .map((m) => ({
        m,
        name: displayNameIn(s, m.userId, groupId),
        user: users[m.userId],
        top: topPosition(s, groupId, m.userId),
        color: memberColor(s, groupId, m.userId),
      }))
      .filter((x) => !q || x.name.toLowerCase().includes(q) || x.user?.username.toLowerCase().includes(q))
      .sort((a, b) => b.top - a.top || a.name.localeCompare(b.name));
  }, [group?.members, users, groupId, query, group?.roles]);
  if (!group) return null;
  const role = group.members[meId]?.role;

  const roleMenu = (rect: DOMRect, userId: string) => {
    const has = new Set(useData.getState().groups[groupId]?.members[userId]?.roles ?? []);
    openMenu(
      rect,
      roles.length
        ? [
            { header: 'Roles' },
            ...roles.map((r) => ({
              label: r.name,
              checked: has.has(r.id),
              disabled: r.position >= myTop,
              onSelect: () => void setMemberHasRole(groupId, userId, r.id, !has.has(r.id)).catch(showError),
            })),
          ]
        : [{ header: 'No roles yet' }, { label: 'Create a role', onSelect: onRoles }],
      'end',
    );
  };

  return (
    <div className="gs-members-wrap">
      <TextField
        prefix={<MagnifyingGlass size={16} />}
        placeholder={`Search ${members.length === 1 ? 'members' : `${Object.keys(group.members).length} members`}`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="gs-members">
        {members.map(({ m, name: n, user, top, color }) => {
          const outranked = top < myTop && m.userId !== meId && m.role !== 'owner';
          const isAdmin = m.role === 'owner' || m.role === 'admin';
          const timedOut = Boolean(m.timeoutUntil && m.timeoutUntil > Date.now());
          const items: MenuItem[] = [];
          if (role === 'owner' && m.userId !== meId) {
            items.push(
              m.role === 'admin'
                ? { label: 'Remove admin', onSelect: () => void setMemberRole(groupId, m.userId, 'member').catch(showError) }
                : { label: 'Make admin', icon: <ShieldStar size={16} />, onSelect: () => void setMemberRole(groupId, m.userId, 'admin').catch(showError) },
              {
                label: 'Transfer ownership',
                icon: <Crown size={16} />,
                onSelect: () =>
                  ui.openModal('confirm', {
                    title: `Make ${n} the owner?`,
                    body: `${n} will own ${group.name}. You'll become an admin.`,
                    confirmLabel: 'Transfer',
                    onConfirm: () => transferOwnership(groupId, m.userId),
                  }),
              },
            );
          }
          if (outranked && canTimeout && !isAdmin) {
            if (items.length) items.push({ separator: true });
            if (timedOut) {
              items.push({ label: 'Remove timeout', icon: <Hourglass size={16} />, onSelect: () => void timeoutMember(groupId, m.userId, 0).catch(showError) });
            } else {
              items.push(
                { header: `Time out ${n}` },
                ...TIMEOUT_CHOICES.map((c) => ({
                  label: c.label,
                  onSelect: () =>
                    void timeoutMember(groupId, m.userId, c.minutes)
                      .then(() => ui.toast(`${n} is timed out for ${c.label}`, 'success'))
                      .catch(showError),
                })),
              );
            }
          }
          if (outranked && (canKick || canBan)) {
            if (items.length) items.push({ separator: true });
            if (canKick) {
              items.push({
                label: `Kick ${n}`,
                danger: true,
                icon: <UserMinus size={16} />,
                onSelect: () =>
                  ui.openModal('confirm', {
                    title: `Kick ${n}?`,
                    body: 'They can come back if someone invites them again.',
                    confirmLabel: 'Kick',
                    danger: true,
                    onConfirm: () => kickMember(groupId, m.userId),
                  }),
              });
            }
            if (canBan) {
              items.push({
                label: `Ban ${n}`,
                danger: true,
                icon: <Prohibit size={16} />,
                onSelect: () => ui.openModal('ban', { groupId, userId: m.userId, name: n }),
              });
            }
          }
          return (
            <div key={m.userId} className="gs-member">
              <Avatar user={user} size={36} />
              <div className="gs-member-text">
                <strong className="truncate" style={{ color }}>
                  {n}
                  {m.role === 'owner' && <Crown size={14} weight="fill" className="role-crown" />}
                  {m.role === 'admin' && <ShieldStar size={14} weight="fill" className="role-shield" />}
                </strong>
                <span className="gs-member-roles">
                  {timedOut && (
                    <span className="gs-flag" title={`Until ${formatFull(m.timeoutUntil!)}`}>
                      <Hourglass size={12} weight="bold" /> Timed out · {timeLeft(m.timeoutUntil!)}
                    </span>
                  )}
                  {m.roles
                    .map((id) => group.roles[id])
                    .filter(Boolean)
                    .sort((a, b) => b!.position - a!.position)
                    .map((r) => (
                      <span key={r!.id} className="role-chip">
                        <span className="role-dot" style={{ background: r!.color ?? 'var(--text-4)' }} />
                        {r!.name}
                      </span>
                    ))}
                  <span className="gs-member-meta">
                    {user?.username} · joined {formatShortDate(m.joinedAt)}
                  </span>
                </span>
              </div>
              {canRoles && roles.length > 0 && (
                <Button size="sm" variant="ghost" onClick={(e) => roleMenu(e.currentTarget.getBoundingClientRect(), m.userId)}>
                  Roles
                </Button>
              )}
              {items.length > 0 && (
                <Button size="sm" variant="secondary" onClick={(e) => openMenu(e.currentTarget.getBoundingClientRect(), items, 'end')}>
                  Manage
                </Button>
              )}
            </div>
          );
        })}
        {members.length === 0 && <div className="side-hint">Nobody matches "{query}"</div>}
      </div>
    </div>
  );
}

export function BanModal({ groupId, userId, name, onClose }: { groupId: string; userId: string; name: string; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <ModalFrame
      title={`Ban ${name}?`}
      subtitle="They're removed from the group and can't come back, even with an invite, until someone unbans them."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await banMember(groupId, userId, reason.trim());
                ui.toast(`${name} is banned`, 'success');
                onClose();
              } catch (err) {
                showError(err);
                setBusy(false);
              }
            }}
          >
            Ban
          </Button>
        </>
      }
    >
      <TextField label="Reason (optional)" value={reason} maxLength={300} placeholder="Only people who can ban will see this" onChange={(e) => setReason(e.target.value)} />
    </ModalFrame>
  );
}

/* ---------------- bans ---------------- */

export function BansTab({ groupId }: { groupId: string }) {
  const [bans, setBans] = useState<Ban[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () =>
    listBans(groupId)
      .then(setBans)
      .catch((err) => setError(errorMessage(err)));
  useEffect(() => {
    void load();
  }, [groupId]);
  if (error) return <div className="form-error">{error}</div>;
  if (!bans)
    return (
      <div className="gs-loading">
        <Spinner />
      </div>
    );
  if (!bans.length) {
    return (
      <div className="gs-empty">
        <Prohibit size={32} weight="duotone" />
        <p>Nobody is banned. Ban people from the Members tab.</p>
      </div>
    );
  }
  return (
    <div className="gs-bans">
      {bans.map((b) => (
        <div key={b.user.id} className="gs-member">
          <Avatar user={b.user} size={36} />
          <div className="gs-member-text">
            <strong className="truncate">{b.user.displayName}</strong>
            <span className="gs-member-meta">
              {b.reason ? `"${b.reason}" · ` : ''}
              {b.bannedBy ? `by ${b.bannedBy.displayName} · ` : ''}
              {formatShortDate(b.createdAt)}
            </span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void unbanMember(groupId, b.user.id)
                .then(() => {
                  ui.toast(`${b.user.displayName} can join again`, 'success');
                  return load();
                })
                .catch(showError)
            }
          >
            Unban
          </Button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- audit log ---------------- */

const ACTION_FILTERS: { value: AuditAction | ''; label: string }[] = [
  { value: '', label: 'Everything' },
  { value: 'member_kick', label: 'Kicks' },
  { value: 'member_ban', label: 'Bans' },
  { value: 'member_unban', label: 'Unbans' },
  { value: 'member_timeout', label: 'Timeouts' },
  { value: 'member_role_add', label: 'Roles given' },
  { value: 'member_role_remove', label: 'Roles taken away' },
  { value: 'role_update', label: 'Role changes' },
  { value: 'channel_create', label: 'New channels' },
  { value: 'channel_update', label: 'Channel changes' },
  { value: 'channel_delete', label: 'Deleted channels' },
  { value: 'channels_move', label: 'Rearranging channels' },
  { value: 'message_delete', label: 'Deleted messages' },
  { value: 'group_update', label: 'Group changes' },
  { value: 'invite_create', label: 'Invite links' },
];

const permName = (bit: number) => PERM_INFO.find((p) => p.bit === bit)?.name ?? 'a permission';

function duration(minutes: number) {
  return TIMEOUT_CHOICES.find((c) => c.minutes === minutes)?.label ?? `${minutes} minutes`;
}

const strong = (text: string | null | undefined) => <strong>{text || 'someone'}</strong>;

/** "Alex kicked Sam", plus a few lines about what changed. */
function describe(e: AuditEntry, users: Record<string, User>, groupId: string): { icon: ReactNode; text: ReactNode; lines: string[] } {
  const s = useData.getState();
  const nameOf = (id: string | null, fallback?: string | null) =>
    id && s.groups[groupId]?.members[id] ? displayNameIn(s, id, groupId) : (id && users[id]?.displayName) || fallback || 'someone';
  const actor = strong(nameOf(e.actorId));
  const target = strong(nameOf(e.targetId, e.targetName));
  const d = (e.details ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const change = (key: string, label: string, fmt = (v: unknown) => (v === null || v === '' ? 'nothing' : String(v))) => {
    const v = d[key] as [unknown, unknown] | undefined;
    if (Array.isArray(v)) lines.push(`${label}: ${fmt(v[0])} → ${fmt(v[1])}`);
  };
  const perms = d.permissions as { added?: number[]; removed?: number[] } | undefined;
  if (perms?.added?.length) lines.push(`Allowed: ${perms.added.map(permName).join(', ')}`);
  if (perms?.removed?.length) lines.push(`Took away: ${perms.removed.map(permName).join(', ')}`);
  const plain = e.targetName ?? '';
  switch (e.action) {
    case 'group_update':
      change('name', 'Name');
      change('description', 'Description');
      change('joinMessages', 'Join messages', (v) => (v === 'off' ? 'off' : v ? String(v) : 'first text channel'));
      if (d.icon) lines.push(d.icon === 'removed' ? 'Removed the icon' : 'Changed the icon');
      return { icon: <PencilSimple size={18} />, text: <>{actor} changed the group's settings</>, lines };
    case 'channel_create':
      return { icon: <Hash size={18} />, text: <>{actor} created {d.type === 'voice' ? 'the voice channel ' : '#'}{strong(plain)}</>, lines };
    case 'channel_update':
      change('name', 'Name');
      change('topic', 'Topic');
      change('category', 'Category', (v) => (v ? String(v) : 'no category'));
      return { icon: <Hash size={18} />, text: <>{actor} edited {strong(plain)}</>, lines };
    case 'channel_delete':
      return { icon: <Trash size={18} />, text: <>{actor} deleted {d.type === 'voice' ? 'the voice channel ' : '#'}{strong(plain)}</>, lines };
    case 'category_create':
      return { icon: <Tag size={18} />, text: <>{actor} created the category {strong(plain)}</>, lines };
    case 'category_update':
      change('name', 'Name');
      return { icon: <Tag size={18} />, text: <>{actor} renamed a category</>, lines };
    case 'category_delete':
      return { icon: <Tag size={18} />, text: <>{actor} deleted the category {strong(plain)}</>, lines };
    case 'channels_move':
      return { icon: <ArrowsDownUp size={18} />, text: <>{actor} rearranged the channel list</>, lines };
    case 'role_create':
      return { icon: <ShieldStar size={18} />, text: <>{actor} created the role {strong(plain)}</>, lines };
    case 'role_update':
      change('name', 'Name');
      change('color', 'Color');
      change('hoist', 'Shown separately', (v) => (v ? 'yes' : 'no'));
      change('mentionable', 'Anyone can @mention it', (v) => (v ? 'yes' : 'no'));
      return { icon: <ShieldStar size={18} />, text: <>{actor} updated {plain === '@everyone' ? strong('@everyone') : <>the role {strong(plain)}</>}</>, lines };
    case 'role_delete':
      return { icon: <ShieldStar size={18} />, text: <>{actor} deleted the role {strong(plain)}</>, lines };
    case 'roles_reorder':
      return { icon: <ArrowsDownUp size={18} />, text: <>{actor} reordered the roles</>, lines };
    case 'member_role_add':
      return { icon: <ShieldStar size={18} />, text: <>{actor} gave {target} the {strong(String(d.role ?? ''))} role</>, lines };
    case 'member_role_remove':
      return { icon: <ShieldStar size={18} />, text: <>{actor} took the {strong(String(d.role ?? ''))} role from {target}</>, lines };
    case 'member_kick':
      return { icon: <SignOut size={18} />, text: <>{actor} kicked {target}</>, lines };
    case 'member_ban':
      if (d.reason) lines.push(`Reason: ${String(d.reason)}`);
      return { icon: <Gavel size={18} />, text: <>{actor} banned {target}</>, lines };
    case 'member_unban':
      return { icon: <Gavel size={18} />, text: <>{actor} unbanned {target}</>, lines };
    case 'member_timeout':
      return { icon: <Hourglass size={18} />, text: <>{actor} timed out {target} for {duration(Number(d.minutes))}</>, lines };
    case 'member_timeout_remove':
      return { icon: <Hourglass size={18} />, text: <>{actor} ended {target}'s timeout</>, lines };
    case 'member_nickname':
      change('nickname', 'Nickname');
      return { icon: <PencilSimple size={18} />, text: <>{actor} changed {target}'s nickname</>, lines };
    case 'member_admin': {
      const v = d.role as [string, string] | undefined;
      return { icon: <ShieldStar size={18} />, text: v?.[1] === 'admin' ? <>{actor} made {target} an admin</> : <>{actor} removed admin from {target}</>, lines };
    }
    case 'owner_transfer':
      return { icon: <Crown size={18} />, text: <>{actor} made {target} the owner</>, lines };
    case 'invite_create':
      return { icon: <UserPlus size={18} />, text: <>{actor} made an invite link</>, lines };
    case 'invite_reset':
      return { icon: <LinkSimple size={18} />, text: <>{actor} reset their invite link</>, lines };
    case 'message_delete':
      return { icon: <ChatTeardropText size={18} />, text: <>{actor} deleted a message from {target}{d.channel ? <> in {strong(`#${String(d.channel)}`)}</> : null}</>, lines };
    default:
      return { icon: <PencilSimple size={18} />, text: <>{actor} changed something</>, lines };
  }
}

export function AuditLogTab({ groupId }: { groupId: string }) {
  const memberIds = useData((s) => Object.keys(s.groups[groupId]?.members ?? {}).join(','));
  const [action, setAction] = useState<AuditAction | ''>('');
  const [actor, setActor] = useState('');
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [users, setUsers] = useState<Record<string, User>>({});
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (before?: string) => {
    setLoading(true);
    setError(null);
    try {
      const page = await getAuditLog(groupId, { before, action, actor: actor || undefined });
      setEntries((prev) => (before && prev ? [...prev, ...page.entries] : page.entries));
      setUsers((prev) => ({ ...prev, ...page.users }));
      setMore(page.hasMore);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setEntries(null);
    void load();
  }, [groupId, action, actor]);

  const people = useMemo(() => {
    const s = useData.getState();
    return memberIds
      .split(',')
      .filter(Boolean)
      .map((id) => ({ id, name: displayNameIn(s, id, groupId) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [memberIds, groupId]);

  return (
    <div className="gs-audit">
      <div className="gs-filters">
        <select className="ui-select" value={action} onChange={(e) => setAction(e.target.value as AuditAction | '')} aria-label="What happened">
          {ACTION_FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <select className="ui-select" value={actor} onChange={(e) => setActor(e.target.value)} aria-label="Who did it">
          <option value="">Anyone</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      {error && <div className="form-error">{error}</div>}
      {entries === null && !error && (
        <div className="gs-loading">
          <Spinner />
        </div>
      )}
      {entries?.length === 0 && (
        <div className="gs-empty">
          <ArrowsDownUp size={32} weight="duotone" />
          <p>Nothing here yet. Changes to the group show up here, and stay for 90 days.</p>
        </div>
      )}
      {entries?.map((e) => {
        const { icon, text, lines } = describe(e, users, groupId);
        const who = e.actorId ? users[e.actorId] : undefined;
        return (
          <div key={e.id} className="gs-audit-entry">
            <span className="gs-audit-icon">{icon}</span>
            {who ? <Avatar user={who} size={28} /> : <span className="gs-audit-avatar-gap" />}
            <div className="gs-audit-text">
              <span>{text}</span>
              {lines.map((l, i) => (
                <span key={i} className="gs-audit-line">
                  {l}
                </span>
              ))}
            </div>
            <time className="gs-audit-time" title={formatFull(e.createdAt)}>
              {formatTimestamp(e.createdAt)}
            </time>
          </div>
        );
      })}
      {more && entries && (
        <div className="gs-more">
          <Button size="sm" variant="secondary" loading={loading} onClick={() => void load(entries.at(-1)?.id)}>
            Load older
          </Button>
        </div>
      )}
    </div>
  );
}

/* ---------------- categories ---------------- */

export function CategoryModal({ groupId, categoryId, onClose }: { groupId: string; categoryId?: string; onClose: () => void }) {
  const existing = useData((s) => s.groups[groupId]?.categories.find((c) => c.id === categoryId));
  const [name, setName] = useState(existing?.name ?? '');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      if (categoryId) await renameCategory(groupId, categoryId, name.trim());
      else await createCategory(groupId, name.trim());
      onClose();
    } catch (err) {
      showError(err);
      setBusy(false);
    }
  };
  return (
    <ModalFrame
      title={categoryId ? 'Rename category' : 'Create category'}
      subtitle={categoryId ? undefined : 'Categories group channels together. Drag channels into them, or pick one when editing a channel.'}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!name.trim() || name.trim() === existing?.name} onClick={() => void save()}>
            {categoryId ? 'Save' : 'Create category'}
          </Button>
        </>
      }
    >
      <TextField
        label="Category name"
        value={name}
        maxLength={48}
        autoFocus
        placeholder="Games"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void save()}
      />
    </ModalFrame>
  );
}

/** "Category" dropdown for creating and editing channels. */
const NO_CATEGORIES: ChannelCategory[] = [];

export function CategoryPicker({ groupId, value, onChange }: { groupId: string; value: string | null; onChange: (id: string | null) => void }) {
  const categories = useData((s) => s.groups[groupId]?.categories ?? NO_CATEGORIES);
  if (!categories.length) return null;
  return (
    <div className="ui-field">
      <label className="ui-field-label" htmlFor="channel-category">
        Category
      </label>
      <select id="channel-category" className="ui-select" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
        <option value="">No category (top of the list)</option>
      </select>
    </div>
  );
}
