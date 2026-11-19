import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { config } from '../config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'ranchcord.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);

type Param = string | number | bigint | boolean | null | undefined | Uint8Array;
type Bindable = string | number | bigint | null | Uint8Array;

const statements = new Map<string, StatementSync>();

function prepare(sql: string): StatementSync {
  let stmt = statements.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    statements.set(sql, stmt);
  }
  return stmt;
}

function bind(params: Param[]): Bindable[] {
  return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return prepare(sql).get(...bind(params)) as T | undefined;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return prepare(sql).all(...bind(params)) as T[];
}

export function run(sql: string, ...params: Param[]) {
  return prepare(sql).run(...bind(params));
}

let depth = 0;
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

export const qs = (n: number) => Array.from({ length: n }, () => '?').join(',');

const migrations: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    friend_code TEXT NOT NULL UNIQUE,
    avatar TEXT,
    banner_color TEXT NOT NULL DEFAULT '#5cc443',
    bio TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'online',
    custom_status TEXT NOT NULL DEFAULT '',
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    last_used_at INTEGER NOT NULL
  );
  CREATE INDEX idx_sessions_user ON sessions(user_id);

  -- type: 1 friend, 2 blocked, 3 incoming request, 4 outgoing request
  CREATE TABLE relationships (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    target_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, target_id)
  );
  CREATE INDEX idx_relationships_target ON relationships(target_id);

  CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    owner_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    nickname TEXT,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (group_id, user_id)
  );
  CREATE INDEX idx_group_members_user ON group_members(user_id);

  -- type: dm | text | voice
  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    group_id TEXT REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT,
    topic TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    last_message_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_channels_group ON channels(group_id);

  CREATE TABLE dm_members (
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    open INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX idx_dm_members_user ON dm_members(user_id);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    author_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL DEFAULT 'default',
    content TEXT NOT NULL DEFAULT '',
    reply_to_id TEXT,
    embeds TEXT,
    edited_at INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_messages_channel ON messages(channel_id, id);

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    filename TEXT NOT NULL,
    path TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_attachments_message ON attachments(message_id);

  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE emojis (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    path TEXT NOT NULL,
    animated INTEGER NOT NULL DEFAULT 0,
    creator_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE invites (
    code TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    creator_id TEXT NOT NULL REFERENCES users(id),
    uses INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE read_states (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    last_read_id TEXT,
    mention_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, channel_id)
  );

  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- Soundboard: shared by everyone on the server, played in voice calls.
  CREATE TABLE sounds (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    path TEXT NOT NULL,
    duration REAL NOT NULL DEFAULT 0,
    volume REAL NOT NULL DEFAULT 1,
    creator_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  `,
  `
  -- Profile banner image and a second profile theme colour.
  ALTER TABLE users ADD COLUMN banner TEXT;
  ALTER TABLE users ADD COLUMN accent_color TEXT;
  `,
  `
  -- Discord-style roles with colours and permissions.
  CREATE TABLE roles (
    id TEXT PRIMARY KEY,
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    color TEXT,
    position INTEGER NOT NULL DEFAULT 1,
    permissions INTEGER NOT NULL DEFAULT 0,
    hoist INTEGER NOT NULL DEFAULT 0,
    mentionable INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_roles_group ON roles(group_id);

  CREATE TABLE member_roles (
    group_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id),
    FOREIGN KEY (group_id, user_id) REFERENCES group_members(group_id, user_id) ON DELETE CASCADE
  );
  CREATE INDEX idx_member_roles_group ON member_roles(group_id);

  ALTER TABLE groups ADD COLUMN everyone_permissions INTEGER NOT NULL DEFAULT 7872;

  -- Server-wide settings like the app name and logo.
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- Personal app background, and favourite GIFs/stickers.
  ALTER TABLE users ADD COLUMN background TEXT;
  CREATE TABLE gif_favorites (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    embed TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, kind, slug)
  );
  `,
  `
  -- Cloud storage: files waiting to be deleted from the bucket, and shrinking old uploads.
  CREATE TABLE storage_deletes (
    key TEXT PRIMARY KEY,
    is_prefix INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  -- shrunk: 0 not looked at yet, 1 replaced by a smaller copy, 2 left as it was
  ALTER TABLE attachments ADD COLUMN shrunk INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE attachments ADD COLUMN original_size INTEGER;
  CREATE INDEX idx_attachments_shrink ON attachments(shrunk, created_at);
  `,
  `
  -- Everyone links their own storage (an S3-compatible bucket) for the files they send.
  -- Old rows stay (inactive) so files sent before switching buckets keep loading.
  CREATE TABLE user_storage (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    region TEXT NOT NULL,
    bucket TEXT NOT NULL,
    access_key_id TEXT NOT NULL,
    secret TEXT NOT NULL,
    public_url TEXT NOT NULL DEFAULT '',
    prefix TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_user_storage_user ON user_storage(user_id, active);
  -- storage_id: whose bucket holds the file (NULL = this server). pending: still uploading.
  ALTER TABLE attachments ADD COLUMN storage_id TEXT;
  ALTER TABLE attachments ADD COLUMN pending INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE storage_deletes ADD COLUMN storage_id TEXT;
  `,
];

const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
for (let v = current; v < migrations.length; v++) {
  tx(() => {
    db.exec(migrations[v]);
    db.exec(`PRAGMA user_version = ${v + 1}`);
  });
}
