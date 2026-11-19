import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.ts';

/** Small secrets (like people's storage keys) are encrypted with this server's own key before being saved. */
const keyFile = path.join(config.dataDir, 'secret.key');
let key: Buffer | null = null;

function serverKey(): Buffer {
  if (key) return key;
  try {
    const raw = fs.readFileSync(keyFile);
    if (raw.length === 32) return (key = raw);
  } catch {
    /* first run */
  }
  const fresh = randomBytes(32);
  fs.writeFileSync(keyFile, fresh, { mode: 0o600 });
  return (key = fresh);
}

export function seal(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', serverKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

export function unseal(sealed: string): string {
  const [version, iv, tag, data] = sealed.split('.');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unreadable secret');
  const decipher = createDecipheriv('aes-256-gcm', serverKey(), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}
