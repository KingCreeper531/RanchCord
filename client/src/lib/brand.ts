import { useEffect } from 'react';
import { useData } from '../store/data';
import { fileUrl } from './server';

export const DEFAULT_LOGO = '/icons/mascot.png';

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
  return { name: c.name || 'RanchCord', logo: c.logo ? fileUrl(c.logo) : DEFAULT_LOGO };
}

/** The app's name and logo, as set by the server admin in Settings > Branding. */
export function useBrand() {
  const fallback = cachedBrand();
  const name = useData((s) => s.instance?.name || fallback.name);
  const logo = useData((s) => (s.instance ? (s.instance.logo ? fileUrl(s.instance.logo) : DEFAULT_LOGO) : fallback.logo));
  return { name, logo };
}

export function brandName() {
  return useData.getState().instance?.name || 'RanchCord';
}

/** Keeps the tab icon in sync with the custom logo. */
export function useBrandFavicon() {
  const logo = useData((s) => (s.instance?.logo ? fileUrl(s.instance.logo) : null));
  useEffect(() => {
    const links = document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
    links.forEach((l) => {
      if (!l.dataset.original) l.dataset.original = l.href;
      l.href = logo ?? l.dataset.original;
    });
  }, [logo]);
}
