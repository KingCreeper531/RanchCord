import { useEffect, useSyncExternalStore } from 'react';
import { useData } from '../store/data';
import { desktop } from './platform';
import { fileUrl } from './server';

export const DEFAULT_LOGO = '/icons/mascot.png';

/* ---------- your own name & icon for the app (this device only) ---------- */

export interface PersonalBrand {
  name?: string;
  /** A data: URL, so it works offline and on the login screen too. */
  logo?: string;
}

const PERSONAL_KEY = 'rc.brand.mine';
const listeners = new Set<() => void>();

function readPersonal(): PersonalBrand {
  try {
    return JSON.parse(localStorage.getItem(PERSONAL_KEY) ?? '{}') as PersonalBrand;
  } catch {
    return {};
  }
}

let personal: PersonalBrand = readPersonal();

/** Renames the app / changes its icon for you only. Pass undefined to go back to the default. */
export function setPersonalBrand(patch: Partial<Record<keyof PersonalBrand, string | undefined>>) {
  const next: PersonalBrand = { ...personal, ...patch };
  if (!next.name?.trim()) delete next.name;
  if (!next.logo) delete next.logo;
  personal = next;
  try {
    if (Object.keys(next).length) localStorage.setItem(PERSONAL_KEY, JSON.stringify(next));
    else localStorage.removeItem(PERSONAL_KEY);
  } catch {
    throw new Error("Couldn't save that on this device (the picture may be too big)");
  }
  for (const l of listeners) l();
}

export function usePersonalBrand(): PersonalBrand {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => personal,
  );
}

/* ---------- the server's name & logo (the default) ---------- */

function cached(): { name?: string; logo?: string | null } {
  try {
    return JSON.parse(localStorage.getItem('rc.brand') ?? '{}');
  } catch {
    return {};
  }
}

export function rememberBrand(name: string, logo: string | null) {
  localStorage.setItem('rc.brand', JSON.stringify({ name, logo }));
}

/** Brand before the server has answered (splash screen, login). */
export function cachedBrand() {
  const c = cached();
  return {
    name: personal.name || c.name || 'RanchCord',
    logo: personal.logo || (c.logo ? fileUrl(c.logo) : DEFAULT_LOGO),
  };
}

/** The app's name and logo: your own if you set one in Settings > Appearance, otherwise the server's. */
export function useBrand() {
  const mine = usePersonalBrand();
  const fallback = cachedBrand();
  const serverName = useData((s) => s.instance?.name || fallback.name);
  const serverLogo = useData((s) => (s.instance ? (s.instance.logo ? fileUrl(s.instance.logo) : DEFAULT_LOGO) : fallback.logo));
  return { name: mine.name || serverName, logo: mine.logo || serverLogo };
}

export function brandName() {
  return personal.name || useData.getState().instance?.name || 'RanchCord';
}

/** Draws a picture (any format, first frame of a GIF) as a square PNG for the Windows app's icons. */
async function iconPng(src: string, size = 128): Promise<Uint8Array | null> {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = src;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const scale = Math.max(size / img.naturalWidth, size / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}

/**
 * Keeps the tab icon and title in sync with the app's name and logo, and, in the Windows app,
 * the title bar, taskbar and tray too.
 */
export function useBrandFavicon() {
  const brand = useBrand();
  const custom = brand.logo !== DEFAULT_LOGO ? brand.logo : null;
  useEffect(() => {
    const links = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
    links.forEach((l) => {
      if (!l.dataset.original) l.dataset.original = l.href;
      l.href = custom ?? l.dataset.original;
    });
  }, [custom]);
  useEffect(() => {
    // Keep any "(3)" unread prefix while swapping the name.
    const unread = /^\(\d+\) /.exec(document.title)?.[0] ?? '';
    document.title = unread + brand.name;
    // The name under the icon if this page is added to an iPhone's home screen.
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', brand.name);
  }, [brand.name]);
  useEffect(() => {
    const setBrand = desktop?.setBrand;
    if (!setBrand) return;
    let stale = false;
    void (async () => {
      const icon = custom ? await iconPng(custom) : null;
      if (!stale) setBrand(brand.name, icon);
    })();
    return () => {
      stale = true;
    };
  }, [brand.name, custom]);
}
