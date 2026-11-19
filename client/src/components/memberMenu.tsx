import { At, ChatCircle, Check, CopySimple, Hourglass, IdentificationCard, Prohibit, UserMinus, UserPlus } from '@phosphor-icons/react';
import { acceptFriend, askToBlock, askToRemoveFriend, kickMember, openDm, removeRelationship, sendFriendRequest } from '../lib/actions';
import { errorMessage } from '../lib/api';
import { TIMEOUT_CHOICES, timeoutMember } from '../lib/groupAdmin';
import { PERM, can, topPosition } from '../lib/perms';
import { displayNameIn, useData } from '../store/data';
import { ui, useUi } from '../store/ui';
import { REL } from '../types';
import { openMenu, type MenuItem } from './ui';

/* Discord's right-click (or hold) menu on people: in the member list, and on names and pictures in chat. */

const showError = (err: unknown) => ui.toast(errorMessage(err), 'error');

type Where = { clientX: number; clientY: number } | DOMRect;

/** Timeout, kick and ban, for people allowed to use them on this member (empty otherwise). */
export function moderationItems(where: Where, groupId: string, userId: string): MenuItem[] {
  const s = useData.getState();
  const me = s.me;
  const group = s.groups[groupId];
  const member = group?.members[userId];
  if (!me || !member || userId === me.id || member.role === 'owner') return [];
  // Only people ranked above them can moderate them.
  if (topPosition(s, groupId, userId) >= topPosition(s, groupId, me.id)) return [];
  const name = displayNameIn(s, userId, groupId);
  const items: MenuItem[] = [];
  const pos = 'clientX' in where ? { clientX: where.clientX, clientY: where.clientY } : where;
  if (can(s, groupId, PERM.MODERATE_MEMBERS) && member.role !== 'admin') {
    if (member.timeoutUntil && member.timeoutUntil > Date.now()) {
      items.push({ label: 'Remove timeout', icon: <Hourglass size={16} />, onSelect: () => void timeoutMember(groupId, userId, 0).catch(showError) });
    } else {
      items.push({
        label: `Time out ${name}`,
        icon: <Hourglass size={16} />,
        onSelect: () =>
          openMenu(pos, [
            { header: `Time out ${name}` },
            ...TIMEOUT_CHOICES.map((c) => ({
              label: c.label,
              onSelect: () =>
                void timeoutMember(groupId, userId, c.minutes)
                  .then(() => ui.toast(`${name} is timed out for ${c.label}`, 'success'))
                  .catch(showError),
            })),
          ]),
      });
    }
  }
  if (can(s, groupId, PERM.KICK_MEMBERS)) {
    items.push({
      label: `Kick ${name}`,
      danger: true,
      icon: <UserMinus size={16} />,
      onSelect: () =>
        ui.openModal('confirm', {
          title: `Kick ${name}?`,
          body: 'They can come back if someone invites them again.',
          confirmLabel: 'Kick',
          danger: true,
          onConfirm: () => kickMember(groupId, userId),
        }),
    });
  }
  if (can(s, groupId, PERM.BAN_MEMBERS)) {
    items.push({
      label: `Ban ${name}`,
      danger: true,
      icon: <Prohibit size={16} />,
      onSelect: () => ui.openModal('ban', { groupId, userId, name }),
    });
  }
  return items;
}

/** The whole menu for a person: profile, mention, message, friend and block, then moderation. */
export function openMemberMenu(e: React.MouseEvent<HTMLElement>, userId: string, groupId: string | null) {
  e.preventDefault();
  e.stopPropagation();
  const s = useData.getState();
  const user = s.users[userId];
  const me = s.me;
  if (!user || !me) return;
  const anchor = e.currentTarget;
  const where = { clientX: e.clientX, clientY: e.clientY };
  const isMe = userId === me.id;
  const rel = s.relationships[userId]?.type;
  const route = useUi.getState().route;
  const channelId = route.kind === 'group' || route.kind === 'dm' ? route.channelId : null;
  const textChannel = channelId && s.channels[channelId]?.type !== 'voice' ? channelId : null;

  const items: MenuItem[] = [{ label: 'Profile', icon: <IdentificationCard size={16} />, onSelect: () => ui.showProfile(userId, anchor, groupId) }];
  if (textChannel) items.push({ label: 'Mention', icon: <At size={16} />, onSelect: () => ui.insertIntoComposer(textChannel, `@${user.username} `) });
  if (!isMe) {
    items.push({ label: 'Message', icon: <ChatCircle size={16} />, onSelect: () => void openDm(userId).catch(showError) });
    items.push({ separator: true });
    if (rel === REL.FRIEND) items.push({ label: 'Remove friend', icon: <UserMinus size={16} />, onSelect: () => askToRemoveFriend(userId) });
    else if (rel === REL.INCOMING) items.push({ label: 'Accept friend request', icon: <Check size={16} />, onSelect: () => void acceptFriend(userId).catch(showError) });
    else if (rel === REL.OUTGOING) items.push({ label: 'Friend request sent', disabled: true, onSelect: () => {} });
    else if (rel !== REL.BLOCKED) {
      items.push({
        label: 'Add friend',
        icon: <UserPlus size={16} />,
        onSelect: () =>
          void sendFriendRequest(user.username)
            .then(() => ui.toast(`Friend request sent to ${user.displayName}`, 'success'))
            .catch(showError),
      });
    }
    items.push(
      rel === REL.BLOCKED
        ? { label: 'Unblock', onSelect: () => void removeRelationship(userId).catch(showError) }
        : { label: 'Block', icon: <Prohibit size={16} />, danger: true, onSelect: () => askToBlock(userId) },
    );
  }
  items.push({
    label: 'Copy username',
    icon: <CopySimple size={16} />,
    onSelect: () =>
      void navigator.clipboard
        ?.writeText(user.username)
        .then(() => ui.toast('Username copied', 'success'))
        .catch(() => ui.toast("Couldn't copy", 'error')),
  });
  const mod = groupId ? moderationItems(where, groupId, userId) : [];
  if (mod.length) items.push({ separator: true }, ...mod);
  openMenu(where, items);
}
