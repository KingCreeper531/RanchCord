import fs from 'node:fs';
import path from 'node:path';
import * as webpush from 'web-push';
import { config } from './config.ts';
import { all, qs, run } from './lib/db.ts';

let publicKey = '';

/** Web Push lets browsers/PWAs (Android Chrome, iPhone home-screen app, desktop browsers) get notifications while closed. */
export function initPush() {
  const file = path.join(config.dataDir, 'vapid.json');
  let keys: { publicKey: string; privateKey: string };
  if (fs.existsSync(file)) {
    keys = JSON.parse(fs.readFileSync(file, 'utf8'));
  } else {
    keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(file, JSON.stringify(keys, null, 2));
  }
  webpush.setVapidDetails(config.pushContact, keys.publicKey, keys.privateKey);
  publicKey = keys.publicKey;
}

export const vapidPublicKey = () => publicKey;

export async function sendPush(userIds: string[], payload: Record<string, unknown>) {
  if (!publicKey || userIds.length === 0) return;
  const subs = all<{ endpoint: string; p256dh: string; auth: string }>(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id IN (${qs(userIds.length)})`,
    ...userIds,
  );
  const body = JSON.stringify(payload);
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
          TTL: 60 * 60,
          urgency: 'high',
        });
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) run('DELETE FROM push_subscriptions WHERE endpoint = ?', s.endpoint);
      }
    }),
  );
}
