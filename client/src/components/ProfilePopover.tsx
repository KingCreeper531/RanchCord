import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChatCircle, Crown, DotsThree, Phone, Prohibit, ShieldStar, UserMinus, UserPlus, Check, PencilSimple, Plus, X } from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { PERM, can, memberColor, topPosition } from '../lib/perms';
import { call } from '../calls/manager';
import { acceptFriend, blockUser, fetchProfile, kickMember, openDm, removeRelationship, sendFriendRequest, setMemberHasRole, setMemberRole } from '../lib/actions';
import { errorMessage } from '../lib/api';
import { formatShortDate } from '../lib/format';
import { isMobileDevice } from '../lib/platform';
import { fileUrl } from '../lib/server';
import { Markdown } from '../lib/markdown';
import { EmojiText } from '../lib/twemoji';
import { useData, displayNameIn } from '../store/data';
import { ui, useUi } from '../store/ui';
import { REL } from '../types';
import { Avatar, Button, IconButton, openMenu, placeFloating, presenceLabel } from './ui';

function ProfileCard({ userId, groupId }: { userId: string; groupId?: string | null }) {
  const user = useData((s) => s.users[userId]);
  const me = useData((s) => s.me!);
  const presence = useData((s) => s.presences[userId] ?? (userId === me.id ? (me.status === 'invisible' ? 'offline' : me.status) : 'offline'));
  const rel = useData((s) => s.relationships[userId]?.type);
  const name = useData((s) => displayNameIn(s, userId, groupId));
  const member = useData((s) => (groupId ? s.groups[groupId]?.members[userId] : undefined));
  const myRole = useData((s) => (groupId ? s.groups[groupId]?.members[me.id]?.role : undefined));
  const groups = useData((s) => s.groups);
  const [extra, setExtra] = useState<{ mutualFriends: string[]; mutualGroups: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const isMe = userId === me.id;

  useEffect(() => {
    if (isMe) return;
    let cancelled = false;
    fetchProfile(userId)
      .then((r) => {
        if (cancelled) return;
        setExtra({ mutualFriends: r.mutualFriends, mutualGroups: r.mutualGroups });
        useData.setState((s) => ({ users: { ...s.users, [r.user.id]: { ...s.users[r.user.id], ...r.user } } }));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId, isMe]);

  if (!user) return null;
  const banner = user.banner ? fileUrl(user.banner) : null;
  const theme = user.accentColor
    ? { background: `linear-gradient(180deg, ${user.bannerColor} 0%, ${user.accentColor} 100%)` }
    : undefined;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };

  const canKick = Boolean(groupId && member && !isMe && can(useData.getState(), groupId, PERM.KICK_MEMBERS) && topPosition(useData.getState(), groupId, me.id) > topPosition(useData.getState(), groupId, userId) && member.role !== 'owner');
  const canModerate = canKick || (myRole === 'owner' && !isMe && Boolean(member));

  return (
    <div className={`profile${user.accentColor ? ' has-theme' : ''}`} style={theme}>
      <div className="profile-banner" style={{ background: banner ? undefined : user.bannerColor }}>
        {banner && <img src={banner} alt="" />}
      </div>
      <div className="profile-avatar">
        <Avatar user={user} size={84} presence={presence} />
      </div>
      {!isMe && (
        <div className="profile-top-actions">
          {rel === REL.FRIEND && (
            <span className="profile-friend-pill">
              <Check size={12} weight="bold" /> Friends
            </span>
          )}
          <IconButton
            label="More"
            onClick={(e) =>
              openMenu(e.currentTarget.getBoundingClientRect(), [
                ...(rel === REL.FRIEND
                  ? [{ label: 'Remove friend', icon: <UserMinus size={16} />, danger: true, onSelect: () => void act(() => removeRelationship(userId)) }]
                  : []),
                rel === REL.BLOCKED
                  ? { label: 'Unblock', onSelect: () => void act(() => removeRelationship(userId)) }
                  : { label: 'Block', icon: <Prohibit size={16} />, danger: true, onSelect: () => void act(() => blockUser(userId)) },
                ...(canModerate
                  ? [
                      { separator: true as const },
                      ...(myRole === 'owner' && member!.role !== 'owner'
                        ? [
                            member!.role === 'admin'
                              ? { label: 'Remove admin', onSelect: () => void act(() => setMemberRole(groupId!, userId, 'member')) }
                              : { label: 'Make admin', icon: <ShieldStar size={16} />, onSelect: () => void act(() => setMemberRole(groupId!, userId, 'admin')) },
                          ]
                        : []),
                      ...(canKick ? [{
                        label: `Kick ${name}`,
                        danger: true,
                        onSelect: () =>
                          ui.openModal('confirm', {
                            title: `Kick ${name}?`,
                            body: 'They can come back if someone invites them again.',
                            confirmLabel: 'Kick',
                            danger: true,
                            onConfirm: () => kickMember(groupId!, userId),
                          }),
                      }] : []),
                    ]
                  : []),
              ], 'end')
            }
          >
            <DotsThree size={20} weight="bold" />
          </IconButton>
        </div>
      )}
      <div className="profile-body">
        <div className="profile-names">
          <h3 style={{ color: groupId ? memberColor(useData.getState(), groupId, userId) : undefined }}>
            {name}
            {member?.role === 'owner' && <Crown size={16} weight="fill" className="role-crown" />}
            {member?.role === 'admin' && <ShieldStar size={16} weight="fill" className="role-shield" />}
          </h3>
          <span className="profile-username">{user.username}</span>
          {name !== user.displayName && <span className="profile-username">aka {user.displayName}</span>}
        </div>
        {user.customStatus && (
          <div className="profile-status">
            <EmojiText text={user.customStatus} />
          </div>
        )}
        <div className="profile-section">
          <span className="ui-section-label">{presenceLabel[presence]}</span>
        </div>
        {groupId && member && <ProfileRoles groupId={groupId} userId={userId} />}
        {user.bio && (
          <div className="profile-section">
            <span className="ui-section-label">About me</span>
            <div className="profile-bio">
              <Markdown content={user.bio} />
            </div>
          </div>
        )}
        <div className="profile-section">
          <span className="ui-section-label">Member since</span>
          <span className="profile-since">{formatShortDate(user.createdAt)}</span>
        </div>
        {extra && (extra.mutualGroups.length > 0 || extra.mutualFriends.length > 0) && (
          <div className="profile-mutuals">
            {extra.mutualGroups.length > 0 && (
              <span>
                {extra.mutualGroups.length} mutual group{extra.mutualGroups.length === 1 ? '' : 's'}
                {extra.mutualGroups.length <= 2 && `: ${extra.mutualGroups.map((g) => groups[g]?.name).filter(Boolean).join(', ')}`}
              </span>
            )}
            {extra.mutualFriends.length > 0 && <span>{extra.mutualFriends.length} mutual friend{extra.mutualFriends.length === 1 ? '' : 's'}</span>}
          </div>
        )}
        <div className="profile-actions">
          {isMe ? (
            <Button block variant="secondary" icon={<PencilSimple size={16} />} onClick={() => ui.openModal('settings', { tab: 'profile' })}>
              Edit profile
            </Button>
          ) : (
            <>
              {(rel === REL.FRIEND || groupId) && rel !== REL.BLOCKED && (
                <Button block icon={<ChatCircle size={16} weight="fill" />} loading={busy} onClick={() => void act(() => openDm(userId))}>
                  Message
                </Button>
              )}
              {rel === REL.FRIEND && (
                <IconButton
                  label="Call"
                  size={38}
                  className="profile-call"
                  onClick={() =>
                    void act(async () => {
                      await openDm(userId);
                      const ch = Object.values(useData.getState().channels).find((c) => c.type === 'dm' && c.recipientId === userId);
                      if (ch) await call.join(ch.id);
                    })
                  }
                >
                  <Phone size={18} weight="fill" />
                </IconButton>
              )}
              {rel === undefined && (
                <Button block variant="secondary" icon={<UserPlus size={16} weight="bold" />} loading={busy} onClick={() => void act(() => sendFriendRequest(user.username))}>
                  Add friend
                </Button>
              )}
              {rel === REL.INCOMING && (
                <Button block variant="secondary" loading={busy} onClick={() => void act(() => acceptFriend(userId))}>
                  Accept request
                </Button>
              )}
              {rel === REL.OUTGOING && (
                <Button block variant="secondary" disabled>
                  Request sent
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProfileRoles({ groupId, userId }: { groupId: string; userId: string }) {
  const roleIds = useData(useShallow((s) => s.groups[groupId]?.members[userId]?.roles ?? []));
  const roleMap = useData((s) => s.groups[groupId]?.roles);
  const canManage = useData((s) => can(s, groupId, PERM.MANAGE_ROLES));
  const myTop = useData((s) => topPosition(s, groupId, s.me!.id));
  const roles = roleIds
    .map((id) => roleMap?.[id])
    .filter((r): r is NonNullable<typeof r> => Boolean(r))
    .sort((a, b) => b.position - a.position);
  const all = Object.values(roleMap ?? {}).sort((a, b) => b.position - a.position);
  if (!roles.length && !(canManage && all.length)) return null;
  const toggle = (roleId: string, on: boolean) =>
    void setMemberHasRole(groupId, userId, roleId, on).catch((err) => ui.toast(errorMessage(err), 'error'));
  return (
    <div className="profile-section">
      <span className="ui-section-label">Roles</span>
      <div className="role-chips">
        {roles.map((r) => (
          <span key={r.id} className="role-chip">
            {canManage && r.position < myTop ? (
              <button className="role-dot role-dot-btn" style={{ background: r.color ?? 'var(--text-4)' }} onClick={() => toggle(r.id, false)} aria-label={`Remove ${r.name}`}>
                <X size={9} weight="bold" />
              </button>
            ) : (
              <span className="role-dot" style={{ background: r.color ?? 'var(--text-4)' }} />
            )}
            {r.name}
          </span>
        ))}
        {canManage && all.some((r) => !roleIds.includes(r.id) && r.position < myTop) && (
          <button
            className="role-chip role-chip-add"
            aria-label="Add role"
            onClick={(e) =>
              openMenu(
                e.currentTarget.getBoundingClientRect(),
                all
                  .filter((r) => !roleIds.includes(r.id) && r.position < myTop)
                  .map((r) => ({ label: r.name, onSelect: () => toggle(r.id, true) })),
              )
            }
          >
            <Plus size={12} weight="bold" />
          </button>
        )}
      </div>
    </div>
  );
}

export function ProfilePopoverHost() {
  const popover = useUi((s) => s.popover);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useLayoutEffect(() => {
    if (!popover || !ref.current || isMobileDevice) return setPos(null);
    const el = ref.current;
    const r = popover.rect;
    const side = r.left > window.innerWidth / 2 ? 'left' : 'right';
    const p = placeFloating(r, { width: el.offsetWidth, height: el.offsetHeight }, side, 12, 'start');
    setPos({ left: p.left, top: p.top });
  }, [popover]);

  useEffect(() => {
    if (!popover) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current?.contains(t) || t.closest('.ui-menu') || t.closest('.ui-modal-layer')) return;
      ui.closePopover();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && ui.closePopover();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [popover]);

  if (!popover) return null;
  return createPortal(
    <>
      {isMobileDevice && <div className="profile-scrim" />}
      <div
        ref={ref}
        className={`profile-pop${isMobileDevice ? ' is-sheet' : ''}`}
        style={isMobileDevice ? undefined : { left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
      >
        <ProfileCard userId={popover.userId} groupId={popover.groupId} />
      </div>
    </>,
    document.body,
  );
}
