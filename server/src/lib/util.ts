import { randomBytes, randomInt, scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import type { ZodType } from 'zod';

/* ---------- ids ---------- */

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
let lastTs = -1;
const lastRand = new Uint8Array(16);

/** Time-sortable 26 character id (ULID layout), monotonic within the same millisecond. */
export function newId(): string {
  let ts = Date.now();
  if (ts <= lastTs) {
    ts = lastTs;
    let i = 15;
    while (i >= 0 && lastRand[i] === 31) lastRand[i--] = 0;
    if (i >= 0) lastRand[i]++;
  } else {
    lastTs = ts;
    const bytes = randomBytes(16);
    for (let i = 0; i < 16; i++) lastRand[i] = bytes[i] & 31;
  }
  let out = '';
  let t = ts;
  for (let i = 0; i < 10; i++) {
    out = B32[t % 32] + out;
    t = Math.floor(t / 32);
  }
  for (let i = 0; i < 16; i++) out += B32[lastRand[i]];
  return out;
}

export const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const INVITE_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function randomCode(length: number, alphabet = CODE_ALPHABET): string {
  let s = '';
  for (let i = 0; i < length; i++) s += alphabet[randomInt(alphabet.length)];
  return s;
}

export const inviteCode = () => randomCode(8, INVITE_ALPHABET);
export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string) => createHash('sha256').update(value).digest('base64url');

/* ---------- passwords (scrypt, no native deps) ---------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptAsync(password: string, salt: Buffer, keylen: number, N: number, r: number, p: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, keylen, { N, r, p, maxmem: 128 * N * r * 2 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT.keylen, SCRYPT.N, SCRYPT.r, SCRYPT.p);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, +n, +r, +p);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/* ---------- JWT for LiveKit access tokens ---------- */

export function signJwt(payload: Record<string, unknown>, secret: string): string {
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const body = `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/* ---------- errors ---------- */

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = 'error') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message: string, code = 'bad_request') => new HttpError(400, message, code);
export const unauthorized = (message = 'Please log in again') => new HttpError(401, message, 'unauthorized');
export const forbidden = (message = "You don't have permission to do that") => new HttpError(403, message, 'forbidden');
export const notFound = (message = "That doesn't exist anymore") => new HttpError(404, message, 'not_found');

export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    throw badRequest(issue?.message || 'Invalid request', 'invalid');
  }
  return result.data;
}

/* ---------- misc ---------- */

const BANNER_COLORS = ['#5cc443', '#39b5e0', '#2c6fcb', '#f2b84b', '#e5534b', '#c178e6', '#f08a5d', '#3fbfa5'];
export const randomBannerColor = () => BANNER_COLORS[randomInt(BANNER_COLORS.length)];

export const now = () => Date.now();
