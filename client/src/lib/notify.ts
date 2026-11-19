import { LocalNotifications } from '@capacitor/local-notifications';
import { api } from './api';
import { desktop, isNative, isStandalonePwa } from './platform';
import { fileUrl } from './server';
import { brandName } from './brand';

let nativeId = 1;
const nativeClicks = new Map<number, () => void>();
let nativeListener = false;

export async function notificationPermission(): Promise<'granted' | 'denied' | 'default'> {
  if (isNative) {
    const p = await LocalNotifications.checkPermissions();
    return p.display === 'granted' ? 'granted' : p.display === 'denied' ? 'denied' : 'default';
  }
  if (!('Notification' in window)) return 'denied';
  return Notification.permission;
}

export async function requestNotifications(): Promise<boolean> {
  try {
    if (isNative) {
      const p = await LocalNotifications.requestPermissions();
      return p.display === 'granted';
    }
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

export async function showNotification(opts: { title: string; body: string; icon?: string | null; tag?: string; onClick?: () => void }) {
  try {
    if (isNative) {
      if (!nativeListener) {
        nativeListener = true;
        await LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
          nativeClicks.get(e.notification.id)?.();
        });
      }
      const id = nativeId++;
      if (opts.onClick) nativeClicks.set(id, opts.onClick);
      await LocalNotifications.schedule({
        notifications: [{ id, title: opts.title, body: opts.body, group: opts.tag }],
      });
      return;
    }
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const n = new Notification(opts.title, {
      body: opts.body,
      icon: opts.icon ? fileUrl(opts.icon) : '/icons/icon-192.png',
      tag: opts.tag,
      silent: true,
    });
    n.onclick = () => {
      window.focus();
      opts.onClick?.();
      n.close();
    };
  } catch {
    /* notifications are best effort */
  }
}

/** Unread mention count on the taskbar / app icon / tab title. */
export function setBadge(count: number) {
  desktop?.setBadge(count);
  const name = brandName();
  document.title = count > 0 ? `(${count}) ${name}` : name;
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  if (isStandalonePwa) {
    if (count > 0) void nav.setAppBadge?.(count).catch(() => {});
    else void nav.clearAppBadge?.().catch(() => {});
  }
}

function urlBase64ToUint8Array(base64: string) {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * Web Push: lets the browser / home-screen app get notified while RanchCord is closed.
 * Not available in the Windows app (it stays connected in the tray instead) or the native phone apps.
 */
export async function enableWebPush(vapidKey: string | null): Promise<boolean> {
  if (!vapidKey || isNative || desktop || !('serviceWorker' in navigator) || !('PushManager' in window)) return false;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (Notification.permission !== 'granted') return false;
    let sub = await reg.pushManager.getSubscription();
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidKey) });
    const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
    await api.post('/api/push/subscribe', { endpoint: json.endpoint, keys: json.keys });
    return true;
  } catch {
    return false;
  }
}

export async function disableWebPush() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration('/sw.js');
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch {
    /* ignore */
  }
}
