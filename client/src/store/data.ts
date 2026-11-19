import { create } from 'zustand';
import type {
  ApiGroup,
  Bootstrap,
  Channel,
  CustomEmoji,
  Group,
  GroupLayout,
  GroupMeta,
  GroupRole,
  Instance,
  KlipyEmbed,
  Member,
  MyStorage,
  Message,
  Presence,
  ReadState,
  Relationship,
  SelfUser,
  Sound,
  Sticker,
  User,
  VoiceState,
} from '../types';
import { REL } from '../types';
import { rememberBrand } from '../lib/brand';

export interface ChannelMessages {
  list: Message[];
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
  stale: boolean;
  error?: string;
}

export interface DataState {
  ready: boolean;
  me: SelfUser | null;
  instance: Instance | null;
  users: Record<string, User>;
  relationships: Record<string, Relationship>;
  channels: Record<string, Channel>;
  dmIds: string[];
  groups: Record<string, Group>;
  groupOrder: string[];
  readStates: Record<string, ReadState>;
  emojis: Record<string, CustomEmoji>;
  stickers: Record<string, Sticker>;
  sounds: Record<string, Sound>;
  favorites: KlipyEmbed[];
  myStorage: MyStorage | null;
  presences: Record<string, Presence>;
  voice: Record<string, Record<string, VoiceState>>;
  rings: Record<string, string>;
  typing: Record<string, Record<string, number>>;
  messages: Record<string, ChannelMessages>;
}

const initial: DataState = {
  ready: false,
  me: null,
  instance: null,
  users: {},
  relationships: {},
  channels: {},
  dmIds: [],
  groups: {},
  groupOrder: [],
  readStates: {},
  emojis: {},
  stickers: {},
  sounds: {},
  favorites: [],
  myStorage: null,
  presences: {},
  voice: {},
  rings: {},
  typing: {},
  messages: {},
};

export const useData = create<DataState>(() => initial);
const set = useData.setState;
const get = useData.getState;

export const emptyMessages: ChannelMessages = { list: [], hasMore: true, loading: false, loaded: false, stale: false };

const byPosition = (channels: Record<string, Channel>) => (a: string, b: string) => {
  const x = channels[a];
  const y = channels[b];
  return (x?.position ?? 0) - (y?.position ?? 0) || (x?.createdAt ?? 0) - (y?.createdAt ?? 0);
};

function toGroup(g: ApiGroup): Group {
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    ownerId: g.ownerId,
    createdAt: g.createdAt,
    channelIds: [...g.channels].sort((a, b) => a.position - b.position || a.createdAt - b.createdAt).map((c) => c.id),
    members: Object.fromEntries(g.members.map((m) => [m.userId, { ...m, roles: m.roles ?? [] }])),
    roles: Object.fromEntries((g.roles ?? []).map((r) => [r.id, r])),
    everyonePermissions: g.everyonePermissions,
    description: g.description ?? '',
    systemChannelId: g.systemChannelId ?? null,
    categories: [...(g.categories ?? [])].sort((a, b) => a.position - b.position),
  };
}

const GROUP_ORDER_KEY = 'rc.groupOrder';
function savedGroupOrder(ids: string[]): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(GROUP_ORDER_KEY) ?? '[]') as string[];
    const known = saved.filter((id) => ids.includes(id));
    return [...known, ...ids.filter((id) => !known.includes(id))];
  } catch {
    return ids;
  }
}
export function saveGroupOrder(order: string[]) {
  localStorage.setItem(GROUP_ORDER_KEY, JSON.stringify(order));
  set({ groupOrder: order });
}

function insertSorted(list: Message[], m: Message): Message[] {
  const out = [...list];
  let i = out.length;
  // pending messages always stay at the end
  while (i > 0 && (out[i - 1].pending || out[i - 1].id > m.id)) i--;
  out.splice(i, 0, m);
  return out;
}

function mapMessages(s: DataState, channelId: string, fn: (list: Message[]) => Message[]) {
  const cm = s.messages[channelId];
  if (!cm) return s.messages;
  return { ...s.messages, [channelId]: { ...cm, list: fn(cm.list) } };
}

