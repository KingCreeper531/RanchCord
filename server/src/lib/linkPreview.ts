import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { get, run } from './db.ts';

/*
 * Link previews: the title, description and picture of a page someone linked, like Discord's embeds.
 *
 * The server fetches pages that anyone in a chat can post, so it only ever talks to public internet
 * addresses: never this machine, the home network or the tailnet (each redirect is checked again,
 * and the check happens when connecting, so a DNS trick can't sneak past it). Pages are read only
 * up to a size cap with a short timeout, and results are cached.
 */

export interface LinkPreview {
  url: string;
  siteName: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  /** True when the page asks for a big picture (summary_large_image) rather than a thumbnail. */
  largeImage: boolean;
  color: string | null;
  /** Set for YouTube videos, so the app can play them in place. */
  youtubeId: string | null;
}

const MAX_BYTES = 768 * 1024;
const TIMEOUT_MS = 6000;
const MAX_REDIRECTS = 4;
const FRESH_MS = 24 * 60 * 60 * 1000;
const FAILED_MS = 60 * 60 * 1000;
const UA = 'Mozilla/5.0 (compatible; RanchCordBot/1.0; +link previews)';

/* ---------------- only public addresses ---------------- */

function ipv4Blocked(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT, Tailscale
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** The 16 bytes of an IPv6 address, or null. Understands "::" and a dotted IPv4 ending (::ffff:1.2.3.4). */
function ipv6Bytes(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);
  let v4: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const ending = s.slice(lastColon + 1);
  if (ending.includes('.')) {
    if (!net.isIPv4(ending)) return null;
    v4 = ending.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const groupsOf = (part: string) => (part ? part.split(':') : []);
  const head = groupsOf(halves[0]);
  const tail = halves.length === 2 ? groupsOf(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const v = parseInt(g, 16);
    bytes.push(v >> 8, v & 255);
  }
  if (v4.length) bytes.splice(12, 4, ...v4);
  return bytes.length === 16 ? bytes : null;
}

function ipv6Blocked(ip: string): boolean {
  const b = ipv6Bytes(ip);
  if (!b) return true;
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // Addresses that carry an IPv4 address inside (::ffff:127.0.0.1 is just 127.0.0.1) are judged by it.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return ipv4Blocked(b.slice(12).join('.'));
  if (zero(0, 12)) return true; // ::, ::1 and the old ::1.2.3.4 form
  const g0 = (b[0] << 8) | b[1];
  const g1 = (b[2] << 8) | b[3];
  return (
    (zero(0, 8) && b[8] === 0xff && b[9] === 0xff) || // ::ffff:0:1.2.3.4
    (b[0] & 0xfe) === 0xfc || // unique local, fc00::/7 (Tailscale uses fd7a:)
    (g0 & 0xffc0) === 0xfe80 || // link-local
    (g0 & 0xffc0) === 0xfec0 || // old site-local
    b[0] === 0xff || // multicast
    (g0 === 0x0064 && g1 === 0xff9b) || // NAT64, which reaches IPv4 addresses
    g0 === 0x2002 || // 6to4, which carries an IPv4 address
    (g0 === 0x2001 && g1 === 0) || // Teredo
    (g0 === 0x2001 && g1 === 0x0db8) || // documentation
    (g0 === 0x0100 && zero(2, 8)) // discard
  );
}

function ipBlocked(ip: string): boolean {
  if (net.isIPv4(ip)) return ipv4Blocked(ip);
  if (net.isIPv6(ip)) return ipv6Blocked(ip);
  return true;
}

/** DNS lookup that refuses private addresses, used for the actual connection. */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { all: true, family: options.family }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const ok = list.find((a) => !ipBlocked(a.address));
    if (!ok || list.some((a) => ipBlocked(a.address))) {
      return callback(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }), '', 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, [ok]);
    callback(null, ok.address, ok.family);
  });
};

function allowedUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    if (u.port && u.port !== '80' && u.port !== '443') return null;
    // A literal IP address skips the DNS lookup (and safeLookup), so it's checked right here.
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && ipBlocked(host)) return null;
    if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home|.*\.home\.arpa|.*\.ts\.net)$/i.test(u.hostname)) return null;
    return u;
  } catch {
    return null;
  }
}

/* ---------------- fetching ---------------- */

interface Fetched {
  url: string;
  contentType: string;
  body: string;
}

