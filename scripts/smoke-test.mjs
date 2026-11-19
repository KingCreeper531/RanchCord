// End-to-end API + realtime smoke test. Starts nothing itself: point it at a running server.
// Usage: node scripts/smoke-test.mjs http://localhost:6499
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'client', 'package.json'));
const { io } = require('socket.io-client');

const BASE = process.argv[2] ?? 'http://localhost:6499';
let failures = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
};

async function api(method, p, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, { method, headers, body: payload });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(`${method} ${p} -> ${res.status} ${data?.error}`), { status: res.status, data });
  return data;
}

function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'] });
  const events = [];
  s.onAny((ev, payload) => events.push({ ev, payload }));
  return new Promise((resolve, reject) => {
    s.on('connect', () => resolve({ s, events }));
    s.on('connect_error', reject);
  });
}

const waitFor = async (events, ev, pred = () => true, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find((e) => e.ev === ev && pred(e.payload));
    if (hit) return hit.payload;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
};

const stamp = Date.now().toString(36).slice(-5);
const PW = `pw-${stamp}-test`;

console.log(`Smoke test against ${BASE}`);
const inst = await api('GET', '/api/instance');
ok(inst.name === 'RanchCord', 'instance info');

const a = await api('POST', '/api/auth/register', undefined, { username: `alice_${stamp}`, password: PW, displayName: 'Alice' });
const b = await api('POST', '/api/auth/register', undefined, { username: `bob_${stamp}`, password: PW, displayName: 'Bob' });
ok(a.token && b.token, 'register two users');
const relogin = await api('POST', '/api/auth/login', undefined, { username: `ALICE_${stamp}`, password: PW });
ok(relogin.user.id === a.user.id, 'login is case-insensitive');
try {
  await api('POST', '/api/auth/login', undefined, { username: `alice_${stamp}`, password: 'wrong' });
  ok(false, 'wrong password rejected');
} catch (e) {
  ok(e.status === 401, 'wrong password rejected');
}

const A = await connect(a.token);
const B = await connect(b.token);
ok(true, 'both sockets connected');

// friend by friend code
const fc = a.user.friendCode;
const req = await api('POST', '/api/relationships', b.token, { query: `${fc.slice(0, 4)}-${fc.slice(4)}` });
ok(req.type === 4, 'friend request by friend code (outgoing)');
ok(await waitFor(A.events, 'relationship:update', (p) => p.type === 3), 'alice sees incoming request');
await api('PUT', `/api/relationships/${b.user.id}`, a.token, { type: 'friend' });
ok(await waitFor(B.events, 'relationship:update', (p) => p.type === 1), 'bob sees accepted friendship');
ok(await waitFor(B.events, 'presence:update', (p) => p.userId === a.user.id && p.status === 'online'), 'bob sees alice online');

// DM
const dm = await api('POST', '/api/dms', a.token, { userId: b.user.id });
ok(dm.type === 'dm' && dm.recipientId === b.user.id, 'open DM');
const m1 = await api('POST', `/api/channels/${dm.id}/messages`, a.token, { content: `hey <@${b.user.id}> **bold** :joy:`, nonce: 'n1' });
ok(m1.nonce === 'n1', 'send message (nonce echoed)');
ok(await waitFor(B.events, 'dm:open', (p) => p.id === dm.id), 'bob gets the DM opened');
ok(await waitFor(B.events, 'message:create', (p) => p.id === m1.id), 'bob receives message live');
const bootB = await api('GET', '/api/bootstrap', b.token);
ok(bootB.readStates.find((r) => r.channelId === dm.id)?.mentionCount === 1, 'bob has 1 unread mention');
await api('PUT', `/api/channels/${dm.id}/messages/${m1.id}/reactions/${encodeURIComponent('🔥')}`, b.token);
ok(await waitFor(A.events, 'reaction:add', (p) => p.emoji === '🔥'), 'reaction delivered');
const reply = await api('POST', `/api/channels/${dm.id}/messages`, b.token, { content: 'replying', replyToId: m1.id });
ok(reply.replyTo?.id === m1.id && reply.replyTo.author.id === a.user.id, 'reply references original');
await api('PATCH', `/api/channels/${dm.id}/messages/${m1.id}`, a.token, { content: 'edited text' });
ok(await waitFor(B.events, 'message:update', (p) => p.content === 'edited text'), 'edit delivered');
const page = await api('GET', `/api/channels/${dm.id}/messages?limit=50`, a.token);
ok(page.length === 2 && page[0].reactions[0]?.count === 1, 'history with reactions');
await api('POST', `/api/channels/${dm.id}/ack`, b.token, { messageId: reply.id });
B.s.emit('typing', { channelId: dm.id });
ok(await waitFor(A.events, 'typing:start', (p) => p.userId === b.user.id), 'typing indicator');

