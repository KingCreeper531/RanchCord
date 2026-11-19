import { isNative } from './platform';

const KEY = 'rc.server';

/**
 * Where the RanchCord server lives.
 * The web app and the Windows app are served by the server itself, so they use the same origin.
 * The phone apps bundle the UI, so they need to know the server address.
 */
export function serverBase(): string {
  if (!isNative) return '';
  return localStorage.getItem(KEY) ?? (import.meta.env.VITE_DEFAULT_SERVER as string | undefined) ?? '';
}

export function hasServer(): boolean {
  return !isNative || Boolean(serverBase());
}

export function normalizeServerUrl(input: string): string {
  let url = input.trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) {
    const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url);
    url = (local ? 'http://' : 'https://') + url;
  }
  return url.replace(/\/+$/, '');
}

export function setServerBase(url: string) {
  localStorage.setItem(KEY, normalizeServerUrl(url));
}

export function clearServerBase() {
  localStorage.removeItem(KEY);
}

/** Turns a server path like /files/avatars/x.png into a full URL when needed. */
export function fileUrl(path: string | null | undefined): string {
  if (!path) return '';
  if (/^(https?:|data:|blob:)/.test(path)) return path;
  return serverBase() + path;
}

/** Link that saves a stored file instead of opening it (works when files live in a cloud bucket too). */
export function downloadUrl(pathOrUrl: string | null | undefined): string {
  const url = fileUrl(pathOrUrl);
  if (!/\/files\//.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'download=1';
}

/** The public address people should use in invite links. */
export function publicOrigin(instancePublicUrl: string | null | undefined): string {
  if (instancePublicUrl) return instancePublicUrl;
  if (isNative) return serverBase();
  return location.origin;
}
