import { memo, useMemo } from 'react';
import { Crown, ShieldStar } from '@phosphor-icons/react';
import { memberColor } from '../lib/perms';
import { EmojiText } from '../lib/twemoji';
import { useData, displayNameIn } from '../store/data';
import { ui } from '../store/ui';
import { Avatar, Tooltip } from './ui';
import { openMemberMenu } from './memberMenu';

const MemberRow = memo(function MemberRow({ userId, groupId }: { userId: string; groupId: string }) {
  const user = useData((s) => s.users[userId]);
  const name = useData((s) => displayNameIn(s, userId, groupId));
  const color = useData((s) => memberColor(s, groupId, userId));
  const presence = useData((s) => s.presences[userId] ?? 'offline');
  const role = useData((s) => s.groups[groupId]?.members[userId]?.role);
  return (
    <div
      className={`member-row${presence === 'offline' ? ' is-offline' : ''}`}
      role="button"
      tabIndex={0}
      onClick={(e) => ui.showProfile(userId, e.currentTarget, groupId)}
      onContextMenu={(e) => openMemberMenu(e, userId, groupId)}
    >
      <Avatar user={user} size={34} presence={presence} />
      <div className="member-text">
        <span className="member-name">
          <span className="truncate" style={{ color }}>
            {name}
          </span>
          {role === 'owner' && (
            <Tooltip label="Group owner">
              <Crown size={14} weight="fill" className="role-crown" />
            </Tooltip>
          )}
          {role === 'admin' && (
            <Tooltip label="Admin">
              <ShieldStar size={14} weight="fill" className="role-shield" />
            </Tooltip>
          )}
        </span>
        {user?.customStatus && (
          <span className="member-sub truncate">
            <EmojiText text={user.customStatus} />
          </span>
        )}
      </div>
    </div>
  );
});

/** Discord-style member list: hoisted roles get their own sections, then Online, then Offline. */
export function MemberList({ groupId }: { groupId: string }) {
  const members = useData((s) => s.groups[groupId]?.members);
  const roles = useData((s) => s.groups[groupId]?.roles);
  const presences = useData((s) => s.presences);
  const users = useData((s) => s.users);

  const sections = useMemo(() => {
    const s = useData.getState();
    const hoisted = Object.values(roles ?? {})
      .filter((r) => r.hoist)
      .sort((a, b) => b.position - a.position);
    const byRole = new Map<string, string[]>(hoisted.map((r) => [r.id, []]));
    const online: string[] = [];
    const offline: string[] = [];
    const name = (id: string) => displayNameIn(s, id, groupId).toLowerCase();
    for (const m of Object.values(members ?? {})) {
      if (!presences[m.userId]) {
        offline.push(m.userId);
        continue;
      }
      const top = hoisted.find((r) => m.roles.includes(r.id));
      if (top) byRole.get(top.id)!.push(m.userId);
      else online.push(m.userId);
    }
    const sort = (list: string[]) => list.sort((a, b) => name(a).localeCompare(name(b)));
    const out: { key: string; label: string; ids: string[] }[] = [];
    for (const r of hoisted) {
      const ids = byRole.get(r.id)!;
      if (ids.length) out.push({ key: r.id, label: r.name, ids: sort(ids) });
    }
    if (online.length) out.push({ key: 'online', label: 'Online', ids: sort(online) });
    if (offline.length) out.push({ key: 'offline', label: 'Offline', ids: sort(offline) });
    return out;
    // users is a dependency so nickname/name changes re-sort
  }, [members, roles, presences, users, groupId]);

  return (
    <aside className="members">
      <div className="members-scroll scroll">
        {sections.map((sec) => (
          <div key={sec.key}>
            <div className="members-section">
              {sec.label} — {sec.ids.length}
            </div>
            {sec.ids.map((id) => (
              <MemberRow key={id} userId={id} groupId={groupId} />
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
