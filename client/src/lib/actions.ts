import { data, useData } from '../store/data';
import { ui, useUi } from '../store/ui';
import type { ApiGroup, Attachment, Bootstrap, Channel, CustomEmoji, GroupRole, KlipyEmbed, Member, Message, Mute, MyStorage, Relationship, SelfUser, Sound, Sticker, UploadTicket, User } from '../types';
import { ApiError, api, errorMessage, putToUrl, setToken, upload } from './api';
import { expandEmojiShortcodes } from './emoji';
import { imageSize, videoSize } from './image';
import { nonce } from './format';
import { disableWebPush } from './notify';
import { connectSocket, disconnectSocket, emit } from './socket';

export const PAGE = 50;

/* ---------- session ---------- */

export async function startSession() {
  const boot = await api.get<Bootstrap>('/api/bootstrap');
  data.bootstrap(boot);
  connectSocket();
}

export async function refreshBootstrap() {
  try {
    const boot = await api.get<Bootstrap>('/api/bootstrap');
    data.bootstrap(boot);
    // Reload the channel on screen so nothing sent while we were offline is missed.
    const r = useUi.getState().route;
    const channelId = r.kind === 'dm' ? r.channelId : r.kind === 'group' ? r.channelId : null;
    if (channelId) void loadLatest(channelId);
  } catch {
    /* the socket will retry */
  }
}

export async function login(username: string, password: string) {
  const res = await api.post<{ token: string; user: SelfUser }>('/api/auth/login', { username, password });
  setToken(res.token);
  await startSession();
}

export async function register(body: { username: string; password: string; displayName?: string; signupCode?: string }) {
  const res = await api.post<{ token: string; user: SelfUser }>('/api/auth/register', body);
  setToken(res.token);
  await startSession();
}

export async function logout(expired = false) {
  if (!expired) {
    await disableWebPush();
    await api.post('/api/auth/logout').catch(() => {});
  }
  setToken(null);
  disconnectSocket();
  data.reset();
  ui.closeAllModals();
  history.replaceState(null, '', '#/channels/@me');
  useUi.setState({ route: { kind: 'friends' } });
  if (expired) ui.toast('You were logged out. Please log in again.');
}

/* ---------- messages ---------- */

const loading = new Set<string>();

export async function loadLatest(channelId: string) {
  if (loading.has(channelId)) return;
  loading.add(channelId);
  data.setMessagesLoading(channelId, true);
  try {
    const page = await api.get<Message[]>(`/api/channels/${channelId}/messages?limit=${PAGE}`);
    data.mergeMessages(channelId, page, { latest: true, limit: PAGE });
  } catch (err) {
    data.setMessagesLoading(channelId, false, (err as Error).message);
  } finally {
    loading.delete(channelId);
  }
}

export async function loadOlder(channelId: string) {
  const cm = useData.getState().messages[channelId];
  if (!cm || !cm.hasMore || loading.has(channelId)) return;
  const first = cm.list.find((m) => !m.pending && !m.failed);
  if (!first) return;
  loading.add(channelId);
  data.setMessagesLoading(channelId, true);
  try {
    const page = await api.get<Message[]>(`/api/channels/${channelId}/messages?before=${first.id}&limit=${PAGE}`);
    data.mergeMessages(channelId, page, { before: first.id, limit: PAGE });
  } catch (err) {
    data.setMessagesLoading(channelId, false, (err as Error).message);
  } finally {
    loading.delete(channelId);
  }
}