function patchMessage(s: DataState, channelId: string, messageId: string, fn: (m: Message) => Message) {
  return mapMessages(s, channelId, (list) => {
    const i = list.findIndex((m) => m.id === messageId);
    if (i < 0) return list;
    const copy = [...list];
    copy[i] = fn(copy[i]);
    return copy;
  });
}

export const data = {
  reset() {
    set(initial, true);
  },

  bootstrap(b: Bootstrap) {
    const prev = get();
    const users: Record<string, User> = {};
    for (const u of b.users) users[u.id] = u;
    users[b.user.id] = b.user;
    const channels: Record<string, Channel> = {};
    const dmIds: string[] = [];
    for (const dm of b.dms) {
      channels[dm.id] = dm;
      dmIds.push(dm.id);
    }
    const groups: Record<string, Group> = {};
    for (const g of b.groups) {
      groups[g.id] = toGroup(g);
      for (const c of g.channels) channels[c.id] = c;
    }
    const voice: DataState['voice'] = {};
    for (const v of b.voiceStates) {
      const { channelId, ...state } = v;
      (voice[channelId] ??= {})[v.userId] = state;
    }
    const messages: DataState['messages'] = {};
    for (const [id, cm] of Object.entries(prev.messages)) {
      if (channels[id]) messages[id] = { ...cm, stale: true, loading: false };
    }
    rememberBrand(b.instance.name, b.instance.logo);
    set({
      ready: true,
      me: b.user,
      instance: b.instance,
      users,
      relationships: Object.fromEntries(b.relationships.map((r) => [r.userId, r])),
      channels,
      dmIds,
      groups,
      groupOrder: savedGroupOrder(b.groups.map((g) => g.id)),
      readStates: Object.fromEntries(b.readStates.map((r) => [r.channelId, r])),
      emojis: Object.fromEntries(b.emojis.map((e) => [e.id, e])),
      stickers: Object.fromEntries((b.stickers ?? []).map((x) => [x.id, x])),
      sounds: Object.fromEntries((b.sounds ?? []).map((x) => [x.id, x])),
      favorites: b.favorites ?? [],
      myStorage: b.myStorage ?? null,
      presences: b.presences,
      voice,
      rings: Object.fromEntries(b.rings.map((r) => [r.channelId, r.callerId])),
      messages,
    });
  },

  /* ---------- users & presence ---------- */

  upsertUsers(list: (User | null | undefined)[]) {
    set((s) => {
      let users = s.users;
      for (const u of list) {
        if (!u) continue;
        const old = users[u.id];
        if (old && old.displayName === u.displayName && old.avatar === u.avatar && old.username === u.username &&
          old.bio === u.bio && old.customStatus === u.customStatus && old.bannerColor === u.bannerColor) continue;
        if (users === s.users) users = { ...users };
        users[u.id] = { ...old, ...u };
      }
      return users === s.users ? s : { users };
    });
  },

  setSelf(me: SelfUser) {
    set((s) => ({ me, users: { ...s.users, [me.id]: { ...s.users[me.id], ...me } } }));
  },

  presence(userId: string, status: Presence) {
    set((s) => {
      if ((s.presences[userId] ?? 'offline') === status) return s;
      const presences = { ...s.presences };
      if (status === 'offline') delete presences[userId];
      else presences[userId] = status;
      return { presences };
    });
  },

  presenceBulk(map: Record<string, Presence>) {
    set((s) => ({ presences: { ...s.presences, ...map } }));
  },

  /* ---------- relationships ---------- */

  relationship(r: Relationship & { user?: User }) {
    if (r.user) data.upsertUsers([r.user]);
    set((s) => ({ relationships: { ...s.relationships, [r.userId]: { userId: r.userId, type: r.type, since: r.since } } }));
  },

  removeRelationship(userId: string) {
    set((s) => {
      const relationships = { ...s.relationships };
      delete relationships[userId];
      return { relationships };
    });
  },

  /* ---------- channels ---------- */

  openDm(dm: Channel & { recipient?: User | null }) {
    if (dm.recipient) data.upsertUsers([dm.recipient]);
    const { recipient: _r, ...channel } = dm;
    set((s) => ({
      channels: { ...s.channels, [channel.id]: { ...s.channels[channel.id], ...channel } },
      dmIds: s.dmIds.includes(channel.id) ? s.dmIds : [channel.id, ...s.dmIds],
    }));
  },

  closeDm(id: string) {
    set((s) => ({ dmIds: s.dmIds.filter((x) => x !== id) }));
  },

  upsertChannel(c: Channel) {
    set((s) => {
      const channels = { ...s.channels, [c.id]: { ...s.channels[c.id], ...c } };
      let groups = s.groups;
      if (c.groupId && s.groups[c.groupId]) {
        const g = s.groups[c.groupId];
        const ids = g.channelIds.includes(c.id) ? [...g.channelIds] : [...g.channelIds, c.id];
        ids.sort(byPosition(channels));
        groups = { ...s.groups, [g.id]: { ...g, channelIds: ids } };
      }
      return { channels, groups };
    });
  },

  deleteChannel(id: string, groupId: string | null) {
    set((s) => {
      const channels = { ...s.channels };
      delete channels[id];
      const messages = { ...s.messages };
      delete messages[id];
      let groups = s.groups;
      if (groupId && s.groups[groupId]) {
        const g = s.groups[groupId];
        groups = { ...s.groups, [groupId]: { ...g, channelIds: g.channelIds.filter((x) => x !== id) } };
      }
      return { channels, messages, groups };
    });
  },

  /* ---------- groups ---------- */

  addGroup(g: ApiGroup) {
    if (g.users) data.upsertUsers(g.users);
    set((s) => {
      const channels = { ...s.channels };
      for (const c of g.channels) channels[c.id] = c;
      return {
        channels,
        groups: { ...s.groups, [g.id]: toGroup(g) },
        groupOrder: s.groupOrder.includes(g.id) ? s.groupOrder : [...s.groupOrder, g.id],
      };
    });
  },

  updateGroup(meta: GroupMeta) {
    set((s) => {
      const g = s.groups[meta.id];
      if (!g) return s;
      const next = {
        ...g,
        name: meta.name,
        icon: meta.icon,
        ownerId: meta.ownerId,
        everyonePermissions: meta.everyonePermissions ?? g.everyonePermissions,
        description: meta.description ?? g.description,
        systemChannelId: meta.systemChannelId !== undefined ? meta.systemChannelId : g.systemChannelId,
      };
      return { groups: { ...s.groups, [g.id]: next } };
    });
  },

  /** Category order and where every channel sits, after someone rearranged the channel list. */
  applyLayout(e: GroupLayout) {
    set((s) => {
      const g = s.groups[e.groupId];
      if (!g) return s;
      const channels = { ...s.channels };
      for (const c of e.channels) {
        if (channels[c.id]) channels[c.id] = { ...channels[c.id], categoryId: c.categoryId, position: c.position };
      }
      const channelIds = [...g.channelIds].sort(byPosition(channels));
      const categories = [...e.categories].sort((a, b) => a.position - b.position);
      return { channels, groups: { ...s.groups, [g.id]: { ...g, categories, channelIds } } };
    });
  },

  setRoles(groupId: string, roles: GroupRole[]) {
    set((s) => {
      const g = s.groups[groupId];
      if (!g) return s;
      return { groups: { ...s.groups, [groupId]: { ...g, roles: Object.fromEntries(roles.map((r) => [r.id, r])) } } };
    });
  },

  setInstance(instance: Instance) {
    set({ instance });
    rememberBrand(instance.name, instance.logo);
  },

  removeGroup(id: string) {
    set((s) => {
      const g = s.groups[id];
      const groups = { ...s.groups };
      delete groups[id];
      const channels = { ...s.channels };
      const messages = { ...s.messages };
      for (const cid of g?.channelIds ?? []) {
        delete channels[cid];
        delete messages[cid];
      }
      return { groups, channels, messages, groupOrder: s.groupOrder.filter((x) => x !== id) };
    });
  },

  upsertMember(groupId: string, member: Member, user?: User) {
    if (user) data.upsertUsers([user]);
    set((s) => {
      const g = s.groups[groupId];
      if (!g) return s;
      return { groups: { ...s.groups, [groupId]: { ...g, members: { ...g.members, [member.userId]: { ...member, roles: member.roles ?? [] } } } } };
    });
  },

  removeMember(groupId: string, userId: string) {
    set((s) => {
      const g = s.groups[groupId];
      if (!g) return s;
      const members = { ...g.members };
      delete members[userId];
      return { groups: { ...s.groups, [groupId]: { ...g, members } } };
    });
  },

  /* ---------- messages ---------- */

  setMessagesLoading(channelId: string, loading: boolean, error?: string) {
    set((s) => ({
      messages: { ...s.messages, [channelId]: { ...(s.messages[channelId] ?? emptyMessages), loading, error } },
    }));
  },

  /** Merge a page of messages from the server. */
  mergeMessages(channelId: string, page: Message[], opts: { before?: string; latest?: boolean; limit: number }) {
    data.upsertUsers(page.map((m) => m.author));
    set((s) => {
      const cm = s.messages[channelId] ?? emptyMessages;
      let list: Message[];
      let hasMore = cm.hasMore;
      if (opts.before) {
        const known = new Set(cm.list.map((m) => m.id));
        list = [...page.filter((m) => !known.has(m.id)), ...cm.list];
        hasMore = page.length >= opts.limit;
      } else {
        // latest page: if it doesn't overlap what we have, replace (there's a gap), otherwise merge.
        const pending = cm.list.filter((m) => m.pending || m.failed);
        const confirmed = cm.list.filter((m) => !m.pending && !m.failed);
        const overlap = confirmed.length > 0 && page.length > 0 && confirmed[confirmed.length - 1].id >= page[0].id;
        if (overlap) {
          const byId = new Map(confirmed.map((m) => [m.id, m]));
          for (const m of page) byId.set(m.id, m);
          const cutoff = page[0].id;
          list = [...byId.values()].filter((m) => m.id < cutoff || page.some((p) => p.id === m.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
        } else {
          list = page;
          hasMore = page.length >= opts.limit;
        }
        const nonces = new Set(page.map((m) => m.nonce).filter(Boolean));
        list = [...list, ...pending.filter((p) => !nonces.has(p.nonce))];
        if (!cm.loaded) hasMore = page.length >= opts.limit;
      }
      return {
        messages: {
          ...s.messages,
          [channelId]: { list, hasMore, loading: false, loaded: true, stale: false, error: undefined },
        },
      };
    });
  },

  addMessage(m: Message) {
    const me = get().me;
    if (m.author) data.upsertUsers([m.author]);
    set((s) => {
      const channel = s.channels[m.channelId];
      const channels =
        channel && (!channel.lastMessageId || channel.lastMessageId < m.id)
          ? { ...s.channels, [channel.id]: { ...channel, lastMessageId: m.id } }
          : s.channels;
      let messages = s.messages;
      const cm = s.messages[m.channelId];
      if (cm?.loaded && !cm.list.some((x) => x.id === m.id)) {
        const i = m.nonce ? cm.list.findIndex((x) => x.nonce === m.nonce) : -1;
        let list: Message[];
        if (i >= 0) {
          list = cm.list.filter((_, j) => j !== i);
          list = insertSorted(list, { ...m, pending: false, failed: false });
        } else list = insertSorted(cm.list, m);
        messages = { ...s.messages, [m.channelId]: { ...cm, list } };
      }
      let typing = s.typing;
      if (s.typing[m.channelId]?.[m.author.id]) {
        const t = { ...s.typing[m.channelId] };
        delete t[m.author.id];
        typing = { ...s.typing, [m.channelId]: t };
      }
      let readStates = s.readStates;
      if (me && m.author.id === me.id) {
        readStates = { ...s.readStates, [m.channelId]: { channelId: m.channelId, lastReadId: m.id, mentionCount: 0 } };
      }
      // Bring DMs with new activity to the top.
      const dmIds = channel?.type === 'dm' && s.dmIds[0] !== m.channelId
        ? [m.channelId, ...s.dmIds.filter((x) => x !== m.channelId)]
        : s.dmIds;
      return { channels, messages, typing, readStates, dmIds };
    });
  },

  addPending(m: Message) {
    set((s) => {
      const cm = s.messages[m.channelId] ?? { ...emptyMessages, loaded: true };
      return { messages: { ...s.messages, [m.channelId]: { ...cm, list: [...cm.list, m] } } };
    });
  },

  markFailed(channelId: string, nonce: string) {
    set((s) =>
      ({ messages: mapMessages(s, channelId, (list) => list.map((m) => (m.nonce === nonce && m.pending ? { ...m, pending: false, failed: true } : m))) }),
    );
  },

  removeLocal(channelId: string, nonce: string) {
    set((s) => ({ messages: mapMessages(s, channelId, (list) => list.filter((m) => m.nonce !== nonce || !(m.pending || m.failed))) }));
  },

  updateMessage(u: { id: string; channelId: string; content: string; editedAt: number }) {
    set((s) => ({ messages: patchMessage(s, u.channelId, u.id, (m) => ({ ...m, content: u.content, editedAt: u.editedAt })) }));
  },

  /** Someone nuked this DM: drop every message we had for it (the server already deleted them). */
  nukeChannel(channelId: string) {
    set((s) => {
      const channel = s.channels[channelId];
      const read = s.readStates[channelId];
      return {
        messages: s.messages[channelId]
          ? { ...s.messages, [channelId]: { list: [], hasMore: false, loading: false, loaded: true, stale: false } }
          : s.messages,
        channels: channel ? { ...s.channels, [channelId]: { ...channel, lastMessageId: null } } : s.channels,
        readStates: read ? { ...s.readStates, [channelId]: { ...read, lastReadId: null, mentionCount: 0 } } : s.readStates,
      };
    });
  },

  deleteMessage(channelId: string, id: string) {
    set((s) => {
      const messages = mapMessages(s, channelId, (list) => list.filter((m) => m.id !== id).map((m) =>
        m.replyTo?.id === id ? { ...m, replyTo: { id, deleted: true as const } } : m));
      const channel = s.channels[channelId];
      let channels = s.channels;
      if (channel?.lastMessageId === id) {
        const list = messages[channelId]?.list.filter((m) => !m.pending && !m.failed) ?? [];
        channels = { ...s.channels, [channelId]: { ...channel, lastMessageId: list.length ? list[list.length - 1].id : null } };
      }
      return { messages, channels };
    });
  },

  reaction(e: { channelId: string; messageId: string; userId: string; emoji: string }, add: boolean) {
    const me = get().me?.id;
    const mine = e.userId === me;
    set((s) => ({
      messages: patchMessage(s, e.channelId, e.messageId, (m) => {
        const reactions = [...m.reactions];
        const i = reactions.findIndex((r) => r.emoji === e.emoji);
        if (add) {
          if (i >= 0) {
            const r = reactions[i];
            if (mine && r.me) return m;
            reactions[i] = { ...r, count: r.count + 1, me: r.me || mine };
          } else reactions.push({ emoji: e.emoji, count: 1, me: mine });
        } else {
          if (i < 0) return m;
          const r = reactions[i];
          if (mine && !r.me) return m;
          if (r.count <= 1) reactions.splice(i, 1);
          else reactions[i] = { ...r, count: r.count - 1, me: mine ? false : r.me };
        }
        return { ...m, reactions };
      }),
    }));
  },

  /* ---------- read states & typing ---------- */

  readState(r: ReadState) {
    set((s) => ({ readStates: { ...s.readStates, [r.channelId]: r } }));
  },

  bumpMention(channelId: string) {
    set((s) => {
      const r = s.readStates[channelId] ?? { channelId, lastReadId: null, mentionCount: 0 };
      return { readStates: { ...s.readStates, [channelId]: { ...r, mentionCount: r.mentionCount + 1 } } };
    });
  },

  typing(channelId: string, userId: string) {
    set((s) => ({ typing: { ...s.typing, [channelId]: { ...s.typing[channelId], [userId]: Date.now() + 9000 } } }));
  },

  pruneTyping() {
    const now = Date.now();
    const s = get();
    let changed = false;
    const typing: DataState['typing'] = {};
    for (const [cid, users] of Object.entries(s.typing)) {
      const kept: Record<string, number> = {};
      for (const [uid, until] of Object.entries(users)) {
        if (until > now) kept[uid] = until;
        else changed = true;
      }
      if (Object.keys(kept).length) typing[cid] = kept;
      else if (Object.keys(users).length) changed = true;
    }
    if (changed) set({ typing });
  },

  /* ---------- stickers ---------- */

  upsertSticker(x: Sticker) {
    set((s) => ({ stickers: { ...s.stickers, [x.id]: x } }));
  },

  removeSticker(id: string) {
    set((s) => {
      const stickers = { ...s.stickers };
      delete stickers[id];
      return { stickers };
    });
  },

  /* ---------- emojis ---------- */

  upsertEmoji(e: CustomEmoji) {
    set((s) => ({ emojis: { ...s.emojis, [e.id]: e } }));
  },

  removeEmoji(id: string) {
    set((s) => {
      const emojis = { ...s.emojis };
      delete emojis[id];
      return { emojis };
    });
  },

  /* ---------- favourite GIFs & stickers ---------- */

  setFavorites(favorites: KlipyEmbed[]) {
    set({ favorites });
  },

  setMyStorage(myStorage: MyStorage) {
    set({ myStorage });
  },

  /* ---------- soundboard ---------- */

  upsertSound(x: Sound) {
    set((s) => ({ sounds: { ...s.sounds, [x.id]: x } }));
  },

  removeSound(id: string) {
    set((s) => {
      const sounds = { ...s.sounds };
      delete sounds[id];
      return { sounds };
    });
  },

  /* ---------- voice ---------- */

  voiceState(channelId: string, userId: string, state: VoiceState | null) {
    set((s) => {
      const room = { ...s.voice[channelId] };
      if (state) room[userId] = state;
      else delete room[userId];
      const voice = { ...s.voice, [channelId]: room };
      if (!Object.keys(room).length) delete voice[channelId];
      return { voice };
    });
  },

  ring(channelId: string, callerId: string | null) {
    set((s) => {
      const rings = { ...s.rings };
      if (callerId) rings[channelId] = callerId;
      else delete rings[channelId];
      return { rings };
    });
  },
};

/* ---------- selectors ---------- */

export function isUnread(s: DataState, channelId: string): boolean {
  const ch = s.channels[channelId];
  if (!ch?.lastMessageId || ch.type === 'voice') return false;
  const rs = s.readStates[channelId];
  return !rs?.lastReadId || ch.lastMessageId > rs.lastReadId;
}

export function mentionCount(s: DataState, channelId: string): number {
  return s.readStates[channelId]?.mentionCount ?? 0;
}

export function groupUnread(s: DataState, groupId: string): { unread: boolean; mentions: number } {
  const g = s.groups[groupId];
  let unread = false;
  let mentions = 0;
  for (const id of g?.channelIds ?? []) {
    if (isUnread(s, id)) unread = true;
    mentions += mentionCount(s, id);
  }
  return { unread, mentions };
}

export function friendIds(s: DataState): string[] {
  return Object.values(s.relationships)
    .filter((r) => r.type === REL.FRIEND)
    .map((r) => r.userId);
}

export function pendingIncoming(s: DataState): number {
  return Object.values(s.relationships).filter((r) => r.type === REL.INCOMING).length;
}

export function displayNameIn(s: DataState, userId: string, groupId?: string | null): string {
  const nick = groupId ? s.groups[groupId]?.members[userId]?.nickname : null;
  return nick || s.users[userId]?.displayName || 'Unknown';
}

export function dmRecipient(s: DataState, channelId: string): User | undefined {
  const id = s.channels[channelId]?.recipientId;
  return id ? s.users[id] : undefined;
}

export function channelLabel(s: DataState, channelId: string): string {
  const ch = s.channels[channelId];
  if (!ch) return 'Unknown';
  if (ch.type === 'dm') return dmRecipient(s, channelId)?.displayName ?? 'Direct message';
  return ch.name ?? 'channel';
}

export function sortedDmIds(s: DataState): string[] {
  return [...s.dmIds].sort((a, b) => {
    const x = s.channels[a]?.lastMessageId ?? a;
    const y = s.channels[b]?.lastMessageId ?? b;
    return x < y ? 1 : x > y ? -1 : 0;
  });
}