// uploads
const fd = new FormData();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAEklEQVR4nGNgYGD4z8DAwMDAAAAOAAFT3P2vAAAAAElFTkSuQmCC', 'base64');
fd.append('file', new Blob([png], { type: 'image/png' }), 'tiny.png');
// Sending files needs your own storage (scripts/storage-test.mjs covers the full flow with a bucket).
try {
  await api('POST', '/api/uploads', a.token, { filename: 'tiny.png', size: png.length, contentType: 'image/png', width: 2, height: 3 });
  ok(false, 'sending files needs your own storage');
} catch (e) {
  ok(e.status === 403 && e.data?.code === 'storage_required', 'sending files needs your own storage');
}
ok((await api('GET', '/api/storage', a.token)).linked === false, 'storage starts unlinked');
try {
  await api('POST', '/api/uploads', a.token, fd);
  ok(false, 'old-style uploads are refused');
} catch (e) {
  ok(e.status === 400, 'old-style uploads are refused');
}

// groups + invites
const g = await api('POST', '/api/groups', a.token, { name: 'Ranch Hands' });
ok(g.channels.length === 2, 'group created with text + voice channels');
const inv = await api('GET', `/api/groups/${g.id}/invite`, a.token);
const prev = await api('GET', `/api/invites/${inv.code}`, b.token);
ok(prev.group.name === 'Ranch Hands' && !prev.joined, 'invite preview');
await api('POST', `/api/invites/${inv.code}`, b.token);
ok(await waitFor(A.events, 'group:member-add', (p) => p.user.id === b.user.id), 'owner sees new member');
ok(await waitFor(A.events, 'message:create', (p) => p.type === 'join'), 'join message posted');
const text = g.channels.find((c) => c.type === 'text');
const everyone = await api('POST', `/api/channels/${text.id}/messages`, a.token, { content: '@everyone hi' });
ok(everyone.id, 'group message');
const ch = await api('POST', `/api/groups/${g.id}/channels`, a.token, { name: 'Memes & Stuff', type: 'text' });
ok(ch.name === 'memes-stuff', 'channel name normalised');
try {
  await api('POST', `/api/groups/${g.id}/channels`, b.token, { name: 'nope' });
  ok(false, 'members cannot create channels');
} catch (e) {
  ok(e.status === 403, 'members cannot create channels');
}

