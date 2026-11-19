import { all, get, qs } from './db.ts';
import { everyonePermissions, memberRoleIds, roleOut, rolesOf } from './perms.ts';
import { forbidden, notFound } from './util.ts';

/* ---------- rows ---------- */

export type Role = 'owner' | 'admin' | 'member';
export type ChannelType = 'dm' | 'text' | 'voice';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  friend_code: string;
  avatar: string | null;
  banner: string | null;
  accent_color: string | null;
  background: string | null;
  banner_color: string;
  bio: string;
  status: string;
  custom_status: string;
  is_admin: number;
  created_at: number;
}

export interface ChannelRow {
  id: string;
  type: ChannelType;
  group_id: string | null;
  name: string | null;
  topic: string;
  position: number;
  last_message_id: string | null;
  created_at: number;
  /** The category it sits under in the channel list (null: above all categories). */
  category_id: string | null;
}

export interface GroupRow {
  id: string;
  name: string;
  icon: string | null;
  owner_id: string;
  created_at: number;
  description: string;
  /** Where "X joined the group" messages go (null: the first text channel). */
  system_channel_id: string | null;
}

export interface MemberRow {
  group_id: string;
  user_id: string;
  role: Role;
  nickname: string | null;
  joined_at: number;
  /** Timed out until this time: can't send messages, react or join voice in the group. */
  timeout_until: number | null;
}

export interface CategoryRow {
  id: string;
  group_id: string;
  name: string;
  position: number;
  created_at: number;
}

export interface MessageRow {
  id: string;
  channel_id: string;
  author_id: string;
  type: string;
  content: string;
  reply_to_id: string | null;
  embeds: string | null;
  edited_at: number | null;
  created_at: number;
  pinned_at?: number | null;
}

export interface AttachmentRow {
  id: string;
  message_id: string | null;
  uploader_id: string;
  filename: string;
  path: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  /** Whose bucket holds the file (null: this server). */
  storage_id: string | null;
  /** 1 while the sender's device is still uploading it. */
  pending: number;
  created_at: number;
}

export interface EmojiRow {
  id: string;
  name: string;
  path: string;
  animated: number;
  creator_id: string;
  created_at: number;
}

export const REL = { FRIEND: 1, BLOCKED: 2, INCOMING: 3, OUTGOING: 4 } as const;

/* ---------- serializers ---------- */

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    avatar: u.avatar,
    banner: u.banner,
    bannerColor: u.banner_color,
    accentColor: u.accent_color,
    bio: u.bio,
    customStatus: u.custom_status,
    createdAt: u.created_at,
  };
}
export type PublicUser = ReturnType<typeof publicUser>;

export function selfUser(u: UserRow) {
  return {
    ...publicUser(u),
    friendCode: u.friend_code,
    status: u.status,
    isAdmin: Boolean(u.is_admin),
    background: u.background,
  };
}

export function channelOut(c: ChannelRow) {
  return {
    id: c.id,
    type: c.type,
    groupId: c.group_id,
    name: c.name,
    topic: c.topic,
    position: c.position,
    categoryId: c.category_id ?? null,
    lastMessageId: c.last_message_id,
    createdAt: c.created_at,
  };
}

export function categoriesOf(groupId: string) {
  return all<CategoryRow>('SELECT * FROM channel_categories WHERE group_id = ? ORDER BY position, created_at', groupId);
}

export function categoryOut(c: CategoryRow) {
  return { id: c.id, name: c.name, position: c.position };
}

/** True while someone is timed out in a group. */
export function isTimedOut(m: MemberRow | null | undefined): boolean {
  return Boolean(m?.timeout_until && m.timeout_until > Date.now());
}

export function attachmentOut(a: AttachmentRow) {
  return {
    id: a.id,
    filename: a.filename,
    url: `/files/${a.path}`,
    contentType: a.content_type,
    size: a.size,
    width: a.width,
    height: a.height,
  };
}

export interface StickerRow {
  id: string;
  name: string;
  path: string;
  width: number;
  height: number;
  creator_id: string | null;
  created_at: number;
}

export function stickerOut(s: StickerRow) {
  return { id: s.id, name: s.name, url: `/files/${s.path}`, width: s.width, height: s.height, creatorId: s.creator_id, createdAt: s.created_at };
}

export function emojiOut(e: EmojiRow) {
  return { id: e.id, name: e.name, url: `/files/${e.path}`, animated: Boolean(e.animated), creatorId: e.creator_id };
}

export function memberOut(m: MemberRow, roles?: string[]) {
  return {
    userId: m.user_id,
    role: m.role,
    nickname: m.nickname,
    joinedAt: m.joined_at,
    timeoutUntil: m.timeout_until && m.timeout_until > Date.now() ? m.timeout_until : null,
    roles: roles ?? memberRoleIds(m.group_id, m.user_id),
  };
}

