import { useEffect, useSyncExternalStore } from 'react';
import { useData } from '../store/data';
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

/** Keeps the tab icon and title in sync with the app's name and logo. */
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
  }, [brand.name]);
}
