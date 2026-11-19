import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth.ts';
import { get, run, tx } from '../lib/db.ts';
import { REL, type UserRow, getUser, publicUser, relationship } from '../lib/model.ts';
import { badRequest, notFound, now, parse } from '../lib/util.ts';
import { emitTo, presenceOf } from '../realtime.ts';

const NOT_FOUND = "Hm, that didn't work. Double-check the username or friend code.";

function upsert(userId: string, targetId: string, type: number) {
  run(
    `INSERT INTO relationships (user_id, target_id, type, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, target_id) DO UPDATE SET type = excluded.type, created_at = excluded.created_at`,
    userId,
    targetId,
    type,
    now(),
  );
}

function notify(userId: string, other: UserRow, type: number) {
  emitTo([userId], 'relationship:update', { userId: other.id, type, since: now(), user: publicUser(other) });
}

function becameFriends(a: UserRow, b: UserRow) {
  notify(a.id, b, REL.FRIEND);
  notify(b.id, a, REL.FRIEND);
  emitTo([a.id], 'presence:update', { userId: b.id, status: presenceOf(b.id) });
  emitTo([b.id], 'presence:update', { userId: a.id, status: presenceOf(a.id) });
}

export function findUserByQuery(query: string): UserRow | undefined {
  const q = query.trim().replace(/^@/, '');
  const code = q.toUpperCase().replace(/[\s#-]/g, '');
  if (/^[A-Z0-9]{8}$/.test(code)) {
    const byCode = get<UserRow>('SELECT * FROM users WHERE friend_code = ?', code);
    if (byCode) return byCode;
  }
  return get<UserRow>('SELECT * FROM users WHERE username = ?', q.toLowerCase());
}

export default async function relationshipRoutes(app: FastifyInstance) {
  /** Send a friend request by username or friend code. */
  app.post('/api/relationships', async (req) => {
    const me = auth(req);
    const { query } = parse(z.object({ query: z.string().trim().min(1, 'Type a username or friend code').max(64) }), req.body);
    const target = findUserByQuery(query);
    if (!target) throw notFound(NOT_FOUND);
    if (target.id === me.id) throw badRequest("That's you! Send this to a friend instead.");

    const mine = relationship(me.id, target.id);
    const theirs = relationship(target.id, me.id);
    if (theirs === REL.BLOCKED) throw notFound(NOT_FOUND);
    if (mine === REL.FRIEND) throw badRequest(`You're already friends with ${target.display_name}.`);
    if (mine === REL.BLOCKED) throw badRequest(`You blocked ${target.display_name}. Unblock them first.`);
    if (mine === REL.OUTGOING) throw badRequest(`You already sent ${target.display_name} a request.`);

    if (mine === REL.INCOMING) {
      tx(() => {
        upsert(me.id, target.id, REL.FRIEND);
        upsert(target.id, me.id, REL.FRIEND);
      });
      becameFriends(me, target);
      return { userId: target.id, type: REL.FRIEND, user: publicUser(target) };
    }

    tx(() => {
      upsert(me.id, target.id, REL.OUTGOING);
      upsert(target.id, me.id, REL.INCOMING);
    });
    notify(me.id, target, REL.OUTGOING);
    notify(target.id, me, REL.INCOMING);
    return { userId: target.id, type: REL.OUTGOING, user: publicUser(target) };
  });

  /** Accept a request ({type: "friend"}) or block someone ({type: "block"}). */
  app.put('/api/relationships/:userId', async (req) => {
    const me = auth(req);
    const { userId } = req.params as { userId: string };
    const { type } = parse(z.object({ type: z.enum(['friend', 'block']) }), req.body);
    const target = getUser(userId);
    if (!target || target.id === me.id) throw notFound('That user no longer exists');

    if (type === 'friend') {
      if (relationship(me.id, target.id) !== REL.INCOMING) throw badRequest('There is no request to accept');
      tx(() => {
        upsert(me.id, target.id, REL.FRIEND);
        upsert(target.id, me.id, REL.FRIEND);
      });
      becameFriends(me, target);
      return { userId: target.id, type: REL.FRIEND, user: publicUser(target) };
    }

    const theirs = relationship(target.id, me.id);
    tx(() => {
      upsert(me.id, target.id, REL.BLOCKED);
      if (theirs !== undefined && theirs !== REL.BLOCKED) {
        run('DELETE FROM relationships WHERE user_id = ? AND target_id = ?', target.id, me.id);
      }
    });
    notify(me.id, target, REL.BLOCKED);
    if (theirs !== undefined && theirs !== REL.BLOCKED) emitTo([target.id], 'relationship:remove', { userId: me.id });
    return { userId: target.id, type: REL.BLOCKED, user: publicUser(target) };
  });

  /** Remove a friend, cancel/decline a request, or unblock. */
  app.delete('/api/relationships/:userId', async (req) => {
    const me = auth(req);
    const { userId } = req.params as { userId: string };
    const mine = relationship(me.id, userId);
    if (mine === undefined) throw notFound('Nothing to remove');
    const theirs = relationship(userId, me.id);
    tx(() => {
      run('DELETE FROM relationships WHERE user_id = ? AND target_id = ?', me.id, userId);
      if (mine !== REL.BLOCKED && theirs !== undefined && theirs !== REL.BLOCKED) {
        run('DELETE FROM relationships WHERE user_id = ? AND target_id = ?', userId, me.id);
      }
    });
    emitTo([me.id], 'relationship:remove', { userId });
    if (mine !== REL.BLOCKED && theirs !== undefined && theirs !== REL.BLOCKED) {
      emitTo([userId], 'relationship:remove', { userId: me.id });
    }
    return { ok: true };
  });
}
