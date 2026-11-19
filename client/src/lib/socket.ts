import { io, type Socket } from 'socket.io-client';
import { data, useData } from '../store/data';
import { ui, useUi } from '../store/ui';
import type { ApiGroup, Channel, CustomEmoji, GroupRole, Instance, KlipyEmbed, Member, Message, MyStorage, Presence, ReadState, SelfUser, Sound, User, VoiceState } from '../types';
import { REL } from '../types';
import { ackChannel, logout, refreshBootstrap } from './actions';
import { getToken } from './api';
import { plainPreview } from './markdown';
import { showNotification } from './notify';
import { isMobileDevice } from './platform';
import { serverBase } from './server';
import { sounds } from './sound';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (...args: any[]) => void;

let socket: Socket | null = null;
let connectedOnce = false;
const extra = new Map<string, Set<Handler>>();

export function getSocket() {
  return socket;
}

/** Register a handler that survives reconnects (used by the call manager). */
export function onSocket<T extends unknown[]>(event: string, handler: (...args: T) => void) {
  const h = handler as unknown as Handler;
  if (!extra.has(event)) extra.set(event, new Set());
  extra.get(event)!.add(h);
  socket?.on(event, h);
  return () => {
    extra.get(event)?.delete(h);
    socket?.off(event, h);
  };
}

export function emit(event: string, payload?: unknown) {
  socket?.emit(event, payload);
}

export async function emitWithAck<T>(event: string, payload: unknown, timeout = 12_000): Promise<T> {
  if (!socket?.connected) throw new Error("You're offline right now");
  return socket.timeout(timeout).emitWithAck(event, payload) as Promise<T>;
}

export function isViewing(channelId: string): boolean {
  const u = useUi.getState();
  const r = u.route;
  const open = (r.kind === 'dm' && r.channelId === channelId) || (r.kind === 'group' && r.channelId === channelId);
  if (!open || !u.visible) return false;
  if (isMobileDevice) return u.mobilePane === 'main';
  return u.focused;
}

function notifyMessage(m: Message) {
  const s = useData.getState();
  const me = s.me;
  const prefs = useUi.getState().prefs;
  if (!me || me.status === 'dnd' || !prefs.notifications || m.type !== 'default') return;
  const ch = s.channels[m.channelId];
  if (!ch) return;
  let title = m.author.displayName;
  if (ch.groupId) {
    const g = s.groups[ch.groupId];
    title = `${m.author.displayName} (#${ch.name}, ${g?.name ?? 'group'})`;
  }
  let body = plainPreview(m.content, s.users, s.emojis);
  if (!body) body = m.embeds.length ? (m.embeds[0].type === 'sticker' ? 'Sent a sticker' : 'Sent a GIF') : m.attachments.length ? 'Sent a file' : '';
  if (prefs.sounds) sounds.mention();
  void showNotification({
    title,
    body,
    icon: m.author.avatar,
    tag: m.channelId,
    onClick: () => {
      if (ch.type === 'dm') ui.navigate({ kind: 'dm', channelId: ch.id });
      else ui.navigate({ kind: 'group', groupId: ch.groupId!, channelId: ch.id });
    },
  });
}

function onMessage(m: Message) {
  const me = useData.getState().me;
  data.addMessage(m);
  if (!me || m.author.id === me.id) return;
  if (isViewing(m.channelId)) {
    ackChannel(m.channelId, m.id);
    return;
  }
  const ch = useData.getState().channels[m.channelId];
  const myRoles = ch?.groupId ? useData.getState().groups[ch.groupId]?.members[me.id]?.roles ?? [] : [];
  const mentionsMe =
    ch?.type === 'dm' ||
    myRoles.some((r) => m.content.includes(`<@&${r}>`)) ||
    m.content.includes(`<@${me.id}>`) ||
    /(^|\s)@(everyone|here)\b/.test(m.content) ||
    m.replyTo?.author?.id === me.id;
  if (mentionsMe) {
    data.bumpMention(m.channelId);
    notifyMessage(m);
  }
}

