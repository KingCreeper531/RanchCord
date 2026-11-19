import type { FastifyRequest } from 'fastify';
import { get, run } from './lib/db.ts';
import type { UserRow } from './lib/model.ts';
import { now, randomToken, sha256, unauthorized } from './lib/util.ts';

export function createSession(userId: string, device: string): string {
  const token = randomToken();
  const t = now();
  run(
    'INSERT INTO sessions (token_hash, user_id, device, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token),
    userId,
    device.slice(0, 300),
    t,
    t,
  );
  return token;
}

export function userFromToken(token: string): UserRow | undefined {
  const hash = sha256(token);
  const row = get<UserRow & { last_used_at: number }>(
    'SELECT u.*, s.last_used_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    hash,
  );
  if (row && now() - row.last_used_at > 10 * 60_000) {
    run('UPDATE sessions SET last_used_at = ? WHERE token_hash = ?', now(), hash);
  }
  return row;
}

export function bearerToken(req: FastifyRequest): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim() || undefined;
  return undefined;
}

/** Returns the logged in user or throws 401. */
export function auth(req: FastifyRequest): UserRow {
  const token = bearerToken(req);
  const user = token ? userFromToken(token) : undefined;
  if (!user) throw unauthorized();
  return user;
}
