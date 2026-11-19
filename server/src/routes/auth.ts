import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerToken, createSession } from '../auth.ts';
import { config, livekitEnabled } from '../config.ts';
import { get, run } from '../lib/db.ts';
import { type UserRow, selfUser } from '../lib/model.ts';
import {
  HttpError,
  badRequest,
  hashPassword,
  newId,
  now,
  parse,
  randomBannerColor,
  randomCode,
  sha256,
  verifyPassword,
} from '../lib/util.ts';
import { getSetting, klipySettings, maxUploadBytes, setSetting } from '../lib/settings.ts';
import { auth } from '../auth.ts';
import { removeFile, saveImage } from '../lib/files.ts';
import { forbidden } from '../lib/util.ts';
import { emitAll } from '../realtime.ts';
import { vapidPublicKey } from '../push.ts';
import { disconnectSession } from '../realtime.ts';

export const Username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_.]{2,32}$/, 'Usernames are 2-32 characters: letters, numbers, _ and .');
export const Password = z.string().min(6, 'Passwords need at least 6 characters').max(256);

export function uniqueFriendCode(): string {
  for (;;) {
    const code = randomCode(8);
    if (!get('SELECT 1 FROM users WHERE friend_code = ?', code)) return code;
  }
}

const DOWNLOADS = {
  windows: /\.exe$/i,
  android: /\.apk$/i,
  ios: /\.ipa$/i,
} as const;

function availableDownloads() {
  const out: Partial<Record<keyof typeof DOWNLOADS, string>> = {};
  try {
    const files = fs.readdirSync(config.downloadsDir).sort();
    for (const [platform, re] of Object.entries(DOWNLOADS) as [keyof typeof DOWNLOADS, RegExp][]) {
      const match = files.filter((f) => re.test(f)).pop();
      if (match) out[platform] = `/downloads/${encodeURIComponent(match)}`;
    }
  } catch {
    /* no downloads folder */
  }
  return out;
}

export function instanceInfo() {
  return {
    name: getSetting('app_name') || config.instanceName,
    logo: getSetting('app_logo'),
    signupCodeRequired: Boolean(config.signupCode),
    publicUrl: config.publicUrl || null,
    maxUploadBytes: maxUploadBytes(),
    klipy: klipySettings(),
    calls: { mode: livekitEnabled ? 'sfu' : 'p2p' },
    vapidPublicKey: vapidPublicKey() || null,
    downloads: availableDownloads(),
  };
}

export default async function authRoutes(app: FastifyInstance) {
  app.get('/api/instance', async () => instanceInfo());

  app.get('/api/instance/settings', async (req) => {
    const me = auth(req);
    if (!me.is_admin) throw forbidden('Only the server admin can see server settings');
    const raw = getSetting('max_upload_mb');
    return {
      klipyKey: getSetting('klipy_key') ?? '',
      klipyKeyFromEnv: !getSetting('klipy_key') && Boolean(config.klipyKey),
      klipyFilter: getSetting('klipy_filter') ?? config.klipyContentFilter,
      maxUploadMb: raw !== null ? Number(raw) : Math.round(config.maxUploadBytes / 1024 / 1024),
    };
  });

  /* Branding: the server admin (first account) can rename the app and change its logo. */
  app.patch('/api/instance', async (req) => {
    const me = auth(req);
    if (!me.is_admin) throw forbidden('Only the server admin can change the app name');
    const body = parse(
      z.object({
        name: z.string().trim().max(32).optional(),
        klipyKey: z.string().trim().max(200).optional(),
        klipyFilter: z.enum(['off', 'low', 'medium', 'high']).optional(),
        maxUploadMb: z.number().min(0).max(1024 * 1024).optional(),
      }),
      req.body,
    );
    if (body.name !== undefined) setSetting('app_name', body.name || null);
    if (body.klipyKey !== undefined) setSetting('klipy_key', body.klipyKey || null);
    if (body.klipyFilter !== undefined) setSetting('klipy_filter', body.klipyFilter);
    if (body.maxUploadMb !== undefined) setSetting('max_upload_mb', String(body.maxUploadMb));
    const info = instanceInfo();
    emitAll('instance:update', info);
    return info;
  });

  app.post('/api/instance/logo', async (req) => {
    const me = auth(req);
    if (!me.is_admin) throw forbidden('Only the server admin can change the app logo');
    const file = await req.file();
    if (!file) throw badRequest('Pick an image first');
    const { rel } = await saveImage(file, `icons/app-logo-${randomCode(6).toLowerCase()}`, 16 * 1024 * 1024);
    removeFile(getSetting('app_logo')?.replace(/^\/files\//, ''));
    setSetting('app_logo', `/files/${rel}`);
    const info = instanceInfo();
    emitAll('instance:update', info);
    return info;
  });

  app.delete('/api/instance/logo', async (req) => {
    const me = auth(req);
    if (!me.is_admin) throw forbidden('Only the server admin can change the app logo');
    removeFile(getSetting('app_logo')?.replace(/^\/files\//, ''));
    setSetting('app_logo', null);
    const info = instanceInfo();
    emitAll('instance:update', info);
    return info;
  });

  app.post(
    '/api/auth/register',
    { config: { rateLimit: { max: 15, timeWindow: '10 minutes' } } },
    async (req) => {
      const body = parse(
        z.object({
          username: Username,
          password: Password,
          displayName: z.string().trim().max(32).optional(),
          signupCode: z.string().trim().optional(),
        }),
        req.body,
      );
      if (config.signupCode && body.signupCode !== config.signupCode) {
        throw badRequest("That signup code isn't right. Ask whoever runs this server for it.", 'bad_signup_code');
      }
      if (get('SELECT 1 FROM users WHERE username = ?', body.username)) {
        throw badRequest('That username is already taken', 'username_taken');
      }
      const id = newId();
      const isFirstUser = !get('SELECT 1 FROM users LIMIT 1');
      const hash = await hashPassword(body.password);
      try {
        run(
          `INSERT INTO users (id, username, display_name, password_hash, friend_code, banner_color, is_admin, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          body.username,
          body.displayName || body.username,
          hash,
          uniqueFriendCode(),
          randomBannerColor(),
          isFirstUser,
          now(),
        );
      } catch {
        throw badRequest('That username is already taken', 'username_taken');
      }
      const token = createSession(id, req.headers['user-agent'] ?? '');
      return { token, user: selfUser(get<UserRow>('SELECT * FROM users WHERE id = ?', id)!) };
    },
  );

  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } }, async (req) => {
    const body = parse(z.object({ username: z.string().trim().toLowerCase(), password: z.string() }), req.body);
    const user = get<UserRow>('SELECT * FROM users WHERE username = ?', body.username.replace(/^@/, ''));
    if (!user || !(await verifyPassword(body.password, user.password_hash))) {
      throw new HttpError(401, 'Wrong username or password', 'bad_login');
    }
    const token = createSession(user.id, req.headers['user-agent'] ?? '');
    return { token, user: selfUser(user) };
  });

  app.post('/api/auth/logout', async (req) => {
    const token = bearerToken(req);
    if (token) {
      const hash = sha256(token);
      run('DELETE FROM sessions WHERE token_hash = ?', hash);
      disconnectSession(hash);
    }
    return { ok: true };
  });

  app.get('/api/health', async () => ({ ok: true, time: now(), version: readVersion() }));
}

let version: string | null = null;
function readVersion() {
  if (version) return version;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'package.json'), 'utf8'));
    version = String(pkg.version);
  } catch {
    version = 'dev';
  }
  return version;
}