export function groupOut(groupId: string) {
  const g = get<GroupRow>('SELECT * FROM groups WHERE id = ?', groupId);
  if (!g) return null;
  const channels = all<ChannelRow>('SELECT * FROM channels WHERE group_id = ? ORDER BY position, created_at', groupId);
  const members = all<MemberRow & UserRow>(
    `SELECT gm.group_id, gm.role, gm.nickname, gm.joined_at, gm.timeout_until, u.*, u.id AS user_id
       FROM group_members gm JOIN users u ON u.id = gm.user_id
      WHERE gm.group_id = ? ORDER BY gm.joined_at`,
    groupId,
  );
  const assigned = new Map<string, string[]>();
  for (const r of all<{ user_id: string; role_id: string }>('SELECT user_id, role_id FROM member_roles WHERE group_id = ?', groupId)) {
    const list = assigned.get(r.user_id) ?? [];
    list.push(r.role_id);
    assigned.set(r.user_id, list);
  }
  return {
    id: g.id,
    name: g.name,
    icon: g.icon,
    ownerId: g.owner_id,
    createdAt: g.created_at,
    description: g.description ?? '',
    systemChannelId: g.system_channel_id ?? null,
    categories: categoriesOf(groupId).map(categoryOut),
    everyonePermissions: everyonePermissions(groupId),
    roles: rolesOf(groupId).map(roleOut),
    channels: channels.map(channelOut),
    members: members.map((m) => memberOut(m, assigned.get(m.user_id) ?? [])),
    users: members.map(publicUser),
  };
}

export function dmOut(c: ChannelRow, viewerId: string) {
  const other = get<UserRow>(
    'SELECT u.* FROM dm_members dm JOIN users u ON u.id = dm.user_id WHERE dm.channel_id = ? AND dm.user_id != ?',
    c.id,
    viewerId,
  );
  return { ...channelOut(c), recipientId: other?.id ?? null, recipient: other ? publicUser(other) : null };
}

/** A GIF or sticker: 'klipy' ones from the GIF picker, 'media' ones that people uploaded or linked. */
export interface Embed {
  kind: 'klipy' | 'media';
  type: 'gif' | 'sticker';
  slug: string;
  title: string;
  url: string;
  mp4: string | null;
  webp: string | null;
  preview: string | null;
  width: number;
  height: number;
}

export function hydrateMessages(rows: MessageRow[], viewerId: string) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const attachments = all<AttachmentRow>(
    `SELECT * FROM attachments WHERE message_id IN (${qs(ids.length)}) ORDER BY id`,
    ...ids,
  );
  const reactions = all<{ message_id: string; emoji: string; count: number; me: number }>(
    `SELECT message_id, emoji, COUNT(*) AS count, MAX(user_id = ?) AS me, MIN(created_at) AS first
       FROM reactions WHERE message_id IN (${qs(ids.length)})
      GROUP BY message_id, emoji ORDER BY first`,
    viewerId,
    ...ids,
  );
  const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter((x): x is string => !!x))];
  const replies = replyIds.length
    ? all<MessageRow>(`SELECT * FROM messages WHERE id IN (${qs(replyIds.length)})`, ...replyIds)
    : [];
  const replyAttachmentCounts = replyIds.length
    ? all<{ message_id: string; n: number }>(
        `SELECT message_id, COUNT(*) AS n FROM attachments WHERE message_id IN (${qs(replyIds.length)}) GROUP BY message_id`,
        ...replyIds,
      )
    : [];
  const authorIds = [...new Set([...rows.map((r) => r.author_id), ...replies.map((r) => r.author_id)])];
  const authors = all<UserRow>(`SELECT * FROM users WHERE id IN (${qs(authorIds.length)})`, ...authorIds);

  const authorById = new Map(authors.map((u) => [u.id, publicUser(u)]));
  const replyById = new Map(replies.map((r) => [r.id, r]));
  const replyAttachments = new Map(replyAttachmentCounts.map((r) => [r.message_id, r.n]));
  const attachmentsByMessage = new Map<string, ReturnType<typeof attachmentOut>[]>();
  for (const a of attachments) {
    const list = attachmentsByMessage.get(a.message_id!) ?? [];
    list.push(attachmentOut(a));
    attachmentsByMessage.set(a.message_id!, list);
  }
  const reactionsByMessage = new Map<string, { emoji: string; count: number; me: boolean }[]>();
  for (const r of reactions) {
    const list = reactionsByMessage.get(r.message_id) ?? [];
    list.push({ emoji: r.emoji, count: r.count, me: Boolean(r.me) });
    reactionsByMessage.set(r.message_id, list);
  }

  return rows.map((r) => {
    let replyTo = null;
    if (r.reply_to_id) {
      const ref = replyById.get(r.reply_to_id);
      replyTo = ref
        ? {
            id: ref.id,
            author: authorById.get(ref.author_id) ?? null,
            content: ref.content.slice(0, 400),
            hasAttachments: (replyAttachments.get(ref.id) ?? 0) > 0,
            hasEmbeds: Boolean(ref.embeds && ref.embeds !== '[]'),
          }
        : { id: r.reply_to_id, deleted: true as const };
    }
    return {
      id: r.id,
      channelId: r.channel_id,
      type: r.type,
      author: authorById.get(r.author_id)!,
      content: r.content,
      createdAt: r.created_at,
      editedAt: r.edited_at,
      replyTo,
      attachments: attachmentsByMessage.get(r.id) ?? [],
      embeds: (r.embeds ? JSON.parse(r.embeds) : []) as Embed[],
      reactions: reactionsByMessage.get(r.id) ?? [],
      pinnedAt: r.pinned_at ?? null,
    };
  });
}

