import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { userFromToken } from './auth.ts';
import { handleCallDisconnect, registerCallHandlers } from './calls.ts';
import { channelMembers, getUser, relatedUserIds, requireChannel } from './lib/model.ts';
import { sha256 } from './lib/util.ts';

export type Presence = 'online' | 'idle' | 'dnd' | 'offline';

export let io: Server;

/** userId -> socketId -> afk flag */
const connections = new Map<string, Map<string, { afk: boolean }>>();
const offlineTimers = new Map<string, NodeJS.Timeout>();
const announced = new Map<string, Presence>();
const chosenStatus = new Map<string, string>();

export function setChosenStatus(userId: string, status: string) {
  chosenStatus.set(userId, status);
}

function statusOf(userId: string): string {
  let s = chosenStatus.get(userId);
  if (!s) {
    s = getUser(userId)?.status ?? 'online';
    chosenStatus.set(userId, s);
  }
  return s;
}

export function presenceOf(userId: string): Presence {
  const conns = connections.get(userId);
  if (!conns || conns.size === 0 || offlineTimers.has(userId)) {
    // During the short reconnect grace period we keep reporting the last known presence.
    if (offlineTimers.has(userId)) return announced.get(userId) ?? 'offline';
    return 'offline';
  }
  const status = statusOf(userId);
  if (status === 'invisible') return 'offline';
  if (status === 'dnd') return 'dnd';
  if (status === 'idle') return 'idle';
  for (const c of conns.values()) if (!c.afk) return 'online';
  return 'idle';
}

/** True when the user has at least one connected device that is in use right now. */
export function isActive(userId: string): boolean {
  const conns = connections.get(userId);
  if (!conns) return false;
  for (const c of conns.values()) if (!c.afk) return true;
  return false;
}

export function isDnd(userId: string) {
  return statusOf(userId) === 'dnd';
}

export function presencesFor(userIds: Iterable<string>): Record<string, Presence> {
  const out: Record<string, Presence> = {};
  for (const id of userIds) {
    const p = presenceOf(id);
    if (p !== 'offline') out[id] = p;
  }
  return out;
}

export function refreshPresence(userId: string) {
  const next = presenceOf(userId);
  const prev = announced.get(userId) ?? 'offline';
  if (next === prev) return;
  announced.set(userId, next);
  emitTo([...relatedUserIds(userId), userId], 'presence:update', { userId, status: next });
}

export function emitTo(userIds: Iterable<string>, event: string, payload: unknown) {
  const rooms = [...new Set(userIds)].map((id) => `user:${id}`);
  if (rooms.length) io.to(rooms).emit(event, payload);
}

export function emitAll(event: string, payload: unknown) {
  io.emit(event, payload);
}

export function disconnectSession(tokenHash: string) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.tokenHash === tokenHash) socket.disconnect(true);
  }
}

export function disconnectUserExcept(userId: string, keepTokenHash: string) {
  for (const socket of io.sockets.sockets.values()) {
    if (socket.data.userId === userId && socket.data.tokenHash !== keepTokenHash) socket.disconnect(true);
  }
}

export function initRealtime(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: true, credentials: false },
    pingInterval: 20_000,
    pingTimeout: 25_000,
    maxHttpBufferSize: 1_000_000,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = typeof token === 'string' ? userFromToken(token) : undefined;
    if (!user) return next(new Error('unauthorized'));
    socket.data.userId = user.id;
    socket.data.tokenHash = sha256(token);
    chosenStatus.set(user.id, user.status);
    next();
  });

  io.on('connection', (socket: Socket) => {
    const userId = socket.data.userId as string;
    socket.join(`user:${userId}`);

    let conns = connections.get(userId);
    if (!conns) connections.set(userId, (conns = new Map()));
    conns.set(socket.id, { afk: false });
    const pending = offlineTimers.get(userId);
    if (pending) {
      clearTimeout(pending);
      offlineTimers.delete(userId);
    }
    refreshPresence(userId);

    socket.on('presence:afk', (afk: unknown) => {
      const state = connections.get(userId)?.get(socket.id);
      if (!state) return;
      state.afk = Boolean(afk);
      refreshPresence(userId);
    });

    socket.on('typing', (data: unknown) => {
      const channelId = typeof data === 'object' && data ? String((data as { channelId?: unknown }).channelId ?? '') : '';
      if (!channelId) return;
      try {
        const { channel } = requireChannel(userId, channelId);
        emitTo(
          channelMembers(channel).filter((id) => id !== userId),
          'typing:start',
          { channelId, userId },
        );
      } catch {
        /* ignore typing for channels the user can't see */
      }
    });

    registerCallHandlers(socket);

    socket.on('disconnect', () => {
      handleCallDisconnect(socket);
      const current = connections.get(userId);
      current?.delete(socket.id);
      if (!current || current.size === 0) {
        connections.delete(userId);
        // Short grace period so a page reload doesn't flash the user offline for everyone.
        offlineTimers.set(
          userId,
          setTimeout(() => {
            offlineTimers.delete(userId);
            refreshPresence(userId);
          }, 5_000),
        );
      } else {
        refreshPresence(userId);
      }
    });
  });

  return io;
}