export function connectSocket() {
  socket?.removeAllListeners();
  socket?.disconnect();
  connectedOnce = false;

  const s = io(serverBase() || undefined, {
    auth: (cb) => cb({ token: getToken() }),
    reconnectionDelay: 700,
    reconnectionDelayMax: 5000,
  });
  socket = s;

  s.on('connect', () => {
    useUi.setState({ connection: 'online' });
    s.emit('presence:afk', !(useUi.getState().visible && (useUi.getState().focused || isMobileDevice)));
    if (connectedOnce) void refreshBootstrap();
    connectedOnce = true;
  });
  s.on('disconnect', () => useUi.setState({ connection: 'offline' }));
  s.on('connect_error', (err) => {
    if (err.message === 'unauthorized') void logout(true);
    else useUi.setState({ connection: 'offline' });
  });

  s.on('message:create', onMessage);
  s.on('message:update', (u: { id: string; channelId: string; content: string; editedAt: number }) => data.updateMessage(u));
  s.on('message:delete', (e: { id: string; channelId: string }) => data.deleteMessage(e.channelId, e.id));
  s.on('reaction:add', (e: { channelId: string; messageId: string; userId: string; emoji: string }) => data.reaction(e, true));
  s.on('reaction:remove', (e: { channelId: string; messageId: string; userId: string; emoji: string }) => data.reaction(e, false));
  s.on('typing:start', (e: { channelId: string; userId: string }) => data.typing(e.channelId, e.userId));

  s.on('presence:update', (e: { userId: string; status: Presence }) => data.presence(e.userId, e.status));
  s.on('presence:bulk', (map: Record<string, Presence>) => data.presenceBulk(map));
  s.on('user:update', (u: User) => data.upsertUsers([u]));
  s.on('self:update', (u: SelfUser) => data.setSelf(u));

  s.on('relationship:update', (r: { userId: string; type: 1 | 2 | 3 | 4; since: number; user: User }) => {
    const prev = useData.getState().relationships[r.userId]?.type;
    data.relationship(r);
    const prefs = useUi.getState().prefs;
    if (r.type === REL.INCOMING && prev !== REL.INCOMING) {
      if (prefs.sounds) sounds.message();
      if (prefs.notifications) {
        void showNotification({
          title: 'New friend request',
          body: `${r.user.displayName} wants to be friends`,
          icon: r.user.avatar,
          onClick: () => {
            useUi.setState({ friendsTab: 'pending' });
            ui.navigate({ kind: 'friends' });
          },
        });
      }
    } else if (r.type === REL.FRIEND && prev === REL.OUTGOING) {
      ui.toast(`You and ${r.user.displayName} are now friends`, 'success');
    }
  });
  s.on('relationship:remove', (e: { userId: string }) => data.removeRelationship(e.userId));

  s.on('dm:open', (dm: Channel & { recipient?: User | null }) => data.openDm(dm));
  s.on('dm:close', (e: { id: string }) => data.closeDm(e.id));

  s.on('group:create', (g: ApiGroup) => data.addGroup(g));
  s.on('group:update', (g: { id: string; name: string; icon: string | null; ownerId: string; everyonePermissions?: number }) => data.updateGroup(g));
  s.on('group:roles', (e: { groupId: string; roles: GroupRole[] }) => data.setRoles(e.groupId, e.roles));
  s.on('instance:update', (i: Instance) => data.setInstance(i));
  s.on('favorites:update', (list: KlipyEmbed[]) => data.setFavorites(list));
  s.on('storage:update', (st: MyStorage) => data.setMyStorage(st));
  s.on('group:delete', (e: { id: string }) => {
    const route = useUi.getState().route;
    const name = useData.getState().groups[e.id]?.name;
    data.removeGroup(e.id);
    if (route.kind === 'group' && route.groupId === e.id) {
      ui.navigate({ kind: 'friends' }, { replace: true, openMain: false });
      if (name) ui.toast(`You're no longer in ${name}`);
    }
  });
  s.on('group:member-add', (e: { groupId: string; member: Member; user: User; presence: Presence }) => {
    data.upsertMember(e.groupId, e.member, e.user);
    data.presence(e.user.id, e.presence);
  });
  s.on('group:member-update', (e: { groupId: string; member: Member }) => data.upsertMember(e.groupId, e.member));
  s.on('group:member-remove', (e: { groupId: string; userId: string }) => data.removeMember(e.groupId, e.userId));

  s.on('channel:create', (c: Channel) => data.upsertChannel(c));
  s.on('channel:update', (c: Channel) => data.upsertChannel(c));
  s.on('channel:delete', (e: { id: string; groupId: string | null }) => {
    const route = useUi.getState().route;
    data.deleteChannel(e.id, e.groupId);
    if (route.kind === 'group' && route.channelId === e.id && e.groupId) {
      ui.navigate({ kind: 'group', groupId: e.groupId, channelId: null }, { replace: true });
    }
  });

  s.on('emoji:create', (e: CustomEmoji) => data.upsertEmoji(e));
  s.on('emoji:update', (e: CustomEmoji) => data.upsertEmoji(e));
  s.on('emoji:delete', (e: { id: string }) => data.removeEmoji(e.id));
  s.on('sound:create', (x: Sound) => data.upsertSound(x));
  s.on('sound:update', (x: Sound) => data.upsertSound(x));
  s.on('sound:delete', (e: { id: string }) => data.removeSound(e.id));

  s.on('readstate:update', (r: ReadState) => data.readState(r));
  s.on('voice:state', (e: { channelId: string; userId: string; state: VoiceState | null }) => data.voiceState(e.channelId, e.userId, e.state));

  for (const [event, handlers] of extra) for (const h of handlers) s.on(event, h);
}

export function disconnectSocket() {
  socket?.removeAllListeners();
  socket?.disconnect();
  socket = null;
}