/** Turns @username into <@id> for people in this channel. */
function encodeMentions(content: string, channelId: string): string {
  const s = useData.getState();
  const ch = s.channels[channelId];
  const ids = ch?.type === 'dm' ? [s.me!.id, ch.recipientId!].filter(Boolean) : Object.keys(s.groups[ch?.groupId ?? '']?.members ?? {});
  const byName = new Map<string, string>();
  for (const id of ids) {
    const u = s.users[id];
    if (u) byName.set(u.username.toLowerCase(), id);
  }
  let out = content;
  const roles = ch?.groupId ? Object.values(s.groups[ch.groupId]?.roles ?? {}) : [];
  for (const r of [...roles].sort((a, b) => b.name.length - a.name.length)) {
    const escaped = r.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[\\s(])@${escaped}(?![\\w])`, 'gi'), (_m, pre: string) => `${pre}<@&${r.id}>`);
  }
  return out.replace(/(^|[\s(])@([a-z0-9_.]{2,32})\b/gi, (match, pre: string, name: string) => {
    const id = byName.get(name.toLowerCase());
    return id ? `${pre}<@${id}>` : match;
  });
}

interface SendOpts {
  content: string;
  replyToId?: string | null;
  replyPing?: boolean;
  attachments?: Attachment[];
  embeds?: KlipyEmbed[];
}

const outbox = new Map<string, { channelId: string; body: Record<string, unknown> }>();

export async function sendMessage(channelId: string, opts: SendOpts) {
  const s = useData.getState();
  const me = s.me!;
  const content = encodeMentions(expandEmojiShortcodes(opts.content, Object.values(s.emojis)), channelId).trim();
  if (!content && !opts.attachments?.length && !opts.embeds?.length) return;
  const n = nonce();
  const replyTo = opts.replyToId ? s.messages[channelId]?.list.find((m) => m.id === opts.replyToId) : undefined;
  const pending: Message = {
    id: `pending-${n}`,
    channelId,
    type: 'default',
    author: s.users[me.id] ?? me,
    content,
    createdAt: Date.now(),
    editedAt: null,
    replyTo: replyTo ? { id: replyTo.id, author: replyTo.author, content: replyTo.content } : null,
    attachments: opts.attachments ?? [],
    embeds: opts.embeds ?? [],
    reactions: [],
    nonce: n,
    pending: true,
  };
  data.addPending(pending);
  const body = {
    content,
    replyToId: opts.replyToId ?? null,
    replyPing: opts.replyPing ?? true,
    attachmentIds: (opts.attachments ?? []).map((a) => a.id),
    embeds: opts.embeds ?? [],
    nonce: n,
  };
  outbox.set(n, { channelId, body });
  await deliver(n);
}

async function deliver(n: string) {
  const item = outbox.get(n);
  if (!item) return;
  try {
    const msg = await api.post<Message>(`/api/channels/${item.channelId}/messages`, item.body);
    outbox.delete(n);
    data.addMessage({ ...msg, nonce: n });
  } catch (err) {
    data.markFailed(item.channelId, n);
    ui.toast((err as Error).message, 'error');
  }
}

export function retryMessage(channelId: string, n: string) {
  const s = useData.getState();
  const cm = s.messages[channelId];
  if (!cm) return;
  useData.setState({
    messages: {
      ...s.messages,
      [channelId]: { ...cm, list: cm.list.map((m) => (m.nonce === n ? { ...m, failed: false, pending: true } : m)) },
    },
  });
  void deliver(n);
}

export function discardMessage(channelId: string, n: string) {
  outbox.delete(n);
  data.removeLocal(channelId, n);
}

export async function editMessage(channelId: string, id: string, content: string) {
  const s = useData.getState();
  const encoded = encodeMentions(expandEmojiShortcodes(content, Object.values(s.emojis)), channelId);
  const res = await api.patch<{ id: string; channelId: string; content: string; editedAt: number }>(
    `/api/channels/${channelId}/messages/${id}`,
    { content: encoded },
  );
  data.updateMessage(res);
}

export async function deleteMessage(channelId: string, id: string) {
  await api.del(`/api/channels/${channelId}/messages/${id}`);
  data.deleteMessage(channelId, id);
}

export async function toggleReaction(channelId: string, messageId: string, emoji: string) {
  const me = useData.getState().me!;
  const msg = useData.getState().messages[channelId]?.list.find((m) => m.id === messageId);
  const has = msg?.reactions.find((r) => r.emoji === emoji)?.me;
  const event = { channelId, messageId, userId: me.id, emoji };
  data.reaction(event, !has);
  const path = `/api/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`;
  try {
    if (has) await api.del(path);
    else await api.put(path);
  } catch (err) {
    data.reaction(event, Boolean(has));
    ui.toast((err as Error).message, 'error');
  }
  if (!has) ui.pushRecentEmoji(emoji);
}

const ackTimers = new Map<string, number>();

export function ackChannel(channelId: string, messageId?: string) {
  const s = useData.getState();
  const id = messageId ?? s.channels[channelId]?.lastMessageId;
  if (!id) return;
  const rs = s.readStates[channelId];
  if (rs && rs.lastReadId && rs.lastReadId >= id && !rs.mentionCount) return;
  data.readState({ channelId, lastReadId: id, mentionCount: 0 });
  clearTimeout(ackTimers.get(channelId));
  ackTimers.set(
    channelId,
    window.setTimeout(() => {
      ackTimers.delete(channelId);
      void api.post(`/api/channels/${channelId}/ack`, { messageId: id }).catch(() => {});
    }, 250),
  );
}

const lastTyping = new Map<string, number>();
export function sendTyping(channelId: string) {
  const now = Date.now();
  if (now - (lastTyping.get(channelId) ?? 0) < 3500) return;
  lastTyping.set(channelId, now);
  emit('typing', { channelId });
}
export function stopTyping(channelId: string) {
  lastTyping.delete(channelId);
}

async function mediaSize(file: File) {
  if (file.type.startsWith('video/')) return videoSize(file);
  if (file.type.startsWith('image/')) return imageSize(file);
  return null;
}

/** Sends a file straight from this device into your own storage, then tells the server it arrived. */
export async function uploadAttachment(file: File, onProgress?: (f: number) => void, signal?: AbortSignal) {
  if (!useData.getState().myStorage?.linked) {
    throw new ApiError(403, 'Link your own storage in Settings → My Storage to send files', 'storage_required');
  }
  const dims = await mediaSize(file);
  const ticket = await api.post<UploadTicket>('/api/uploads', {
    filename: file.name,
    size: file.size,
    contentType: file.type,
    width: dims?.width,
    height: dims?.height,
  });
  await putToUrl(ticket.upload.url, file, ticket.upload.headers, onProgress, signal);
  return api.post<Attachment>(`/api/uploads/${ticket.attachment.id}/finish`);
}

/** Shown when someone tries to send a file before linking their storage. */
export function askToLinkStorage() {
  ui.openModal('confirm', {
    title: 'Link your storage to send files',
    body: 'Pictures, videos and files you send are kept in your own free storage (Backblaze B2 or Cloudflare R2), not on the server. Setting it up takes a few minutes.',
    confirmLabel: 'Set up storage',
    onConfirm: () => ui.openModal('settings', { tab: 'storage' }),
  });
}

/* ---------- your own storage ---------- */

export interface StorageForm {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** Checks the bucket on the server, proves this device can upload to it, then links it. */
export async function linkMyStorage(form: StorageForm) {
  const check = await api.post<{ checkKey: string; corsSet: boolean; upload: UploadTicket['upload'] }>('/api/storage/check', form);
  try {
    await putToUrl(check.upload.url, new Blob(['ok']), check.upload.headers);
  } catch {
    throw new ApiError(400, 'Your bucket blocked uploads from the app. Add the CORS rule below to the bucket, then try again.', 'storage_cors');
  }
  const status = await api.put<MyStorage>('/api/storage', { ...form, checkKey: check.checkKey });
  data.setMyStorage(status);
  return status;
}

export async function unlinkMyStorage() {
  data.setMyStorage(await api.del<MyStorage>('/api/storage'));
}

/* ---------- DMs & friends ---------- */

export async function openDm(userId: string) {
  const dm = await api.post<Channel & { recipient: User }>('/api/dms', { userId });
  data.openDm(dm);
  ui.navigate({ kind: 'dm', channelId: dm.id });
}

/** Sends a group invite link to a friend's DMs without leaving the current screen. */
export async function sendInviteTo(userId: string, url: string) {
  const dm = await api.post<Channel & { recipient: User }>('/api/dms', { userId });
  data.openDm(dm);
  await sendMessage(dm.id, { content: url });
}

export async function closeDm(channelId: string) {
  data.closeDm(channelId);
  const r = useUi.getState().route;
  if (r.kind === 'dm' && r.channelId === channelId) ui.navigate({ kind: 'friends' }, { replace: true });
  await api.del(`/api/dms/${channelId}`).catch(() => {});
}

export async function sendFriendRequest(query: string) {
  const r = await api.post<Relationship & { user: User }>('/api/relationships', { query });
  data.relationship({ ...r, since: Date.now() });
  return r;
}

export async function acceptFriend(userId: string) {
  const r = await api.put<Relationship & { user: User }>(`/api/relationships/${userId}`, { type: 'friend' });
  data.relationship({ ...r, since: Date.now() });
}

export async function removeRelationship(userId: string) {
  await api.del(`/api/relationships/${userId}`);
  data.removeRelationship(userId);
}

export async function blockUser(userId: string) {
  const r = await api.put<Relationship & { user: User }>(`/api/relationships/${userId}`, { type: 'block' });
  data.relationship({ ...r, since: Date.now() });
}

/** Blocking always asks first: a stray tap (say, while a chat slides open on a phone) must never block someone. */
export function askToBlock(userId: string) {
  const name = useData.getState().users[userId]?.displayName ?? 'this person';
  ui.openModal('confirm', {
    title: `Block ${name}?`,
    body: "They won't be able to message or call you. You can unblock them anytime in Friends > Blocked.",
    confirmLabel: 'Block',
    danger: true,
    onConfirm: () =>
      blockUser(userId)
        .then(() => ui.toast(`${name} is blocked`, 'success'))
        .catch((err) => ui.toast(errorMessage(err), 'error')),
  });
}

/** Unfriending asks first too. */
export function askToRemoveFriend(userId: string) {
  const name = useData.getState().users[userId]?.displayName ?? 'this person';
  ui.openModal('confirm', {
    title: `Remove ${name} as a friend?`,
    body: 'You can still message each other. You can add them again later.',
    confirmLabel: 'Remove friend',
    danger: true,
    onConfirm: () => removeRelationship(userId).catch((err) => ui.toast(errorMessage(err), 'error')),
  });
}

/* ---------- profile ---------- */

export async function updateProfile(patch: Partial<Pick<SelfUser, 'displayName' | 'username' | 'bio' | 'customStatus' | 'bannerColor' | 'accentColor' | 'status'>>) {
  const me = await api.patch<SelfUser>('/api/users/@me', patch);
  data.setSelf(me);
  return me;
}

export async function uploadAvatar(blob: Blob, filename = 'avatar.webp') {
  const form = new FormData();
  form.append('file', blob, filename);
  const me = await upload<SelfUser>('/api/users/@me/avatar', form);
  data.setSelf(me);
}

export async function uploadBanner(blob: Blob, filename = 'banner.webp') {
  const form = new FormData();
  form.append('file', blob, filename);
  data.setSelf(await upload<SelfUser>('/api/users/@me/banner', form));
}

export async function removeBanner() {
  data.setSelf(await api.del<SelfUser>('/api/users/@me/banner'));
}

export async function removeAvatar() {
  data.setSelf(await api.del<SelfUser>('/api/users/@me/avatar'));
}

export async function resetFriendCode() {
  data.setSelf(await api.post<SelfUser>('/api/users/@me/friend-code'));
}

export async function changePassword(currentPassword: string, newPassword: string) {
  await api.post('/api/users/@me/password', { currentPassword, newPassword, logoutOthers: true });
}

export async function fetchProfile(userId: string) {
  return api.get<{ user: User; mutualFriends: string[]; mutualGroups: string[] }>(`/api/users/${userId}`);
}

/* ---------- groups ---------- */

export async function createGroup(name: string, icon?: Blob | null) {
  const g = await api.post<ApiGroup>('/api/groups', { name });
  data.addGroup(g);
  if (icon) await setGroupIcon(g.id, icon).catch(() => {});
  const first = g.channels.find((c) => c.type === 'text');
  ui.navigate({ kind: 'group', groupId: g.id, channelId: first?.id ?? null });
  return g;
}

export async function setGroupIcon(groupId: string, blob: Blob, filename = 'icon.webp') {
  const form = new FormData();
  form.append('file', blob, filename);
  const meta = await upload<{ id: string; name: string; icon: string | null; ownerId: string }>(`/api/groups/${groupId}/icon`, form);
  data.updateGroup(meta);
}

export async function removeGroupIcon(groupId: string) {
  data.updateGroup(await api.del(`/api/groups/${groupId}/icon`));
}

export async function renameGroup(groupId: string, name: string) {
  data.updateGroup(await api.patch(`/api/groups/${groupId}`, { name }));
}

export async function deleteGroup(groupId: string) {
  await api.del(`/api/groups/${groupId}`);
  data.removeGroup(groupId);
  ui.navigate({ kind: 'friends' }, { replace: true });
}

export async function leaveGroup(groupId: string) {
  await api.del(`/api/groups/${groupId}/members/@me`);
  data.removeGroup(groupId);
  ui.navigate({ kind: 'friends' }, { replace: true });
}

export async function kickMember(groupId: string, userId: string) {
  await api.del(`/api/groups/${groupId}/members/${userId}`);
  data.removeMember(groupId, userId);
}

export async function setMemberRole(groupId: string, userId: string, role: 'admin' | 'member') {
  data.upsertMember(groupId, await api.patch<Member>(`/api/groups/${groupId}/members/${userId}`, { role }));
}

export async function setNickname(groupId: string, userId: string, nickname: string | null) {
  data.upsertMember(groupId, await api.patch<Member>(`/api/groups/${groupId}/members/${userId}`, { nickname }));
}

export async function transferOwnership(groupId: string, userId: string) {
  await api.post(`/api/groups/${groupId}/transfer`, { userId });
}

export async function getInvite(groupId: string, reset = false) {
  return reset
    ? api.post<{ code: string; url: string }>(`/api/groups/${groupId}/invite/reset`)
    : api.get<{ code: string; url: string }>(`/api/groups/${groupId}/invite`);
}

export interface InvitePreview {
  code: string;
  group: { id: string; name: string; icon: string | null; memberCount: number; onlineCount: number };
  inviter: User | null;
  joined: boolean;
}

export async function previewInvite(code: string) {
  return api.get<InvitePreview>(`/api/invites/${encodeURIComponent(code)}`);
}

export function parseInviteCode(input: string): string {
  const trimmed = input.trim();
  const m = /\/invite\/([A-Za-z0-9]{6,16})/.exec(trimmed);
  return m ? m[1] : trimmed.replace(/[^A-Za-z0-9]/g, '');
}

export async function joinInvite(code: string) {
  const g = await api.post<ApiGroup>(`/api/invites/${encodeURIComponent(code)}`);
  data.addGroup(g);
  const first = g.channels.find((c) => c.type === 'text');
  ui.navigate({ kind: 'group', groupId: g.id, channelId: first?.id ?? null });
  return g;
}

/** With `categoryId` left out, the server puts it in the category that already holds that kind of channel. */
export async function createChannel(groupId: string, name: string, type: 'text' | 'voice', categoryId?: string | null) {
  const c = await api.post<Channel>(`/api/groups/${groupId}/channels`, { name, type, categoryId });
  data.upsertChannel(c);
  if (type === 'text') ui.navigate({ kind: 'group', groupId, channelId: c.id });
  return c;
}

export async function updateChannel(channelId: string, patch: { name?: string; topic?: string; categoryId?: string | null }) {
  data.upsertChannel(await api.patch<Channel>(`/api/channels/${channelId}`, patch));
}

export async function deleteChannel(channelId: string) {
  const ch = useData.getState().channels[channelId];
  await api.del(`/api/channels/${channelId}`);
  data.deleteChannel(channelId, ch?.groupId ?? null);
}

/* ---------- emojis & sounds ---------- */

export async function uploadEmoji(name: string, blob: Blob, filename = 'emoji.webp') {
  const form = new FormData();
  form.append('name', name);
  form.append('file', blob, filename);
  const e = await upload<CustomEmoji>('/api/emojis', form);
  data.upsertEmoji(e);
  return e;
}

/* ---------- pins ---------- */

export async function pinMessage(channelId: string, messageId: string) {
  await api.put(`/api/channels/${channelId}/pins/${messageId}`);
  data.setPinned(channelId, messageId, Date.now());
}

export async function unpinMessage(channelId: string, messageId: string) {
  await api.del(`/api/channels/${channelId}/pins/${messageId}`);
  data.setPinned(channelId, messageId, null);
}

export const loadPins = (channelId: string) => api.get<Message[]>(`/api/channels/${channelId}/pins`);

/* ---------- stickers people upload ---------- */

export async function uploadSticker(name: string, blob: Blob, filename = 'sticker.webp') {
  const form = new FormData();
  form.append('name', name);
  form.append('file', blob, filename);
  const x = await upload<Sticker>('/api/stickers', form);
  data.upsertSticker(x);
  return x;
}

export async function renameSticker(id: string, name: string) {
  data.upsertSticker(await api.patch<Sticker>(`/api/stickers/${id}`, { name }));
}

export async function deleteSticker(id: string) {
  await api.del(`/api/stickers/${id}`);
  data.removeSticker(id);
}

/** What sending an uploaded sticker puts in the message. */
export function stickerEmbed(x: Sticker): KlipyEmbed {
  return { kind: 'media', type: 'sticker', slug: `stk:${x.id}`, title: x.name, url: x.url, mp4: null, webp: null, preview: null, width: x.width, height: x.height };
}

export async function renameEmoji(id: string, name: string) {
  data.upsertEmoji(await api.patch<CustomEmoji>(`/api/emojis/${id}`, { name }));
}

export async function deleteEmoji(id: string) {
  await api.del(`/api/emojis/${id}`);
  data.removeEmoji(id);
}

export async function uploadSound(opts: { name: string; emoji: string; volume: number; duration: number; file: Blob; filename: string }) {
  const form = new FormData();
  form.append('name', opts.name);
  form.append('emoji', opts.emoji);
  form.append('volume', String(opts.volume));
  form.append('duration', String(opts.duration));
  form.append('file', opts.file, opts.filename);
  const sound = await upload<Sound>('/api/sounds', form);
  data.upsertSound(sound);
  return sound;
}

export async function updateSound(id: string, patch: { name?: string; emoji?: string; volume?: number }) {
  data.upsertSound(await api.patch<Sound>(`/api/sounds/${id}`, patch));
}

export async function deleteSound(id: string) {
  await api.del(`/api/sounds/${id}`);
  data.removeSound(id);
}

/* ---------- roles ---------- */

export async function createRole(groupId: string, body: { name: string; color?: string | null; permissions?: number; hoist?: boolean; mentionable?: boolean }) {
  return api.post<GroupRole>(`/api/groups/${groupId}/roles`, body);
}

export async function updateRole(groupId: string, roleId: string, patch: Partial<Pick<GroupRole, 'name' | 'color' | 'permissions' | 'hoist' | 'mentionable'>>) {
  return api.patch<GroupRole>(`/api/groups/${groupId}/roles/${roleId}`, patch);
}

export async function deleteRole(groupId: string, roleId: string) {
  await api.del(`/api/groups/${groupId}/roles/${roleId}`);
}

export async function reorderRoles(groupId: string, ids: string[]) {
  await api.put(`/api/groups/${groupId}/roles`, { ids });
}

export async function setMemberHasRole(groupId: string, userId: string, roleId: string, on: boolean) {
  const path = `/api/groups/${groupId}/members/${userId}/roles/${roleId}`;
  if (on) await api.put(path);
  else await api.del(path);
}

export async function setEveryonePermissions(groupId: string, everyonePermissions: number) {
  data.updateGroup(await api.patch(`/api/groups/${groupId}`, { everyonePermissions }));
}

/* ---------- personal background ---------- */

export async function setBackground(background: string | null) {
  data.setSelf(await api.patch<SelfUser>('/api/users/@me', { background }));
}

export async function uploadBackground(blob: Blob, filename: string, onProgress?: (f: number) => void) {
  const form = new FormData();
  form.append('file', blob, filename);
  data.setSelf(await upload<SelfUser>('/api/users/@me/background', form, onProgress));
}

/* ---------- favourite GIFs & stickers ---------- */

export const isFavorite = (list: KlipyEmbed[], e: Pick<KlipyEmbed, 'type' | 'slug'>) => list.some((f) => f.type === e.type && f.slug === e.slug);

/** Stars or un-stars a GIF/sticker. Returns true if it's now a favourite. */
export async function toggleFavorite(embed: KlipyEmbed): Promise<boolean> {
  const before = useData.getState().favorites;
  const on = !isFavorite(before, embed);
  data.setFavorites(on ? [embed, ...before] : before.filter((f) => !(f.type === embed.type && f.slug === embed.slug)));
  try {
    const list = on
      ? await api.put<KlipyEmbed[]>('/api/favorites', embed)
      : await api.del<KlipyEmbed[]>(`/api/favorites/${embed.type}/${encodeURIComponent(embed.slug)}`);
    data.setFavorites(list);
  } catch (err) {
    data.setFavorites(before);
    throw err;
  }
  return on;
}

/* ---------- nuking a DM ---------- */

/** Deletes every message, reaction and file in a DM, for both people. */
export async function nukeDm(channelId: string) {
  await api.post(`/api/channels/${channelId}/nuke`);
}

export function askToNukeDm(channelId: string) {
  ui.openModal('confirm', {
    title: 'Nuke this chat?',
    body: "Every message, picture and file in this DM gets deleted for both of you. This can't be undone.",
    confirmLabel: 'Nuke it',
    danger: true,
    onConfirm: () =>
      nukeDm(channelId)
        .then(() => ui.toast('Chat nuked', 'success'))
        .catch((err) => ui.toast(errorMessage(err), 'error')),
  });
}

/* ---------- mutes ---------- */

/** Mutes a DM, channel or group for some minutes, or until it's unmuted (null). */
export async function muteTarget(targetId: string, minutes: number | null) {
  data.setMutes(await api.put<Mute[]>(`/api/mutes/${targetId}`, { minutes }));
}

export async function unmuteTarget(targetId: string) {
  data.setMutes(await api.del<Mute[]>(`/api/mutes/${targetId}`));
}
