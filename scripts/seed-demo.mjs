// Fills a TEST server with demo people, a group and some chat so the UI can be checked.
// Never run this against your real server. Usage: node scripts/seed-demo.mjs http://localhost:6499
const BASE = process.argv[2] ?? 'http://localhost:6499';
// Demo accounts get a fresh random password each run unless you pick one with DEMO_PASSWORD.
const PASSWORD = process.env.DEMO_PASSWORD || `demo-${Math.random().toString(36).slice(2, 12)}`;

// The demo accounts share a known password, so only ever make them on a server running on this PC.
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(BASE).hostname)) {
  console.error('seed-demo only runs against a test server on this computer (localhost).');
  process.exit(1);
}

async function api(method, p, token, body) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p}: ${data?.error}`);
  return data;
}

const people = [
  ['ranchlover', 'Ranch Lover', 'Dipping everything since 2009'],
  ['carrotstick', 'Carrot', 'crunchy'],
  ['wingnight', 'Wing Night', ''],
  ['celeryguy', 'Celery Guy', 'mostly water'],
];

const tokens = {};
const users = {};
for (const [username, displayName, status] of people) {
  let res;
  try {
    res = await api('POST', '/api/auth/register', undefined, { username, password: PASSWORD, displayName });
  } catch {
    res = await api('POST', '/api/auth/login', undefined, { username, password: PASSWORD });
  }
  tokens[username] = res.token;
  users[username] = res.user;
  if (status) await api('PATCH', '/api/users/@me', res.token, { customStatus: status, bio: `Hi, I'm ${displayName}. **Ranch** is a beverage.` });
}

const me = 'ranchlover';
for (const other of ['carrotstick', 'wingnight', 'celeryguy']) {
  try {
    await api('POST', '/api/relationships', tokens[other], { query: users[me].username });
    await api('PUT', `/api/relationships/${users[other].id}`, tokens[me], { type: 'friend' });
  } catch {
    /* already friends */
  }
}

const group = await api('POST', '/api/groups', tokens[me], { name: 'Ranch Hands' });
const invite = await api('GET', `/api/groups/${group.id}/invite`, tokens[me]);
for (const other of ['carrotstick', 'wingnight', 'celeryguy']) await api('POST', `/api/invites/${invite.code}`, tokens[other]);
const general = group.channels.find((c) => c.type === 'text');
const say = (who, content, extra = {}) => api('POST', `/api/channels/${general.id}/messages`, tokens[who], { content, ...extra });

await say('carrotstick', 'ok who is bringing the ranch tonight');
await say('wingnight', 'not me, I brought it last time 😤');
const q = await say('celeryguy', 'I have **two gallons** of the good stuff in my fridge right now');
await say('celeryguy', 'no questions please');
await say('ranchlover', 'legend. we eat at 8', { replyToId: q.id });
await api('PUT', `/api/channels/${general.id}/messages/${q.id}/reactions/${encodeURIComponent('🔥')}`, tokens.carrotstick);
await api('PUT', `/api/channels/${general.id}/messages/${q.id}/reactions/${encodeURIComponent('🔥')}`, tokens.wingnight);
await api('PUT', `/api/channels/${general.id}/messages/${q.id}/reactions/${encodeURIComponent('😂')}`, tokens.ranchlover);
await say('carrotstick', `<@${users.ranchlover.id}> can you start a call in Hangout later? I want to screen share the game`);
await say('wingnight', '```js\nconst dip = (wing) => wing.dunk("ranch");\n```\n||blue cheese is a crime||');

const dm = await api('POST', '/api/dms', tokens.carrotstick, { userId: users[me].id });
await api('POST', `/api/channels/${dm.id}/messages`, tokens.carrotstick, { content: 'yo did you see the new soundboard' });
await api('POST', `/api/channels/${dm.id}/messages`, tokens.ranchlover, { content: 'YES. uploading the airhorn rn' });
await api('POST', `/api/channels/${dm.id}/messages`, tokens.carrotstick, { content: '💀💀💀' });

console.log(`Seeded ${BASE}: log in as one of ${people.map((p) => p[0]).join(', ')} with the password ${PASSWORD}`);
