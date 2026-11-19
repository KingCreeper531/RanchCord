import { memo, type ReactNode } from 'react';
import {
  CaretDown,
  ChatCircleText,
  Gear,
  Hash,
  Headphones,
  MagnifyingGlass,
  Microphone,
  MicrophoneSlash,
  Monitor,
  MonitorArrowUp,
  PhoneDisconnect,
  Plus,
  SignOut,
  SpeakerHigh,
  Trash,
  UserPlus,
  Users,
  VideoCamera,
  VideoCameraSlash,
  X,
  PencilSimple,
  WifiHigh,
  MusicNotes,
  Check,
  CopySimple,
  Bomb,
} from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { call } from '../calls/manager';
import { ackChannel, askToNukeDm, closeDm, deleteChannel, leaveGroup, updateProfile } from '../lib/actions';
import { formatFriendCode } from '../lib/format';
import { canShareScreen } from '../lib/platform';
import { EmojiText } from '../lib/twemoji';
import { PERM, can, memberColor } from '../lib/perms';
import { useCall } from '../store/call';
import { channelLabel, dmRecipient, isUnread, mentionCount, pendingIncoming, sortedDmIds, useData, displayNameIn } from '../store/data';
import { ui, useUi } from '../store/ui';
import type { ChosenStatus } from '../types';
import { Avatar, IconButton, PresenceDot, Tooltip, openMenu, presenceLabel } from './ui';

export function markGroupRead(groupId: string) {
  const s = useData.getState();
  for (const id of s.groups[groupId]?.channelIds ?? []) if (isUnread(s, id) || s.readStates[id]?.mentionCount) ackChannel(id);
}

/* ---------------- home (DMs) ---------------- */