/* ---------- lookups & access ---------- */

export const getUser = (id: string) => get<UserRow>('SELECT * FROM users WHERE id = ?', id);
export const getChannel = (id: string) => get<ChannelRow>('SELECT * FROM channels WHERE id = ?', id);
export const getGroup = (id: string) => get<GroupRow>('SELECT * FROM groups WHERE id = ?', id);
export const getMember = (groupId: string, userId: string) =>
  get<MemberRow>('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', groupId, userId);

export function channelMembers(ch: ChannelRow): string[] {
  if (ch.type === 'dm') {
    return all<{ user_id: string }>('SELECT user_id FROM dm_members WHERE channel_id = ?', ch.id).map((r) => r.user_id);
  }
  return all<{ user_id: string }>('SELECT user_id FROM group_members WHERE group_id = ?', ch.group_id).map(
    (r) => r.user_id,
  );
}

export function groupMemberIds(groupId: string): string[] {
  return all<{ user_id: string }>('SELECT user_id FROM group_members WHERE group_id = ?', groupId).map((r) => r.user_id);
}

/** Throws a 404 unless the user can see the channel. */
export function requireChannel(userId: string, channelId: string): { channel: ChannelRow; member: MemberRow | null } {
  const channel = getChannel(channelId);
  if (!channel) throw notFound('That channel no longer exists');
  if (channel.type === 'dm') {
    const ok = get('SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?', channelId, userId);
    if (!ok) throw notFound('That conversation no longer exists');
    return { channel, member: null };
  }
  const member = getMember(channel.group_id!, userId);
  if (!member) throw notFound('That channel no longer exists');
  return { channel, member };
}

export function requireMember(userId: string, groupId: string): MemberRow {
  const member = getMember(groupId, userId);
  if (!member) throw notFound('That group no longer exists');
  return member;
}

export function relationship(userId: string, targetId: string): number | undefined {
  return get<{ type: number }>('SELECT type FROM relationships WHERE user_id = ? AND target_id = ?', userId, targetId)
    ?.type;
}

export function isBlockedEither(a: string, b: string): boolean {
  return Boolean(
    get(
      'SELECT 1 FROM relationships WHERE type = 2 AND ((user_id = ? AND target_id = ?) OR (user_id = ? AND target_id = ?))',
      a,
      b,
      b,
      a,
    ),
  );
}

export function sharesGroup(a: string, b: string): boolean {
  return Boolean(
    get(
      `SELECT 1 FROM group_members x JOIN group_members y ON x.group_id = y.group_id
        WHERE x.user_id = ? AND y.user_id = ? LIMIT 1`,
      a,
      b,
    ),
  );
}

export function dmRecipientId(channelId: string, userId: string): string | undefined {
  return get<{ user_id: string }>('SELECT user_id FROM dm_members WHERE channel_id = ? AND user_id != ?', channelId, userId)
    ?.user_id;
}

/** Everyone who should hear about this user's presence/profile changes. */
export function relatedUserIds(userId: string): string[] {
  return all<{ id: string }>(
    `SELECT target_id AS id FROM relationships WHERE user_id = ? AND type IN (1, 3, 4)
     UNION SELECT y.user_id FROM group_members x JOIN group_members y ON x.group_id = y.group_id WHERE x.user_id = ?
     UNION SELECT y.user_id FROM dm_members x JOIN dm_members y ON x.channel_id = y.channel_id WHERE x.user_id = ?`,
    userId,
    userId,
    userId,
  )
    .map((r) => r.id)
    .filter((id) => id !== userId);
}