function fetchOnce(u: URL): Promise<{ status: number; location?: string; contentType: string; body: string }> {
  return new Promise((resolve, reject) => {
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      u,
      {
        method: 'GET',
        lookup: safeLookup,
        timeout: TIMEOUT_MS,
        headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5', 'Accept-Language': 'en' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers['content-type'] ?? '').toLowerCase();
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, contentType, body: '' });
        }
        // Only web pages (and JSON, for YouTube's oEmbed) are read; pictures are previewed from their headers alone.
        if (!contentType.includes('html') && !contentType.includes('json')) {
          res.destroy();
          return resolve({ status, contentType, body: '' });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          chunks.push(c);
          if (size >= MAX_BYTES) res.destroy();
        });
        const done = () => resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8') });
        res.on('end', done);
        res.on('close', done);
        res.on('error', done);
      },
    );
    // The whole fetch has a deadline, so a server dripping bytes slowly can't hold it open.
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), TIMEOUT_MS);
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchPage(start: URL): Promise<Fetched | null> {
  let u = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await fetchOnce(u);
    if (res.status >= 300 && res.status < 400 && res.location) {
      const next = allowedUrl(new URL(res.location, u).toString());
      if (!next) return null;
      u = next;
      continue;
    }
    if (res.status < 200 || res.status >= 300) return null;
    return { url: u.toString(), contentType: res.contentType, body: res.body };
  }
  return null;
}

/* ---------------- reading the page ---------------- */

function decodeEntities(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => safeChar(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function safeChar(code: number) {
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
}

function clean(s: string | undefined | null, max: number): string | null {
  if (!s) return null;
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** Longest tag or title read; anything past it is cut off. */
const MAX_TAG = 8192;

const isSpace = (c: string) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';

/** A tag's attributes (names lowercased). Reads each character once, so odd pages can't slow it down. */
function tagAttributes(tag: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const n = tag.length;
  let i = 1;
  while (i < n && !isSpace(tag[i]) && tag[i] !== '/' && tag[i] !== '>') i++; // the tag name
  while (i < n) {
    while (i < n && (isSpace(tag[i]) || tag[i] === '/')) i++;
    if (i >= n || tag[i] === '>') break;
    const nameStart = i;
    while (i < n && !isSpace(tag[i]) && tag[i] !== '=' && tag[i] !== '/' && tag[i] !== '>') i++;
    const name = tag.slice(nameStart, i).toLowerCase();
    while (i < n && isSpace(tag[i])) i++;
    let value = '';
    if (tag[i] === '=') {
      i++;
      while (i < n && isSpace(tag[i])) i++;
      const quote = tag[i];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, i + 1);
        const stop = end === -1 ? n : end;
        value = tag.slice(i + 1, stop);
        i = stop + 1;
      } else {
        const start = i;
        while (i < n && !isSpace(tag[i]) && tag[i] !== '>') i++;
        value = tag.slice(start, i);
      }
    }
    if (name && !attrs.has(name)) attrs.set(name, value);
  }
  return attrs;
}

/**
 * Every <meta> tag's property/name and content (lowercased keys), and the <title>.
 * Only simple searches that move forward, so the time it takes grows evenly with the page size.
 */
function metaTags(html: string) {
  const page = html.slice(0, MAX_BYTES);
  const headEnd = page.search(/<\/head[\s>]/i);
  const end = headEnd === -1 ? page.length : headEnd;
  const out = new Map<string, string>();
  const find = /<meta[\s/>]/gi;
  for (let m = find.exec(page); m && m.index < end; m = find.exec(page)) {
    const close = page.indexOf('>', m.index + 5);
    if (close === -1) break;
    find.lastIndex = close + 1;
    const attrs = tagAttributes(page.slice(m.index, Math.min(close + 1, m.index + MAX_TAG)));
    const key = attrs.get('property') || attrs.get('name') || attrs.get('itemprop');
    const value = attrs.get('content');
    if (!key || value === undefined) continue;
    const k = key.toLowerCase();
    if (!out.has(k)) out.set(k, value);
  }
  let title: string | undefined;
  const open = page.slice(0, end).search(/<title[\s>]/i);
  if (open !== -1) {
    const start = page.indexOf('>', open);
    if (start !== -1) {
      const window = page.slice(start + 1, start + 1 + MAX_TAG);
      const stop = window.search(/<\/title/i);
      if (stop !== -1) title = window.slice(0, stop);
    }
  }
  return { meta: out, title };
}

function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '');
  if (host === 'youtu.be') return /^\/([\w-]{11})/.exec(u.pathname)?.[1] ?? null;
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (u.pathname === '/watch') return /^[\w-]{11}$/.test(u.searchParams.get('v') ?? '') ? u.searchParams.get('v') : null;
    return /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(u.pathname)?.[1] ?? null;
  }
  return null;
}