const DmRow = memo(function DmRow({ channelId }: { channelId: string }) {
  const user = useData((s) => dmRecipient(s, channelId));
  const presence = useData((s) => (user ? s.presences[user.id] ?? 'offline' : 'offline'));
  const unread = useData((s) => isUnread(s, channelId));
  const mentions = useData((s) => mentionCount(s, channelId));
  const inCall = useData((s) => Boolean(s.voice[channelId] && Object.keys(s.voice[channelId]).length));
  const active = useUi((s) => s.route.kind === 'dm' && s.route.channelId === channelId);
  return (
    <div
      className={`side-row side-dm${active ? ' is-active' : ''}${unread ? ' is-unread' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => ui.navigate({ kind: 'dm', channelId })}
      onKeyDown={(e) => e.key === 'Enter' && ui.navigate({ kind: 'dm', channelId })}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e, [
          { label: 'Mark as read', disabled: !unread && !mentions, onSelect: () => ackChannel(channelId) },
          { label: 'Profile', onSelect: () => user && ui.showProfile(user.id, e.target as Element) },
          { separator: true },
          { label: 'Nuke chat', danger: true, icon: <Bomb size={16} weight="fill" />, onSelect: () => askToNukeDm(channelId) },
          { label: 'Close DM', onSelect: () => void closeDm(channelId) },
        ]);
      }}
    >
      <Avatar user={user} size={32} presence={presence} />
      <div className="side-row-text">
        <span className="side-row-name truncate">{user?.displayName ?? 'Unknown'}</span>
        {inCall ? (
          <span className="side-row-sub side-row-sub-live truncate">In a call</span>
        ) : (
          user?.customStatus && <span className="side-row-sub truncate"><EmojiText text={user.customStatus} /></span>
        )}
      </div>
      {mentions > 0 ? (
        <span className="ui-badge">{mentions}</span>
      ) : (
        <button
          className="side-row-close"
          aria-label="Close DM"
          onClick={(e) => {
            e.stopPropagation();
            void closeDm(channelId);
          }}
        >
          <X size={14} weight="bold" />
        </button>
      )}
    </div>
  );
});

function HomeSidebar() {
  const dmIds = useData(useShallow(sortedDmIds));
  const pending = useData(pendingIncoming);
  const friendsActive = useUi((s) => s.route.kind === 'friends');
  return (
    <>
      <div className="side-header side-header-search">
        <button className="side-search" onClick={() => ui.openModal('switcher')}>
          <MagnifyingGlass size={14} weight="bold" />
          Find or start a conversation
        </button>
      </div>
      <div className="side-scroll scroll">
        <div
          className={`side-row side-nav${friendsActive ? ' is-active' : ''}`}
          role="button"
          tabIndex={0}
          onClick={() => ui.navigate({ kind: 'friends' })}
        >
          <Users size={22} weight={friendsActive ? 'fill' : 'regular'} />
          <span className="side-row-name">Friends</span>
          {pending > 0 && <span className="ui-badge">{pending}</span>}
        </div>
        <div className="side-section">
          <span>Direct Messages</span>
          <Tooltip label="Create DM">
            <button className="side-section-add" onClick={() => ui.openModal('newDm')} aria-label="Create DM">
              <Plus size={14} weight="bold" />
            </button>
          </Tooltip>
        </div>
        {dmIds.map((id) => (
          <DmRow key={id} channelId={id} />
        ))}
        {dmIds.length === 0 && (
          <div className="side-empty">
            <div className="side-empty-lines">
              {[0, 1, 2].map((i) => (
                <div key={i} className="side-empty-line">
                  <span />
                  <span />
                </div>
              ))}
            </div>
            <p>Your DMs show up here. Add a friend to get started.</p>
          </div>
        )}
      </div>
    </>
  );
}

/* ---------------- group ---------------- */

function VoiceMembers({ channelId, groupId }: { channelId: string; groupId: string }) {
  const states = useData(useShallow((s) => Object.values(s.voice[channelId] ?? {})));
  const speaking = useCall((s) => s.speaking);
  const inThisCall = useCall((s) => s.channelId === channelId);
  if (!states.length) return null;
  return (
    <div className="side-voice-members">
      {states
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map((v) => (
          <VoiceMember key={v.userId} userId={v.userId} groupId={groupId} state={v} speaking={inThisCall && Boolean(speaking[v.userId])} />
        ))}
    </div>
  );
}

function VoiceMember({
  userId,
  groupId,
  state,
  speaking,
}: {
  userId: string;
  groupId: string;
  state: { muted: boolean; deafened: boolean; video: boolean; screen: boolean };
  speaking: boolean;
}) {
  const user = useData((s) => s.users[userId]);
  const name = useData((s) => displayNameIn(s, userId, groupId));
  const color = useData((s) => memberColor(s, groupId, userId));
  return (
    <div className="side-voice-member" onClick={(e) => ui.showProfile(userId, e.currentTarget, groupId)} role="button" tabIndex={0}>
      <Avatar user={user} size={24} speaking={speaking} />
      <span className="truncate" style={{ color }}>{name}</span>
      <span className="side-voice-icons">
        {state.screen && <span className="live-badge">LIVE</span>}
        {state.video && <VideoCamera size={14} weight="fill" />}
        {state.deafened ? <Headphones size={14} weight="fill" className="is-off" /> : state.muted && <MicrophoneSlash size={14} weight="fill" className="is-off" />}
      </span>
    </div>
  );
}

const ChannelRow = memo(function ChannelRow({ channelId, groupId, canManage }: { channelId: string; groupId: string; canManage: boolean }) {
  const channel = useData((s) => s.channels[channelId]);
  const unread = useData((s) => isUnread(s, channelId));
  const mentions = useData((s) => mentionCount(s, channelId));
  const active = useUi((s) => s.route.kind === 'group' && s.route.channelId === channelId);
  const connected = useCall((s) => s.channelId === channelId);
  if (!channel) return null;
  const voice = channel.type === 'voice';
  const open = () => {
    if (voice) {
      ui.navigate({ kind: 'group', groupId, channelId });
      if (!connected) void call.join(channelId);
    } else ui.navigate({ kind: 'group', groupId, channelId });
  };
  return (
    <>
      <div
        className={`side-row side-channel${active ? ' is-active' : ''}${unread && !active ? ' is-unread' : ''}${connected ? ' is-connected' : ''}`}
        role="button"
        tabIndex={0}
        onClick={open}
        onKeyDown={(e) => e.key === 'Enter' && open()}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu(e, [
            ...(voice ? [] : [{ label: 'Mark as read', disabled: !unread && !mentions, onSelect: () => ackChannel(channelId) }]),
            ...(canManage
              ? [
                  { separator: true as const },
                  { label: 'Edit channel', icon: <PencilSimple size={16} />, onSelect: () => ui.openModal('editChannel', { channelId }) },
                  {
                    label: 'Delete channel',
                    danger: true,
                    icon: <Trash size={16} />,
                    onSelect: () =>
                      ui.openModal('confirm', {
                        title: `Delete ${voice ? '' : '#'}${channel.name}?`,
                        body: 'This removes the channel and all of its messages for everyone. This cannot be undone.',
                        confirmLabel: 'Delete channel',
                        danger: true,
                        onConfirm: () => deleteChannel(channelId),
                      }),
                  },
                ]
              : []),
          ]);
        }}
      >
        {unread && !active && !voice && <span className="side-unread-dot" />}
        {voice ? <SpeakerHigh size={20} weight={connected ? 'fill' : 'regular'} /> : <Hash size={20} />}
        <span className="side-row-name truncate">{channel.name}</span>
        {mentions > 0 && <span className="ui-badge">{mentions}</span>}
        {canManage && !voice && (
          <Tooltip label="Edit channel">
            <button
              className="side-row-gear"
              onClick={(e) => {
                e.stopPropagation();
                ui.openModal('editChannel', { channelId });
              }}
              aria-label="Edit channel"
            >
              <Gear size={14} />
            </button>
          </Tooltip>
        )}
      </div>
      {voice && <VoiceMembers channelId={channelId} groupId={groupId} />}
    </>
  );
});

function GroupSidebar({ groupId }: { groupId: string }) {
  const group = useData((s) => s.groups[groupId]);
  const channelIds = useData(useShallow((s) => s.groups[groupId]?.channelIds ?? []));
  const types = useData(useShallow((s) => channelIds.map((id) => s.channels[id]?.type)));
  const meId = useData((s) => s.me?.id);
  const role = group && meId ? group.members[meId]?.role : undefined;
  const canManage = useData((s) => can(s, groupId, PERM.MANAGE_CHANNELS));
  const canSettings = useData((s) => can(s, groupId, PERM.MANAGE_GROUP) || can(s, groupId, PERM.MANAGE_ROLES) || can(s, groupId, PERM.KICK_MEMBERS));
  const canInvite = useData((s) => can(s, groupId, PERM.CREATE_INVITE));
  const memberCount = group ? Object.keys(group.members).length : 0;
  if (!group) return null;
  const text = channelIds.filter((_, i) => types[i] === 'text');
  const voice = channelIds.filter((_, i) => types[i] === 'voice');

  const groupMenu = (rect: DOMRect) =>
    openMenu(
      rect,
      [
        ...(canInvite ? [{ label: 'Invite people', icon: <UserPlus size={16} />, onSelect: () => ui.openModal('invite', { groupId }) }] : []),
        canSettings
          ? { label: 'Group settings', icon: <Gear size={16} />, onSelect: () => ui.openModal('groupSettings', { groupId }) }
          : { label: 'Members', icon: <Users size={16} />, onSelect: () => ui.openModal('groupSettings', { groupId, tab: 'members' }) },
        ...(canManage ? [{ label: 'Create channel', icon: <Plus size={16} />, onSelect: () => ui.openModal('createChannel', { groupId }) }] : []),
        { label: 'Mark all as read', icon: <Check size={16} />, onSelect: () => markGroupRead(groupId) },
        { separator: true },
        role === 'owner'
          ? {
              label: 'Delete group',
              danger: true,
              icon: <Trash size={16} />,
              onSelect: () => ui.openModal('groupSettings', { groupId, tab: 'danger' }),
            }
          : {
              label: 'Leave group',
              danger: true,
              icon: <SignOut size={16} />,
              onSelect: () =>
                ui.openModal('confirm', {
                  title: `Leave ${group.name}?`,
                  body: "You won't be able to rejoin unless someone invites you again.",
                  confirmLabel: 'Leave group',
                  danger: true,
                  onConfirm: () => leaveGroup(groupId),
                }),
            },
      ],
      'start',
    );

  return (
    <>
      <button className="side-header side-group-header" onClick={(e) => groupMenu(e.currentTarget.getBoundingClientRect())}>
        <span className="truncate">{group.name}</span>
        <CaretDown size={16} weight="bold" />
      </button>
      <div className="side-scroll scroll">
        {memberCount <= 1 && (
          <div className="side-invite-card">
            <strong>It's quiet in here</strong>
            <p>Invite your friends so they can hang out with you.</p>
            <button className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => ui.openModal('invite', { groupId })}>
              <span className="ui-btn-content">
                <UserPlus size={16} weight="bold" /> Invite friends
              </span>
            </button>
          </div>
        )}
        <SectionHeader label="Text channels" onAdd={canManage ? () => ui.openModal('createChannel', { groupId, type: 'text' }) : undefined} />
        {text.map((id) => (
          <ChannelRow key={id} channelId={id} groupId={groupId} canManage={canManage} />
        ))}
        <SectionHeader label="Voice channels" onAdd={canManage ? () => ui.openModal('createChannel', { groupId, type: 'voice' }) : undefined} />
        {voice.map((id) => (
          <ChannelRow key={id} channelId={id} groupId={groupId} canManage={canManage} />
        ))}
        {voice.length === 0 && <div className="side-hint">No voice channels yet.</div>}
      </div>
    </>
  );
}

function SectionHeader({ label, onAdd }: { label: string; onAdd?: () => void }) {
  return (
    <div className="side-section">
      <span>{label}</span>
      {onAdd && (
        <Tooltip label="Create channel">
          <button className="side-section-add" onClick={onAdd} aria-label="Create channel">
            <Plus size={14} weight="bold" />
          </button>
        </Tooltip>
      )}
    </div>
  );
}

/* ---------------- voice connection panel ---------------- */

function VoicePanel() {
  const channelId = useCall((s) => s.channelId);
  const status = useCall((s) => s.status);
  const camera = useCall((s) => s.camera);
  const screen = useCall((s) => s.screen);
  const label = useData((s) => {
    if (!channelId) return '';
    const ch = s.channels[channelId];
    if (!ch) return 'Call';
    if (ch.type === 'dm') return dmRecipient(s, channelId)?.displayName ?? 'Call';
    return `${ch.name} / ${s.groups[ch.groupId!]?.name ?? ''}`;
  });
  if (!channelId) return null;
  const goTo = () => {
    const ch = useData.getState().channels[channelId];
    if (!ch) return;
    if (ch.type === 'dm') ui.navigate({ kind: 'dm', channelId });
    else ui.navigate({ kind: 'group', groupId: ch.groupId!, channelId });
  };
  const statusText = status === 'connected' ? 'Voice Connected' : status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…';
  return (
    <div className="voice-panel">
      <div className="voice-panel-top">
        <div className="voice-panel-info">
          <span className={`voice-panel-status is-${status}`}>
            <WifiHigh size={16} weight="bold" />
            {statusText}
          </span>
          <button className="voice-panel-where truncate" onClick={goTo}>
            {label}
          </button>
        </div>
        <IconButton label="Disconnect" danger onClick={() => call.leave()}>
          <PhoneDisconnect size={20} weight="fill" />
        </IconButton>
      </div>
      <div className="voice-panel-actions">
        <button className={`voice-action${camera ? ' is-on' : ''}`} onClick={() => void call.toggleCamera()}>
          {camera ? <VideoCamera size={18} weight="fill" /> : <VideoCameraSlash size={18} />}
          <span>Video</span>
        </button>
        {canShareScreen && (
          <button className={`voice-action${screen ? ' is-on' : ''}`} onClick={() => call.toggleScreen()}>
            {screen ? <Monitor size={18} weight="fill" /> : <MonitorArrowUp size={18} />}
            <span>Screen</span>
          </button>
        )}
        <button className="voice-action" onClick={(e) => ui.openModal('soundboard', { anchor: e.currentTarget.getBoundingClientRect() })}>
          <MusicNotes size={18} />
          <span>Sounds</span>
        </button>
      </div>
    </div>
  );
}

/* ---------------- user panel ---------------- */

const STATUSES: { value: ChosenStatus; label: string; hint: string }[] = [
  { value: 'online', label: 'Online', hint: '' },
  { value: 'idle', label: 'Idle', hint: '' },
  { value: 'dnd', label: 'Do Not Disturb', hint: 'Mutes notifications' },
  { value: 'invisible', label: 'Invisible', hint: 'Appear offline' },
];

export function UserPanel() {
  const me = useData((s) => s.me);
  const presence = useData((s) => (s.me ? s.presences[s.me.id] ?? (s.me.status === 'invisible' ? 'offline' : s.me.status) : 'offline'));
  const muted = useCall((s) => s.muted);
  const deafened = useCall((s) => s.deafened);
  if (!me) return null;
  const statusMenu = (rect: DOMRect) =>
    openMenu(
      rect,
      [
        { header: 'Set status' },
        ...STATUSES.map((st) => ({
          label: st.label,
          hint: st.hint,
          checked: me.status === st.value,
          onSelect: () => void updateProfile({ status: st.value }),
        })),
        { separator: true },
        { label: me.customStatus ? 'Edit custom status' : 'Set a custom status', icon: <ChatCircleText size={16} />, onSelect: () => ui.openModal('customStatus') },
        {
          label: `Copy friend code (${formatFriendCode(me.friendCode)})`,
          icon: <CopySimple size={16} />,
          onSelect: () => {
            void navigator.clipboard.writeText(formatFriendCode(me.friendCode));
            ui.toast('Friend code copied', 'success');
          },
        },
      ],
      'start',
    );
  return (
    <div className="user-panel">
      <button className="user-panel-me" onClick={(e) => statusMenu(e.currentTarget.getBoundingClientRect())}>
        <Avatar user={me} size={34} presence={presence} />
        <span className="user-panel-text">
          <span className="user-panel-name truncate">{me.displayName}</span>
          <span className="user-panel-sub truncate">{me.customStatus ? <EmojiText text={me.customStatus} /> : presenceLabel[presence] || `@${me.username}`}</span>
        </span>
      </button>
      <IconButton label={muted ? 'Unmute' : 'Mute'} className={muted ? 'is-off' : ''} onClick={() => call.toggleMute()}>
        {muted ? <MicrophoneSlash size={19} weight="fill" /> : <Microphone size={19} />}
      </IconButton>
      <IconButton label={deafened ? 'Undeafen' : 'Deafen'} className={deafened ? 'is-off' : ''} onClick={() => call.toggleDeafen()}>
        {deafened ? <DeafIcon /> : <Headphones size={19} />}
      </IconButton>
      <IconButton label="Settings" onClick={() => ui.openModal('settings')}>
        <Gear size={19} />
      </IconButton>
    </div>
  );
}

export function DeafIcon({ size = 19 }: { size?: number }) {
  return (
    <span className="deaf-icon" style={{ width: size, height: size }}>
      <Headphones size={size} weight="fill" />
      <span className="deaf-slash" />
    </span>
  );
}

/* ---------------- sidebar shell ---------------- */

export function Sidebar() {
  const route = useUi((s) => s.route);
  let content: ReactNode;
  if (route.kind === 'group') content = <GroupSidebar groupId={route.groupId} />;
  else content = <HomeSidebar />;
  return (
    <aside className="sidebar">
      {content}
      <VoicePanel />
      <UserPanel />
    </aside>
  );
}

export function useChannelTitle(channelId: string | null) {
  return useData((s) => (channelId ? channelLabel(s, channelId) : ''));
}

export { PresenceDot };
