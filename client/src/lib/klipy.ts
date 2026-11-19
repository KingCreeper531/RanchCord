import type { KlipyEmbed } from '../types';

/**
 * KLIPY GIF & sticker API. Requests go straight from the user's device to KLIPY (that's what their
 * integration rules require); the server only hands out the app key.
 */

export type KlipyKind = 'gifs' | 'stickers';

interface KlipyFile {
  url: string;
  width: number;
  height: number;
  size?: number;
}

type KlipyFormats = Partial<Record<'gif' | 'webp' | 'mp4' | 'webm' | 'jpg' | 'png', KlipyFile>>;

export interface KlipyItem {
  id: number | string;
  slug: string;
  title: string;
  type: string;
  blur_preview?: string;
  file: Partial<Record<'hd' | 'md' | 'sm' | 'xs', KlipyFormats>>;
}

export interface KlipyPage {
  items: KlipyItem[];
  hasNext: boolean;
  page: number;
}

export interface KlipyCategory {
  category: string;
  query: string;
  preview_url: string;
}

const BASE = 'https://api.klipy.com/api/v1';

function locale() {
  const region = navigator.language.split('-')[1];
  return (region ?? 'US').toLowerCase();
}

/** Recent results, so searching the same thing again (or going back) is instant. */
const pageCache = new Map<string, { at: number; page: KlipyPage }>();
const PAGE_TTL = 10 * 60 * 1000;

export async function klipyList(
  key: string,
  kind: KlipyKind,
  opts: { query?: string; page?: number; customerId: string; contentFilter: string; signal?: AbortSignal },
): Promise<KlipyPage> {
  const params = new URLSearchParams({
    page: String(opts.page ?? 1),
    per_page: '30',
    customer_id: opts.customerId,
    locale: locale(),
    content_filter: opts.contentFilter,
  });
  const endpoint = opts.query ? 'search' : 'trending';
  if (opts.query) params.set('q', opts.query.toLowerCase());
  const url = `${BASE}/${encodeURIComponent(key)}/${kind}/${endpoint}?${params}`;
  const hit = pageCache.get(url);
  if (hit && Date.now() - hit.at < PAGE_TTL) return hit.page;
  const res = await fetch(url, { signal: opts.signal });
  if (res.status === 429) throw new Error('KLIPY rate limit reached. Try again in a bit.');
  if (!res.ok) throw new Error(`KLIPY returned an error (${res.status})`);
  const json = (await res.json()) as { result: boolean; data?: { data?: KlipyItem[]; has_next?: boolean; current_page?: number } };
  const items = (json.data?.data ?? []).filter((i) => i && i.file);
  const page = { items, hasNext: Boolean(json.data?.has_next), page: json.data?.current_page ?? opts.page ?? 1 };
  pageCache.set(url, { at: Date.now(), page });
  if (pageCache.size > 60) pageCache.delete(pageCache.keys().next().value!);
  return page;
}

/** Warms up trending GIFs as soon as the app starts, so the GIF tab opens instantly. */
export function prefetchTrending(key: string, customerId: string, contentFilter: string) {
  void klipyList(key, 'gifs', { customerId, contentFilter }).catch(() => {});
}

const categoryCache = new Map<string, KlipyCategory[]>();

export async function klipyCategories(key: string, kind: KlipyKind): Promise<KlipyCategory[]> {
  const cacheKey = `${kind}:${key}`;
  const cached = categoryCache.get(cacheKey);
  if (cached) return cached;
  const lang = navigator.language.replace('-', '_');
  const res = await fetch(`${BASE}/${encodeURIComponent(key)}/${kind}/categories?locale=${encodeURIComponent(lang)}`);
  if (!res.ok) throw new Error('Could not load categories');
  const json = (await res.json()) as { data?: { categories?: KlipyCategory[] } };
  const cats = json.data?.categories ?? [];
  categoryCache.set(cacheKey, cats);
  return cats;
}

/** Tells KLIPY a GIF was sent (improves their trending/recents for this user). */
export function klipyShare(key: string, kind: KlipyKind, slug: string, customerId: string, query: string) {
  void fetch(`${BASE}/${encodeURIComponent(key)}/${kind}/share/${encodeURIComponent(slug)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customer_id: customerId, q: query }),
  }).catch(() => {});
}

export function pickFile(item: KlipyItem, sizes: ('hd' | 'md' | 'sm' | 'xs')[], formats: (keyof KlipyFormats)[]): KlipyFile | null {
  for (const size of sizes) {
    const set = item.file[size];
    if (!set) continue;
    for (const f of formats) if (set[f]?.url) return set[f]!;
  }
  return null;
}

export function previewOf(item: KlipyItem, kind: KlipyKind) {
  const video = kind === 'gifs' ? pickFile(item, ['sm', 'xs', 'md'], ['mp4']) : null;
  const image = pickFile(item, ['sm', 'xs', 'md'], kind === 'stickers' ? ['webp', 'png', 'gif'] : ['webp', 'gif', 'jpg']);
  const dims = video ?? image;
  return { video: video?.url ?? null, image: image?.url ?? null, width: dims?.width ?? 1, height: dims?.height ?? 1 };
}

export function toEmbed(item: KlipyItem, kind: KlipyKind): KlipyEmbed | null {
  const main = pickFile(item, ['md', 'hd', 'sm'], kind === 'stickers' ? ['webp', 'png', 'gif'] : ['gif', 'webp']);
  if (!main) return null;
  const mp4 = kind === 'gifs' ? pickFile(item, ['md', 'hd', 'sm'], ['mp4']) : null;
  const webp = pickFile(item, ['md', 'hd', 'sm'], ['webp']);
  const preview = pickFile(item, ['sm', 'xs'], ['jpg', 'webp', 'png']);
  return {
    kind: 'klipy',
    type: kind === 'stickers' ? 'sticker' : 'gif',
    slug: item.slug,
    title: item.title ?? '',
    url: main.url,
    mp4: mp4?.url ?? null,
    webp: webp?.url ?? null,
    preview: preview?.url ?? null,
    width: (mp4 ?? main).width,
    height: (mp4 ?? main).height,
  };
}