function absoluteImage(raw: string | undefined, base: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(decodeEntities(raw.trim()), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 2000) : null;
  } catch {
    return null;
  }
}

/** YouTube shows servers a consent page, so its official oEmbed lookup is used for the title and channel. */
async function youtubePreview(raw: string, id: string): Promise<LinkPreview | null> {
  const lookup = allowedUrl(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`);
  const res = lookup ? await fetchPage(lookup).catch(() => null) : null;
  if (!res || !res.contentType.includes('json')) return null;
  try {
    const data = JSON.parse(res.body) as { title?: string; author_name?: string };
    return {
      url: raw,
      siteName: 'YouTube',
      title: clean(data.title, 200),
      description: clean(data.author_name, 120),
      image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
      largeImage: true,
      color: '#ff0033',
      youtubeId: id,
    };
  } catch {
    return null;
  }
}

async function build(raw: string): Promise<LinkPreview | null> {
  const start = allowedUrl(raw);
  if (!start) return null;
  const yt = youtubeId(start);
  if (yt) {
    const video = await youtubePreview(raw, yt);
    if (video) return video;
  }
  const page = await fetchPage(start);
  if (!page) {
    // YouTube sometimes refuses servers; the video can still be shown from its id.
    return yt ? { url: raw, siteName: 'YouTube', title: null, description: null, image: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, largeImage: true, color: '#ff0033', youtubeId: yt } : null;
  }
  if (page.contentType.startsWith('image/')) return null; // pictures already show as pictures
  const { meta, title } = metaTags(page.body);
  const m = (...keys: string[]) => keys.map((k) => meta.get(k)).find(Boolean);
  const preview: LinkPreview = {
    url: raw,
    siteName: clean(m('og:site_name', 'application-name'), 80) ?? new URL(page.url).hostname.replace(/^www\./, ''),
    title: clean(m('og:title', 'twitter:title') ?? title, 200),
    description: clean(m('og:description', 'twitter:description', 'description'), 350),
    image: absoluteImage(m('og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'), page.url),
    largeImage: (m('twitter:card') ?? '').toLowerCase() === 'summary_large_image' || Boolean(yt) || (m('og:type') ?? '').startsWith('video'),
    color: /^#[0-9a-f]{6}$/i.test(m('theme-color') ?? '') ? m('theme-color')! : null,
    youtubeId: yt,
  };
  if (yt && !preview.image) preview.image = `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`;
  if (!preview.title && !preview.description && !preview.image) return null;
  return preview;
}

/* ---------------- cache ---------------- */

const inFlight = new Map<string, Promise<LinkPreview | null>>();
let active = 0;
const waiting: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= 4) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** The preview for a link, from the cache when it's fresh. Null when there's nothing worth showing. */
export function linkPreview(raw: string): Promise<LinkPreview | null> {
  const url = raw.slice(0, 2000);
  const cached = get<{ data: string | null; fetched_at: number }>('SELECT data, fetched_at FROM link_previews WHERE url = ?', url);
  if (cached) {
    const age = Date.now() - cached.fetched_at;
    if (cached.data && age < FRESH_MS) return Promise.resolve(JSON.parse(cached.data) as LinkPreview);
    if (!cached.data && age < FAILED_MS) return Promise.resolve(null);
  }
  const pending = inFlight.get(url);
  if (pending) return pending;
  const job = limited(() => build(url))
    .catch(() => null)
    .then((p) => {
      run(
        `INSERT INTO link_previews (url, data, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET data = excluded.data, fetched_at = excluded.fetched_at`,
        url,
        p ? JSON.stringify(p) : null,
        Date.now(),
      );
      return p;
    })
    .finally(() => inFlight.delete(url));
  inFlight.set(url, job);
  return job;
}

/** Old cache rows go away so the table doesn't grow forever. */
export function pruneLinkPreviews() {
  run('DELETE FROM link_previews WHERE fetched_at < ?', Date.now() - 7 * FRESH_MS);
}

export const _test = { ipBlocked, allowedUrl, metaTags, youtubeId };