// roles & permissions
const role = await api('POST', `/api/groups/${g.id}/roles`, a.token, { name: 'Mods', color: '#e5534b', permissions: 4 /* MANAGE_CHANNELS */, hoist: true });
ok(role.name === 'Mods' && role.position === 1, 'create role');
await api('PUT', `/api/groups/${g.id}/members/${b.user.id}/roles/${role.id}`, a.token);
ok(await waitFor(B.events, 'group:member-update', (p) => p.member.roles.includes(role.id)), 'assign role broadcast');
const modChannel = await api('POST', `/api/groups/${g.id}/channels`, b.token, { name: 'mod-chat', type: 'text' });
ok(modChannel.name === 'mod-chat', 'role permission lets bob create channels');
try {
  await api('POST', `/api/groups/${g.id}/roles`, b.token, { name: 'nope' });
  ok(false, 'bob cannot manage roles');
} catch (e) {
  ok(e.status === 403, 'bob cannot manage roles');
}
const rolePing = await api('POST', `/api/channels/${text.id}/messages`, a.token, { content: `<@&${role.id}> meeting` });
ok(rolePing.id, 'role mention message');
const bootB2 = await api('GET', '/api/bootstrap', b.token);
ok((bootB2.readStates.find((r) => r.channelId === text.id)?.mentionCount ?? 0) >= 2, 'role mention pings role members');
ok(bootB2.groups.find((x) => x.id === g.id)?.roles.length === 1, 'roles in bootstrap');
await api('DELETE', `/api/groups/${g.id}/members/${b.user.id}/roles/${role.id}`, a.token);
try {
  await api('POST', `/api/groups/${g.id}/channels`, b.token, { name: 'again' });
  ok(false, 'removing role removes permission');
} catch (e) {
  ok(e.status === 403, 'removing role removes permission');
}
await api('DELETE', `/api/groups/${g.id}/roles/${role.id}`, a.token);
try {
  await api('PATCH', '/api/instance', b.token, { name: 'Hacked' });
  ok(false, 'only the server admin can rename the app');
} catch (e) {
  ok(e.status === 403, 'only the server admin can rename the app');
}

// emoji + sound
const ef = new FormData();
ef.append('name', `ranch_${stamp}`);
ef.append('file', new Blob([png], { type: 'image/png' }), 'e.png');
const emoji = await api('POST', '/api/emojis', a.token, ef);
ok(emoji.name === `ranch_${stamp}`, 'photo emoji upload');
ok(await waitFor(B.events, 'emoji:create', (p) => p.id === emoji.id), 'emoji broadcast');
await api('PUT', `/api/channels/${text.id}/messages/${everyone.id}/reactions/${encodeURIComponent('c:' + emoji.id)}`, b.token);
ok(await waitFor(A.events, 'reaction:add', (p) => p.emoji === `c:${emoji.id}`), 'custom emoji reaction');

