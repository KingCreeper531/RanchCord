import type { Socket } from 'socket.io';
import { config, livekitEnabled } from './config.ts';
import { get } from './lib/db.ts';
import {
  type ChannelRow,
  channelMembers,
  dmRecipientId,
  getChannel,
  getMember,
  getUser,
  isBlockedEither,
  isTimedOut,
  requireChannel,
} from './lib/model.ts';
import { PERM, requirePerm } from './lib/perms.ts';
import { badRequest, forbidden, signJwt } from './lib/util.ts';
import { emitTo, io } from './realtime.ts';

/**
 * Call signaling. Every DM and every group voice channel can host one call, with no limit on how many people join.
 * Media goes peer-to-peer (mesh) by default, or through a LiveKit SFU when it is configured.
 */

interface VoiceFlags {
  muted: boolean;
  deafened: boolean;
  video: boolean;
  screen: boolean;
}

interface Participant extends VoiceFlags {
  userId: string;
  socketId: string | null;
  joinedAt: number;
  dropTimer?: NodeJS.Timeout;
}

const rooms = new Map<string, Map<string, Participant>>();
const userRoom = new Map<string, string>();
const rings = new Map<string, { callerId: string; targets: Set<string>; timer: NodeJS.Timeout }>();

const RING_MS = 45_000;
const RECONNECT_GRACE_MS = 20_000;

function flags(input: unknown): VoiceFlags {
  const d = (typeof input === 'object' && input ? input : {}) as Record<string, unknown>;
  return { muted: Boolean(d.muted), deafened: Boolean(d.deafened), video: Boolean(d.video), screen: Boolean(d.screen) };
}

function publicState(p: Participant) {
  return {
    userId: p.userId,
    muted: p.muted,
    deafened: p.deafened,
    video: p.video,
    screen: p.screen,
    joinedAt: p.joinedAt,
  };
}

function broadcastVoice(channel: ChannelRow | undefined, userId: string, p: Participant | null) {
  if (!channel) return;
  emitTo(channelMembers(channel), 'voice:state', {
    channelId: channel.id,
    userId,
    state: p ? publicState(p) : null,
  });
}

function canSee(userId: string, channel: ChannelRow) {
  if (channel.type === 'dm') {
    return Boolean(get('SELECT 1 FROM dm_members WHERE channel_id = ? AND user_id = ?', channel.id, userId));
  }
  return Boolean(channel.group_id && getMember(channel.group_id, userId));
}

export function voiceStatesFor(userId: string) {
  const out: (ReturnType<typeof publicState> & { channelId: string })[] = [];
  for (const [channelId, room] of rooms) {
    const channel = getChannel(channelId);
    if (!channel || !canSee(userId, channel)) continue;
    for (const p of room.values()) out.push({ channelId, ...publicState(p) });
  }
  return out;
}

export function ringsFor(userId: string) {
  const out: { channelId: string; callerId: string }[] = [];
  for (const [channelId, ring] of rings) if (ring.targets.has(userId)) out.push({ channelId, callerId: ring.callerId });
  return out;
}

