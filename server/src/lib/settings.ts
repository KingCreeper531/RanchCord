import { config } from '../config.ts';
import { get, run } from './db.ts';

/** Small key/value store for server-wide settings (app name, logo, ...). */
export function getSetting(key: string): string | null {
  return get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value ?? null;
}

export function setSetting(key: string, value: string | null) {
  if (value === null) run('DELETE FROM settings WHERE key = ?', key);
  else run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}

/** Upload limit in bytes: the admin setting if set, else MAX_UPLOAD_MB from .env. 0 means unlimited. */
export function maxUploadBytes(): number {
  const raw = getSetting('max_upload_mb');
  if (raw === null) return config.maxUploadBytes;
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.round(mb * 1024 * 1024);
}

export function klipySettings(): { key: string; contentFilter: string } | null {
  const key = getSetting('klipy_key') ?? config.klipyKey;
  if (!key) return null;
  return { key, contentFilter: getSetting('klipy_filter') ?? config.klipyContentFilter };
}