// stickers people upload
const stickerForm = new FormData();
stickerForm.append('name', 'Ranch dance');
stickerForm.append('file', new Blob([png], { type: 'image/png' }), 's.png');
const sticker = await api('POST', '/api/stickers', a.token, stickerForm);
ok(sticker.name === 'Ranch dance' && sticker.url.startsWith('/files/stickers/') && sticker.width === 2, 'sticker upload');
ok((await fetch(BASE + sticker.url)).ok, 'sticker pictures load');
ok(await waitFor(B.events, 'sticker:create', (p) => p.id === sticker.id), 'new stickers show up for everyone');
ok((await api('GET', '/api/bootstrap', b.token)).stickers?.some((s) => s.id === sticker.id), 'stickers load on startup');
const stickerEmbed = { kind: 'media', type: 'sticker', slug: `stk:${sticker.id}`, title: sticker.name, url: sticker.url, mp4: null, webp: null, preview: null, width: sticker.width, height: sticker.height };
ok((await api('POST', `/api/channels/${text.id}/messages`, b.token, { content: '', embeds: [stickerEmbed] })).embeds?.[0]?.type === 'sticker', 'an uploaded sticker can be sent');
try {
  await api('DELETE', `/api/stickers/${sticker.id}`, b.token);
  ok(false, "people can't delete someone else's sticker");
} catch (e) {
  ok(e.status === 403, "people can't delete someone else's sticker");
}
ok((await api('PATCH', `/api/stickers/${sticker.id}`, a.token, { name: 'Ranch dance 2' })).name === 'Ranch dance 2', 'sticker renamed');
await api('DELETE', `/api/stickers/${sticker.id}`, a.token);
ok(await waitFor(B.events, 'sticker:delete', (p) => p.id === sticker.id), 'deleted stickers disappear for everyone');
const wav = Buffer.alloc(44 + 800);
wav.write('RIFF', 0);
wav.writeUInt32LE(36 + 800, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(8000, 28);
wav.writeUInt16LE(1, 32);
wav.writeUInt16LE(8, 34);
wav.write('data', 36);
wav.writeUInt32LE(800, 40);
const sf = new FormData();
sf.append('name', 'beep');
sf.append('emoji', '📢');
sf.append('duration', '0.1');
sf.append('file', new Blob([wav], { type: 'audio/wav' }), 'beep.wav');
const sound = await api('POST', '/api/sounds', a.token, sf);
ok(sound.url.endsWith('.wav'), 'sound upload');

// calls: DM call rings bob, signaling relays, soundboard plays
const voice = g.channels.find((c) => c.type === 'voice');
const joinA = await A.s.timeout(4000).emitWithAck('call:join', { channelId: dm.id });
ok(joinA.ok && joinA.mode === 'p2p' && joinA.participants.length === 1, 'alice starts a DM call');
ok(await waitFor(B.events, 'call:ring', (p) => p.channelId === dm.id), 'bob is rung');
const joinB = await B.s.timeout(4000).emitWithAck('call:join', { channelId: dm.id });
ok(joinB.ok && joinB.participants.length === 2, 'bob answers');
ok(await waitFor(B.events, 'call:ring-end'), 'ringing stops');
ok(await waitFor(A.events, 'call:peer-joined', (p) => p.userId === b.user.id), 'alice sees bob join');
B.s.emit('call:signal', { channelId: dm.id, to: a.user.id, data: { description: { type: 'offer', sdp: 'x' } } });
ok(await waitFor(A.events, 'call:signal', (p) => p.from === b.user.id), 'signaling relayed');
B.s.emit('call:state', { muted: true, deafened: false, video: true, screen: false });
ok(await waitFor(A.events, 'call:peer-state', (p) => p.muted && p.video), 'mute/video state relayed');
A.s.emit('call:sound', { soundId: sound.id });
ok(await waitFor(B.events, 'call:sound', (p) => p.soundId === sound.id), 'soundboard plays for the call');
const joinVoice = await B.s.timeout(4000).emitWithAck('call:join', { channelId: voice.id });
ok(joinVoice.ok, 'bob moves to the group voice channel');
ok(await waitFor(A.events, 'call:peer-left', (p) => p.userId === b.user.id), 'alice sees bob leave the DM call');
ok(await waitFor(A.events, 'voice:state', (p) => p.channelId === voice.id && p.userId === b.user.id), 'voice channel state broadcast');
A.s.emit('call:leave');
B.s.emit('call:leave');

// nuking a DM wipes it for both people
await api('POST', `/api/channels/${dm.id}/messages`, a.token, { content: 'this is about to get nuked' });
const nuked = await api('POST', `/api/channels/${dm.id}/nuke`, b.token);
ok(nuked.deleted >= 1, 'either person can nuke a DM');
ok(await waitFor(A.events, 'channel:nuked', (p) => p.channelId === dm.id && p.by === b.user.id), 'the other person sees the chat get nuked');
const afterNuke = await api('GET', `/api/channels/${dm.id}/messages?limit=50`, a.token);
ok(afterNuke.length === 1 && afterNuke[0].type === 'nuke' && afterNuke[0].author.id === b.user.id, 'only the "nuked this chat" notice is left');
try {
  await api('POST', `/api/channels/${text.id}/nuke`, a.token);
  ok(false, "group channels can't be nuked");
} catch (e) {
  ok(e.status === 400, "group channels can't be nuked");
}

// favourite GIFs + personal background
const favGif = { kind: 'klipy', type: 'gif', slug: 'ranch-dance-1', title: 'Ranch dance', url: 'https://static.klipy.com/ii/test/ranch.gif', mp4: null, webp: null, preview: null, width: 220, height: 160 };
const favs = await api('PUT', '/api/favorites', a.token, favGif);
ok(favs.length === 1 && favs[0].slug === favGif.slug, 'gif favorited');
ok(await waitFor(A.events, 'favorites:update', (p) => p.length === 1), 'favorites sync to your other devices');
ok((await api('GET', '/api/bootstrap', a.token)).favorites?.[0]?.slug === favGif.slug, 'favorites load on startup');
ok((await api('DELETE', `/api/favorites/gif/${favGif.slug}`, a.token)).length === 0, 'gif unfavorited');
try {
  await api('PUT', '/api/favorites', a.token, { ...favGif, url: 'https://evil.example.com/x.gif' });
  ok(false, 'picker GIFs must be KLIPY links');
} catch (e) {
  ok(e.status === 400, 'picker GIFs must be KLIPY links');
}
// GIFs people upload or link can be favorited and sent again too
const linkGif = { kind: 'media', type: 'gif', slug: 'url:abc123', title: '', url: 'https://media.example.com/dance.gif', mp4: null, webp: null, preview: null, width: 300, height: 200 };
const fileGif = { ...linkGif, slug: 'att:01ABC', url: '/files/attachments/01ABC/dance.gif' };
ok((await api('PUT', '/api/favorites', a.token, linkGif)).some((f) => f.slug === linkGif.slug), 'a linked GIF can be favorited');
ok((await api('PUT', '/api/favorites', a.token, fileGif)).some((f) => f.slug === fileGif.slug), 'an uploaded GIF can be favorited');
const resent = await api('POST', `/api/channels/${text.id}/messages`, a.token, { content: '', embeds: [fileGif] });
ok(resent.embeds?.[0]?.kind === 'media', 'a favorited GIF can be sent again');
for (const bad of ['http://plain.example.com/x.gif', 'javascript:alert(1)', '/files/../data/secret.key', '/api/bootstrap']) {
  try {
    await api('PUT', '/api/favorites', a.token, { ...linkGif, slug: 'url:bad', url: bad });
    ok(false, `refuses a GIF link like ${bad}`);
  } catch (e) {
    ok(e.status === 400, `refuses a GIF link like ${bad}`);
  }
}
await api('DELETE', `/api/favorites/gif/${encodeURIComponent(linkGif.slug)}`, a.token);
ok((await api('DELETE', `/api/favorites/gif/${encodeURIComponent(fileGif.slug)}`, a.token)).length === 0, 'GIF favorites removed');
const withBg = await api('PATCH', '/api/users/@me', a.token, { background: 'preset:ranch' });
ok(withBg.background === 'preset:ranch', 'background preset saved');
const bgForm = new FormData();
bgForm.append('file', new Blob([png], { type: 'image/png' }), 'bg.png');
const withPhoto = await api('POST', '/api/users/@me/background', a.token, bgForm);
const bgRes = await fetch(BASE + withPhoto.background);
ok(withPhoto.background?.startsWith('/files/avatars/') && bgRes.ok, 'background photo uploaded');
ok(bgRes.headers.get('content-security-policy')?.includes('sandbox'), 'server files are served sandboxed');
const bobView = await api('GET', `/api/users/${a.user.id}`, b.token);
ok(!('background' in (bobView.user ?? bobView)), 'backgrounds stay private');
ok(!(await api('PATCH', '/api/users/@me', a.token, { background: null })).background, 'background removed');

// group settings: categories and channel order
ok(g.categories?.length === 2 && g.channels.every((c) => c.categoryId), 'new groups come with Text and Voice channel categories');
const cat = await api('POST', `/api/groups/${g.id}/categories`, a.token, { name: 'Games' });
ok(await waitFor(B.events, 'group:layout', (p) => p.groupId === g.id && p.categories.some((c) => c.id === cat.id)), 'a new category shows up for everyone');
ok((await api('PATCH', `/api/channels/${ch.id}`, a.token, { categoryId: cat.id })).categoryId === cat.id, 'a channel can move into a category');
const before = (await api('GET', '/api/bootstrap', a.token)).groups.find((x) => x.id === g.id);
const order = [...before.channels].sort((x, y) => x.position - y.position).reverse();
await api('PUT', `/api/groups/${g.id}/layout`, a.token, {
  categories: [cat.id, ...before.categories.filter((c) => c.id !== cat.id).map((c) => c.id)],
  channels: order.map((c) => ({ id: c.id, categoryId: c.categoryId })),
});
const after = (await api('GET', '/api/bootstrap', a.token)).groups.find((x) => x.id === g.id);
ok(after.categories.find((c) => c.id === cat.id).position === 0, 'categories can be reordered');
ok(after.channels.find((c) => c.id === order[0].id).position === 0, 'channels can be reordered');
try {
  await api('PUT', `/api/groups/${g.id}/layout`, b.token, { categories: [], channels: [] });
  ok(false, 'only channel managers can rearrange channels');
} catch (e) {
  ok(e.status === 403, 'only channel managers can rearrange channels');
}
await api('DELETE', `/api/groups/${g.id}/categories/${cat.id}`, a.token);
const afterDelete = (await api('GET', '/api/bootstrap', a.token)).groups.find((x) => x.id === g.id);
ok(afterDelete.channels.find((c) => c.id === ch.id).categoryId === null, "deleting a category keeps its channels");

// audit log
const log = await api('GET', `/api/groups/${g.id}/audit-log`, a.token);
const logged = new Set(log.entries.map((e) => e.action));
ok(['role_create', 'member_role_add', 'channel_create', 'category_create', 'channels_move'].every((x) => logged.has(x)), 'the audit log records role and channel changes');
ok(log.users[a.user.id]?.id === a.user.id, 'the audit log says who did it');
try {
  await api('GET', `/api/groups/${g.id}/audit-log`, b.token);
  ok(false, "people without permission can't read the audit log");
} catch (e) {
  ok(e.status === 403, "people without permission can't read the audit log");
}

// timeouts
await api('PUT', `/api/groups/${g.id}/members/${b.user.id}/timeout`, a.token, { minutes: 5 });
ok(await waitFor(B.events, 'group:member-update', (p) => p.member.userId === b.user.id && p.member.timeoutUntil > Date.now()), 'a timeout shows up for everyone');
try {
  await api('POST', `/api/channels/${text.id}/messages`, b.token, { content: 'can I talk?' });
  ok(false, "timed-out people can't send messages");
} catch (e) {
  ok(e.status === 403, "timed-out people can't send messages");
}
try {
  await api('PUT', `/api/channels/${text.id}/messages/${everyone.id}/reactions/${encodeURIComponent('👍')}`, b.token);
  ok(false, "timed-out people can't react");
} catch (e) {
  ok(e.status === 403, "timed-out people can't react");
}
await api('PUT', `/api/groups/${g.id}/members/${b.user.id}/timeout`, a.token, { minutes: 0 });
ok((await api('POST', `/api/channels/${text.id}/messages`, b.token, { content: 'back!' })).id, 'a timeout can be lifted early');

// kicks and bans
const inv2 = await api('GET', `/api/groups/${g.id}/invite`, a.token);
await api('DELETE', `/api/groups/${g.id}/members/${b.user.id}`, a.token);
ok((await api('GET', `/api/groups/${g.id}/audit-log?action=member_kick`, a.token)).entries[0]?.targetId === b.user.id, 'kicks are in the audit log');
await api('POST', `/api/invites/${inv2.code}`, b.token);
await api('PUT', `/api/groups/${g.id}/bans/${b.user.id}`, a.token, { reason: 'testing bans' });
const bans = await api('GET', `/api/groups/${g.id}/bans`, a.token);
ok(bans[0]?.user.id === b.user.id && bans[0].reason === 'testing bans', 'bans are listed with the reason');
ok(!(await api('GET', '/api/bootstrap', b.token)).groups.some((x) => x.id === g.id), 'banning removes them from the group');
try {
  await api('POST', `/api/invites/${inv2.code}`, b.token);
  ok(false, "banned people can't rejoin with an invite");
} catch (e) {
  ok(e.status === 403, "banned people can't rejoin with an invite");
}
await api('DELETE', `/api/groups/${g.id}/bans/${b.user.id}`, a.token);
await api('POST', `/api/invites/${inv2.code}`, b.token);
ok((await api('GET', '/api/bootstrap', b.token)).groups.some((x) => x.id === g.id), 'unbanned people can come back');

// pins
const toPin = await api('POST', `/api/channels/${text.id}/messages`, b.token, { content: 'pin me' });
try {
  await api('PUT', `/api/channels/${text.id}/pins/${toPin.id}`, b.token);
  ok(false, 'pinning in a group takes Manage Messages');
} catch (e) {
  ok(e.status === 403, 'pinning in a group takes Manage Messages');
}
await api('PUT', `/api/channels/${text.id}/pins/${toPin.id}`, a.token);
ok(await waitFor(B.events, 'message:pin', (p) => p.id === toPin.id && p.pinnedAt), 'a pin shows up for everyone');
const pins = await api('GET', `/api/channels/${text.id}/pins`, b.token);
ok(pins.length === 1 && pins[0].id === toPin.id && pins[0].pinnedAt, 'pinned messages are listed');
ok(await waitFor(B.events, 'message:create', (p) => p.type === 'pin' && p.replyTo?.id === toPin.id), 'a "pinned a message" notice is posted');
ok((await api('GET', `/api/groups/${g.id}/audit-log?action=message_pin`, a.token)).entries.length === 1, 'pins are in the audit log');
await api('DELETE', `/api/channels/${text.id}/pins/${toPin.id}`, a.token);
ok((await api('GET', `/api/channels/${text.id}/pins`, b.token)).length === 0, 'messages can be unpinned');

// search
await api('POST', `/api/channels/${text.id}/messages`, b.token, { content: 'the ranch dressing is 100% homemade' });
const found = await api('GET', `/api/search?q=${encodeURIComponent('ranch homemade')}&groupId=${g.id}`, a.token);
ok(found.messages.length >= 1 && found.messages[0].content.includes('homemade'), 'search finds messages with all the words');
ok((await api('GET', `/api/search?q=${encodeURIComponent('100%')}&channelId=${text.id}`, a.token)).messages.length === 1, 'search treats % literally');
ok((await api('GET', `/api/search?q=homemade&from=${a.user.id}&groupId=${g.id}`, a.token)).messages.length === 0, 'search can filter by who sent it');
ok((await api('GET', '/api/search?q=homemade', b.token)).messages.length >= 1, 'search everywhere covers your groups');
const outsider = await api('POST', '/api/auth/register', undefined, { username: `outsider_${stamp}`, password: PW, displayName: 'Outsider' });
try {
  await api('GET', `/api/search?q=homemade&groupId=${g.id}`, outsider.token);
  ok(false, "people can't search groups they're not in");
} catch (e) {
  ok(e.status === 404 || e.status === 403, "people can't search groups they're not in");
}
ok((await api('GET', '/api/search?q=homemade', outsider.token)).messages.length === 0, "searching everywhere doesn't reach other people's chats");

// mutes
const pingsOf = async (token, channelId) =>
  (await api('GET', '/api/bootstrap', token)).readStates.find((r) => r.channelId === channelId)?.mentionCount ?? 0;
const dmMuted = await api('PUT', `/api/mutes/${dm.id}`, b.token, { minutes: null });
ok(dmMuted.some((m) => m.targetId === dm.id && m.until === null), 'mute a DM until unmuted');
ok(await waitFor(B.events, 'mutes:update', (l) => l.some((m) => m.targetId === dm.id)), "mutes sync to the person's other devices");
let pingsBefore = await pingsOf(b.token, dm.id);
await api('POST', `/api/channels/${dm.id}/messages`, a.token, { content: 'quiet please' });
ok((await pingsOf(b.token, dm.id)) === pingsBefore, "a muted DM doesn't ping");
const groupMuted = await api('PUT', `/api/mutes/${g.id}`, b.token, { minutes: 60 });
const gm = groupMuted.find((m) => m.targetId === g.id);
ok(gm && gm.until > Date.now() + 59 * 60_000 && gm.until <= Date.now() + 60 * 60_000, 'mute a group for an hour');
pingsBefore = await pingsOf(b.token, text.id);
const everyoneMsg = await api('POST', `/api/channels/${text.id}/messages`, a.token, { content: '@everyone dinner time' });
ok(everyoneMsg.mentionEveryone === true, 'live messages say when @everyone counts');
ok((await pingsOf(b.token, text.id)) === pingsBefore, "@everyone doesn't ping in a muted group");
const directMsg = await api('POST', `/api/channels/${text.id}/messages`, a.token, { content: `<@${b.user.id}> you specifically` });
ok(directMsg.pings?.includes(b.user.id) && directMsg.mentionEveryone === false, 'live messages list who they ping');
ok((await pingsOf(b.token, text.id)) === pingsBefore + 1, 'a direct @mention still gets through a mute');
ok((await api('GET', '/api/bootstrap', b.token)).mutes.length === 2, 'mutes come with the bootstrap');
await api('DELETE', `/api/mutes/${dm.id}`, b.token);
pingsBefore = await pingsOf(b.token, dm.id);
await api('POST', `/api/channels/${dm.id}/messages`, a.token, { content: 'loud again' });
ok((await pingsOf(b.token, dm.id)) === pingsBefore + 1, 'unmuting brings pings back');
try {
  await api('PUT', `/api/mutes/${text.id}`, outsider.token, { minutes: 15 });
  ok(false, "people can't mute channels they can't see");
} catch (e) {
  ok(e.status === 404, "people can't mute channels they can't see");
}
try {
  await api('PUT', `/api/mutes/${text.id}`, b.token, { minutes: 0 });
  ok(false, 'a mute needs a sensible length');
} catch (e) {
  ok(e.status === 400, 'a mute needs a sensible length');
}
ok((await api('DELETE', `/api/mutes/${g.id}`, b.token)).length === 0, 'unmute a group');

// link previews never reach this machine or the home network
ok((await api('GET', '/api/link-preview?url=' + encodeURIComponent(BASE + '/api/instance'), a.token)).preview === null, 'link previews refuse local addresses');
ok((await api('GET', '/api/link-preview?url=' + encodeURIComponent('http://192.168.1.1/'), a.token)).preview === null, 'link previews refuse the home network');
try {
  await api('GET', '/api/link-preview?url=not-a-link', a.token);
  ok(false, 'link previews need a real link');
} catch (e) {
  ok(e.status === 400, 'link previews need a real link');
}

ok((await api('GET', '/api/link-preview?url=' + encodeURIComponent('http://[::ffff:127.0.0.1]/'), a.token)).preview === null, 'link previews refuse disguised local addresses');

// someone who's blocked can't pin in the old DM (each pin would bump it back up)
const dmPinMsg = await api('POST', `/api/channels/${dm.id}/messages`, a.token, { content: 'pin me maybe' });
await api('PUT', `/api/relationships/${a.user.id}`, b.token, { type: 'block' });
try {
  await api('PUT', `/api/channels/${dm.id}/pins/${dmPinMsg.id}`, a.token);
  ok(false, "blocked people can't pin in the DM");
} catch (e) {
  ok(e.status === 403, "blocked people can't pin in the DM");
}
await api('DELETE', `/api/relationships/${a.user.id}`, b.token);

// cleanup
await api('DELETE', `/api/groups/${g.id}`, a.token);
ok(await waitFor(B.events, 'group:delete', (p) => p.id === g.id), 'group deletion broadcast');
await api('DELETE', `/api/emojis/${emoji.id}`, a.token);
await api('DELETE', `/api/sounds/${sound.id}`, a.token);
A.s.close();
B.s.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
