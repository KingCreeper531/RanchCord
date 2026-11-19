export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
export type ChosenStatus = 'online' | 'idle' | 'dnd' | 'invisible';
export type Role = 'owner' | 'admin' | 'member';

export interface User {
  id: string;
  username: string;
  displayName: string;
  avatar: string | null;
  banner?: string | null;
  bannerColor: string;
  accentColor?: string | null;
  bio: string;
  customStatus: string;
  createdAt: number;
}

export interface SelfUser extends User {
  friendCode: string;
  status: ChosenStatus;
  isAdmin: boolean;
  /** Personal app background: 'preset:<id>' or an uploaded image path. Only this user sees it. */
  background?: string | null;
}

/** 1 friend, 2 blocked, 3 incoming request, 4 outgoing request */
export type RelType = 1 | 2 | 3 | 4;
export const REL = { FRIEND: 1, BLOCKED: 2, INCOMING: 3, OUTGOING: 4 } as const;

export interface Relationship {
  userId: string;
  type: RelType;
  since: number;
}

export type ChannelType = 'dm' | 'text' | 'voice';

export interface Channel {
  id: string;
  type: ChannelType;
  groupId: string | null;
  name: string | null;
  topic: string;
  position: number;
  lastMessageId: string | null;
  createdAt: number;
  recipientId?: string | null;
  /** Group channels: the category it sits under (null: above all categories). */
  categoryId?: string | null;
}

export interface Member {
  userId: string;
  role: Role;
  nickname: string | null;
  joinedAt: number;
  roles: string[];
  /** Timed out (can't talk, react or join voice in the group) until this time. */
  timeoutUntil?: number | null;
}

/** What 'group:update' sends when a group's settings change. */
export interface GroupMeta {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  everyonePermissions?: number;
  description?: string;
  systemChannelId?: string | null;
}

/** What 'group:layout' sends when the channel list is rearranged. */
export interface GroupLayout {
  groupId: string;
  categories: ChannelCategory[];
  channels: { id: string; categoryId: string | null; position: number }[];
}

/** A collapsible section of a group's channel list. */
export interface ChannelCategory {
  id: string;
  name: string;
  position: number;
}

export interface GroupRole {
  id: string;
  groupId: string;
  name: string;
  color: string | null;
  position: number;
  permissions: number;
  hoist: boolean;
  mentionable: boolean;
}

export interface Group {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  createdAt: number;
  channelIds: string[];
  members: Record<string, Member>;
  roles: Record<string, GroupRole>;
  everyonePermissions: number;
  description: string;
  /** Where "X joined" messages go: a text channel id, null for the first text channel, or 'off'. */
  systemChannelId: string | null;
  /** Top to bottom. */
  categories: ChannelCategory[];
}

export interface Attachment {
  id: string;
  filename: string;
  url: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
}

/**
 * A GIF or sticker in a message (and in favorites). 'klipy' ones come from the GIF picker;
 * 'media' ones are GIFs people uploaded or linked, with `url` a /files/ path or an https link.
 */
export interface KlipyEmbed {
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

export interface Reaction {
  emoji: string;
  count: number;
  me: boolean;
}

export interface ReplyRef {
  id: string;
  author?: User | null;
  content?: string;
  hasAttachments?: boolean;
  hasEmbeds?: boolean;
  deleted?: true;
}

export interface Message {
  id: string;
  channelId: string;
  type: string;
  author: User;
  content: string;
  createdAt: number;
  editedAt: number | null;
  replyTo: ReplyRef | null;
  attachments: Attachment[];
  embeds: KlipyEmbed[];
  reactions: Reaction[];
  nonce?: string;
  pending?: boolean;
  failed?: boolean;
}

export interface ReadState {
  channelId: string;
  lastReadId: string | null;
  mentionCount: number;
}

export interface CustomEmoji {
  id: string;
  name: string;
  url: string;
  animated: boolean;
  creatorId: string;
}

/** A sticker someone uploaded. Shared with everyone on the server, like photo emojis. */
export interface Sticker {
  id: string;
  name: string;
  url: string;
  width: number;
  height: number;
  creatorId: string | null;
  createdAt: number;
}

export interface Sound {
  id: string;
  name: string;
  emoji: string;
  url: string;
  duration: number;
  volume: number;
  creatorId: string;
  createdAt: number;
}

export interface VoiceState {
  userId: string;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  screen: boolean;
  joinedAt: number;
}

export interface Instance {
  name: string;
  logo: string | null;
  signupCodeRequired: boolean;
  publicUrl: string | null;
  maxUploadBytes: number;
  klipy: { key: string; contentFilter: string } | null;
  calls: { mode: 'p2p' | 'sfu' };
  vapidPublicKey: string | null;
  downloads: { windows?: string; android?: string; ios?: string };
}

export interface ApiGroup {
  id: string;
  name: string;
  icon: string | null;
  ownerId: string;
  createdAt: number;
  everyonePermissions: number;
  roles: GroupRole[];
  channels: Channel[];
  members: Member[];
  users?: User[];
  description?: string;
  systemChannelId?: string | null;
  categories?: ChannelCategory[];
}

export interface Bootstrap {
  user: SelfUser;
  users: User[];
  relationships: Relationship[];
  dms: Channel[];
  groups: ApiGroup[];
  readStates: ReadState[];
  emojis: CustomEmoji[];
  stickers?: Sticker[];
  sounds: Sound[];
  favorites?: KlipyEmbed[];
  myStorage?: MyStorage;
  presences: Record<string, Presence>;
  voiceStates: (VoiceState & { channelId: string })[];
  rings: { channelId: string; callerId: string }[];
  instance: Instance;
}

/** Your own storage (an S3-compatible bucket) that the files you send go to. */
export interface MyStorage {
  linked: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  publicUrl: string;
  linkedAt: number | null;
  files: number;
  bytes: number;
}

export interface UploadTicket {
  attachment: Attachment;
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
}