function sfuInfo(channelId: string, userId: string) {
  if (!livekitEnabled) return null;
  const user = getUser(userId);
  const t = Math.floor(Date.now() / 1000);
  const token = signJwt(
    {
      iss: config.livekit.apiKey,
      sub: userId,
      name: user?.display_name ?? userId,
      nbf: t - 30,
      exp: t + 12 * 3600,
      video: { room: channelId, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
    },
    config.livekit.apiSecret,
  );
  return { url: config.livekit.url, token };
}

function joinInfo(channelId: string, userId: string) {
  const room = rooms.get(channelId);
  return {
    channelId,
    participants: room ? [...room.values()].map(publicState) : [],
    iceServers: config.iceServers,
    mode: livekitEnabled ? ('sfu' as const) : ('p2p' as const),
    sfu: sfuInfo(channelId, userId),
  };
}

function startRing(channelId: string, callerId: string, targets: string[]) {
  const previous = rings.get(channelId);
  if (previous) clearTimeout(previous.timer);
  const ring = {
    callerId,
    targets: new Set(targets),
    timer: setTimeout(() => {
      const current = rings.get(channelId);
      if (current !== ring) return;
      rings.delete(channelId);
      emitTo(ring.targets, 'call:ring-end', { channelId });
      io.to(`call:${channelId}`).emit('call:ring-timeout', { channelId });
    }, RING_MS),
  };
  rings.set(channelId, ring);
  emitTo(targets, 'call:ring', { channelId, callerId });
}

function stopRingFor(channelId: string, userId: string) {
  const ring = rings.get(channelId);
  if (!ring || !ring.targets.delete(userId)) return;
  emitTo([userId], 'call:ring-end', { channelId });
  if (ring.targets.size === 0) {
    clearTimeout(ring.timer);
    rings.delete(channelId);
  }
}

function endRing(channelId: string) {
  const ring = rings.get(channelId);
  if (!ring) return;
  clearTimeout(ring.timer);
  rings.delete(channelId);
  emitTo(ring.targets, 'call:ring-end', { channelId });
}

function removeParticipant(channelId: string, userId: string) {
  const room = rooms.get(channelId);
  const p = room?.get(userId);
  if (!room || !p) return;
  clearTimeout(p.dropTimer);
  room.delete(userId);
  if (userRoom.get(userId) === channelId) userRoom.delete(userId);
  if (p.socketId) io.sockets.sockets.get(p.socketId)?.leave(`call:${channelId}`);
  io.to(`call:${channelId}`).emit('call:peer-left', { channelId, userId });
  broadcastVoice(getChannel(channelId), userId, null);
  if (room.size === 0) {
    rooms.delete(channelId);
    endRing(channelId);
  }
}

function leaveCurrent(userId: string, reason: string, except?: string) {
  const channelId = userRoom.get(userId);
  if (!channelId) return;
  const p = rooms.get(channelId)?.get(userId);
  if (p?.socketId && p.socketId !== except) io.to(p.socketId).emit('call:ended', { channelId, reason });
  removeParticipant(channelId, userId);
}

/** Ends every call in a channel, e.g. when the channel or its group is deleted. */
export function endCall(channelId: string, reason = 'ended') {
  const room = rooms.get(channelId);
  if (!room) return;
  for (const p of [...room.values()]) {
    if (p.socketId) io.to(p.socketId).emit('call:ended', { channelId, reason });
    removeParticipant(channelId, p.userId);
  }
}

/** Removes a user from any call in the given channels (used when they leave or are kicked from a group). */
export function kickFromCalls(userId: string, channelIds: string[]) {
  const channelId = userRoom.get(userId);
  if (channelId && channelIds.includes(channelId)) leaveCurrent(userId, 'removed');
}

export function registerCallHandlers(socket: Socket) {
  const userId = socket.data.userId as string;

  socket.on('call:join', (data: unknown, ack: unknown) => {
    const reply = typeof ack === 'function' ? (ack as (res: unknown) => void) : () => {};
    try {
      const d = (typeof data === 'object' && data ? data : {}) as Record<string, unknown>;
      const channelId = String(d.channelId ?? '');
      const { channel, member } = requireChannel(userId, channelId);
      if (channel.type !== 'dm' && channel.type !== 'voice') throw badRequest('Calls happen in DMs and voice channels');
      if (member) requirePerm(member, PERM.CONNECT_VOICE, "You don't have permission to join this voice channel");
      if (isTimedOut(member)) throw forbidden("You're timed out in this group for now");
      let ringTarget: string | undefined;
      if (channel.type === 'dm') {
        ringTarget = dmRecipientId(channel.id, userId);
        if (ringTarget && isBlockedEither(userId, ringTarget)) throw forbidden("You can't call this person");
      }

      const existing = rooms.get(channelId)?.get(userId);
      if (existing && d.resume && (existing.socketId === null || existing.socketId === socket.id)) {
        // Same device came back after a dropped connection: keep the call going without renegotiating.
        clearTimeout(existing.dropTimer);
        existing.dropTimer = undefined;
        existing.socketId = socket.id;
        Object.assign(existing, flags(d));
        socket.join(`call:${channelId}`);
        reply({ ok: true, resumed: true, ...joinInfo(channelId, userId) });
        socket.to(`call:${channelId}`).emit('call:peer-state', { channelId, ...publicState(existing) });
        broadcastVoice(channel, userId, existing);
        return;
      }

      // One call per user: joining here moves them out of anything else (including on another device).
      leaveCurrent(userId, existing ? 'moved' : 'switched', socket.id);

      let room = rooms.get(channelId);
      if (!room) rooms.set(channelId, (room = new Map()));
      const p: Participant = { userId, socketId: socket.id, joinedAt: Date.now(), ...flags(d) };
      room.set(userId, p);
      userRoom.set(userId, channelId);
      socket.join(`call:${channelId}`);

      reply({ ok: true, resumed: false, ...joinInfo(channelId, userId) });
      socket.to(`call:${channelId}`).emit('call:peer-joined', { channelId, ...publicState(p) });
      broadcastVoice(channel, userId, p);
      stopRingFor(channelId, userId);

      if (ringTarget && !room.has(ringTarget) && !rings.has(channelId)) startRing(channelId, userId, [ringTarget]);
    } catch (err) {
      reply({ ok: false, error: err instanceof Error ? err.message : 'Could not join the call' });
    }
  });

  socket.on('call:leave', () => {
    const channelId = userRoom.get(userId);
    if (!channelId) return;
    const p = rooms.get(channelId)?.get(userId);
    if (p && (p.socketId === socket.id || p.socketId === null)) removeParticipant(channelId, userId);
  });

  socket.on('call:state', (data: unknown) => {
    const channelId = userRoom.get(userId);
    if (!channelId) return;
    const p = rooms.get(channelId)?.get(userId);
    if (!p || p.socketId !== socket.id) return;
    Object.assign(p, flags(data));
    socket.to(`call:${channelId}`).emit('call:peer-state', { channelId, ...publicState(p) });
    broadcastVoice(getChannel(channelId), userId, p);
  });

  socket.on('call:signal', (data: unknown) => {
    const d = (typeof data === 'object' && data ? data : {}) as Record<string, unknown>;
    const channelId = String(d.channelId ?? '');
    const room = rooms.get(channelId);
    const me = room?.get(userId);
    if (!room || !me || me.socketId !== socket.id) return;
    const target = room.get(String(d.to ?? ''));
    if (!target?.socketId) return;
    io.to(target.socketId).emit('call:signal', { channelId, from: userId, data: d.data });
  });

  socket.on('call:ring', (data: unknown) => {
    const channelId = String((data as { channelId?: unknown } | null)?.channelId ?? '');
    const room = rooms.get(channelId);
    if (!room?.has(userId)) return;
    const channel = getChannel(channelId);
    if (channel?.type !== 'dm') return;
    const other = dmRecipientId(channelId, userId);
    if (other && !room.has(other) && !isBlockedEither(userId, other)) startRing(channelId, userId, [other]);
  });

  socket.on('call:sound', (data: unknown) => {
    const soundId = String((data as { soundId?: unknown } | null)?.soundId ?? '');
    const channelId = userRoom.get(userId);
    if (!channelId || !soundId) return;
    const p = rooms.get(channelId)?.get(userId);
    if (!p || p.socketId !== socket.id) return;
    if (!get('SELECT 1 FROM sounds WHERE id = ?', soundId)) return;
    try {
      const { member } = requireChannel(userId, channelId);
      if (member) requirePerm(member, PERM.USE_SOUNDBOARD);
    } catch {
      return;
    }
    io.to(`call:${channelId}`).emit('call:sound', { channelId, userId, soundId });
  });

  socket.on('call:decline', (data: unknown) => {
    const channelId = String((data as { channelId?: unknown } | null)?.channelId ?? '');
    const ring = rings.get(channelId);
    if (!ring?.targets.has(userId)) return;
    stopRingFor(channelId, userId);
    io.to(`call:${channelId}`).emit('call:declined', { channelId, userId });
  });
}

export function handleCallDisconnect(socket: Socket) {
  const userId = socket.data.userId as string;
  const channelId = userRoom.get(userId);
  if (!channelId) return;
  const p = rooms.get(channelId)?.get(userId);
  if (!p || p.socketId !== socket.id) return;
  p.socketId = null;
  p.dropTimer = setTimeout(() => removeParticipant(channelId, userId), RECONNECT_GRACE_MS);
}
