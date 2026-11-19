import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, MagnifyingGlass, Star, TrendUp, X } from '@phosphor-icons/react';
import { isFavorite, toggleFavorite } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { klipyCategories, klipyList, klipyShare, previewOf, toEmbed, type KlipyCategory, type KlipyItem, type KlipyKind } from '../../lib/klipy';
import { isMobileDevice } from '../../lib/platform';
import { fileUrl } from '../../lib/server';
import { useData } from '../../store/data';
import { ui } from '../../store/ui';
import type { KlipyEmbed } from '../../types';
import { EmptyState, Spinner } from '../ui';

interface TileMedia {
  key: string;
  title: string;
  video: string | null;
  image: string | null;
  blur: string | null;
  width: number;
  height: number;
}

/** True once the element is on (or close to) the screen. */
function useNearScreen(ref: React.RefObject<HTMLElement | null>) {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: '250px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return near;
}

function Tile({ media, fav, onPick, onFav, eager }: { media: TileMedia; fav: boolean; onPick: () => void; onFav: () => void; eager?: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  // GIFs only download once they're about to be seen, and pause when scrolled away. Loading all
  // 30 at once made searching slow, especially on phones.
  const near = useNearScreen(ref);
  const [started, setStarted] = useState(Boolean(eager));
  useEffect(() => {
    if (near) setStarted(true);
    const v = video.current;
    if (!v) return;
    if (near) void v.play().catch(() => {});
    else v.pause();
  }, [near]);
  return (
    <div className={`kp-tile-wrap${fav ? ' is-fav' : ''}`}>
      <button
        ref={ref}
        className={`kp-tile${loaded ? ' is-loaded' : ''}`}
        style={{ aspectRatio: `${media.width} / ${media.height}`, backgroundImage: media.blur && !loaded ? `url(${media.blur})` : undefined }}
        onClick={onPick}
        title={media.title}
      >
        {media.video ? (
          started && <video ref={video} src={media.video} autoPlay loop muted playsInline preload="auto" onLoadedData={() => setLoaded(true)} />
        ) : (
          media.image && <img src={media.image} alt={media.title} loading="lazy" onLoad={() => setLoaded(true)} draggable={false} />
        )}
      </button>
      <button
        className="kp-fav"
        onClick={(e) => {
          e.stopPropagation();
          onFav();
        }}
        aria-label={fav ? 'Remove from favorites' : 'Add to favorites'}
        aria-pressed={fav}
      >
        <Star size={16} weight={fav ? 'fill' : 'bold'} />
      </button>
    </div>
  );
}

const itemMedia = (item: KlipyItem, kind: KlipyKind): TileMedia => {
  const p = previewOf(item, kind);
  return { key: item.slug, title: item.title, video: p.video, image: p.image, blur: item.blur_preview ?? null, width: p.width, height: p.height };
};

const embedMedia = (e: KlipyEmbed): TileMedia => ({
  key: e.slug,
  title: e.title,
  // GIFs people uploaded are stored as paths on this server.
  video: e.type === 'gif' && e.mp4 ? fileUrl(e.mp4) : null,
  image: fileUrl(e.webp ?? e.url),
  blur: e.preview ? fileUrl(e.preview) : null,
  width: e.width,
  height: e.height,
});

function Masonry({ tiles, columns }: { tiles: { media: TileMedia; fav: boolean; onPick: () => void; onFav: () => void }[]; columns: number }) {
  const cols = useMemo(() => {
    const out: { items: typeof tiles; h: number }[] = Array.from({ length: columns }, () => ({ items: [], h: 0 }));
    for (const t of tiles) {
      const target = out.reduce((a, b) => (b.h < a.h ? b : a));
      target.items.push(t);
      target.h += t.media.height / Math.max(1, t.media.width);
    }
    return out.map((c) => c.items);
  }, [tiles, columns]);
  return (
    <div className={`kp-masonry kp-cols-${columns}`}>
      {cols.map((col, i) => (
        <div key={i} className="kp-col">
          {col.map((t) => (
            // The first few start right away; the rest wait until they scroll near.
            <Tile key={t.media.key} {...t} eager={tiles.indexOf(t) < 8} />
          ))}
        </div>
      ))}
    </div>
  );
}

const star = (embed: KlipyEmbed | null) => {
  if (!embed) return;
  toggleFavorite(embed)
    .then((on) => ui.toast(on ? 'Added to favorites' : 'Removed from favorites', 'success'))
    .catch((err) => ui.toast(errorMessage(err), 'error'));
};

export function KlipyPicker({ kind, onPick }: { kind: KlipyKind; onPick: (embed: KlipyEmbed) => void }) {
  const klipy = useData((s) => s.instance?.klipy);
  const meId = useData((s) => s.me?.id ?? 'anon');
  const allFavorites = useData((s) => s.favorites);
  const embedType = kind === 'stickers' ? 'sticker' : 'gif';
  const favorites = useMemo(() => allFavorites.filter((f) => f.type === embedType), [allFavorites, embedType]);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  // Stickers open straight onto trending stickers (with categories as chips), so the tab looks like
  // a sticker sheet rather than a second copy of the GIF menu.
  const home = kind === 'stickers' ? 'results' : 'home';
  const [mode, setMode] = useState<'home' | 'results' | 'favorites'>(home);
  const [items, setItems] = useState<KlipyItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [categories, setCategories] = useState<KlipyCategory[] | null>(null);
  const [trendingPreview, setTrendingPreview] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!isMobileDevice) setTimeout(() => input.current?.focus(), 30);
  }, [kind]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (debounced) setMode('results');
  }, [debounced]);

  // categories + a trending preview for the home grid
  useEffect(() => {
    if (!klipy) return;
    setCategories(null);
    klipyCategories(klipy.key, kind).then(setCategories).catch(() => setCategories([]));
    klipyList(klipy.key, kind, { customerId: meId, contentFilter: klipy.contentFilter })
      .then((r) => {
        const first = r.items[0];
        setTrendingPreview(first ? previewOf(first, kind).image : null);
      })
      .catch(() => {});
  }, [klipy, kind, meId]);

  // results
  useEffect(() => {
    if (!klipy || mode !== 'results') return;
    const id = ++reqId.current;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    setItems([]);
    setPage(1);
    klipyList(klipy.key, kind, { query: debounced || undefined, page: 1, customerId: meId, contentFilter: klipy.contentFilter, signal: ctrl.signal })
      .then((r) => {
        if (id !== reqId.current) return;
        setItems(r.items);
        setHasNext(r.hasNext);
        scroller.current?.scrollTo({ top: 0 });
      })
      .catch((e: Error) => e.name !== 'AbortError' && setError(e.message))
      .finally(() => id === reqId.current && setLoading(false));
    return () => ctrl.abort();
  }, [klipy, kind, mode, debounced, meId]);

  const loadMore = () => {
    if (!klipy || loading || !hasNext) return;
    const id = reqId.current;
    setLoading(true);
    klipyList(klipy.key, kind, { query: debounced || undefined, page: page + 1, customerId: meId, contentFilter: klipy.contentFilter })
      .then((r) => {
        if (id !== reqId.current) return;
        setItems((prev) => {
          const seen = new Set(prev.map((x) => x.slug));
          return [...prev, ...r.items.filter((x) => !seen.has(x.slug))];
        });
        setPage(r.page);
        setHasNext(r.hasNext);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  const columns = kind === 'stickers' ? 3 : 2;

  const pick = (embed: KlipyEmbed | null) => {
    if (!embed || !klipy) return;
    if (embed.kind === 'klipy') klipyShare(klipy.key, kind, embed.slug, meId, debounced);
    onPick(embed);
  };

  const resultTiles = useMemo(
    () =>
      items.map((it) => ({
        media: itemMedia(it, kind),
        fav: isFavorite(favorites, { type: embedType, slug: it.slug }),
        onPick: () => pick(toEmbed(it, kind)),
        onFav: () => star(isFavorite(favorites, { type: embedType, slug: it.slug }) ? favorites.find((f) => f.slug === it.slug) ?? null : toEmbed(it, kind)),
      })),
    [items, kind, favorites, embedType, klipy, debounced],
  );

  const favoriteTiles = useMemo(
    () => favorites.map((e) => ({ media: embedMedia(e), fav: true, onPick: () => pick(e), onFav: () => star(e) })),
    [favorites, klipy, debounced],
  );

  if (!klipy) {
    return (
      <EmptyState
        title={kind === 'gifs' ? 'GIFs are not set up yet' : 'Stickers are not set up yet'}
        body="Whoever runs this server needs to add a free KLIPY API key to its settings (KLIPY_API_KEY in server/.env)."
      />
    );
  }

  const label = kind === 'gifs' ? 'GIFs' : 'stickers';
  const favPreview = favorites[0] ? fileUrl(favorites[0].preview ?? favorites[0].webp ?? favorites[0].url) : null;

  return (
    <div className="kp">
      <div className="kp-top">
        {mode !== home && !query && (
          <button className="kp-back" onClick={() => setMode(home)} aria-label="Back">
            <ArrowLeft size={18} weight="bold" />
          </button>
        )}
        <div className="ep-search kp-search">
          <input
            ref={input}
            value={query}
            placeholder={`Search ${label}`}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) {
                setDebounced('');
                setMode(home);
              }
            }}
          />
          {query ? (
            <button
              className="ep-search-clear"
              onClick={() => {
                setQuery('');
                setDebounced('');
                setMode(home);
              }}
              aria-label="Clear"
            >
              <X size={14} weight="bold" />
            </button>
          ) : (
            <MagnifyingGlass size={16} className="ep-search-icon" />
          )}
        </div>
      </div>
      {kind === 'stickers' && (
        <div className="kp-chips" role="tablist">
          <button
            className={`kp-chip${mode === 'favorites' ? ' is-active' : ''}`}
            onClick={() => {
              setQuery('');
              setDebounced('');
              setMode('favorites');
            }}
          >
            <Star size={14} weight="fill" /> Favorites
          </button>
          <button
            className={`kp-chip${mode === 'results' && !debounced ? ' is-active' : ''}`}
            onClick={() => {
              setQuery('');
              setDebounced('');
              setMode('results');
            }}
          >
            <TrendUp size={14} weight="bold" /> Trending
          </button>
          {categories?.map((c) => (
            <button
              key={c.query}
              className={`kp-chip${mode === 'results' && debounced === c.query ? ' is-active' : ''}`}
              onClick={() => {
                setQuery(c.query);
                setDebounced(c.query);
                setMode('results');
              }}
            >
              {c.category}
            </button>
          ))}
        </div>
      )}
      <div
        ref={scroller}
        className="kp-scroll scroll"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (mode === 'results' && el.scrollHeight - el.scrollTop - el.clientHeight < 400) loadMore();
        }}
      >
        {mode === 'home' && (
          <div className="kp-cats">
            <button className="kp-cat kp-cat-fav" onClick={() => setMode('favorites')}>
              {favPreview && <img src={favPreview} alt="" />}
              <span>
                <Star size={18} weight="fill" /> Favorites
              </span>
            </button>
            <button
              className="kp-cat"
              onClick={() => {
                setDebounced('');
                setMode('results');
              }}
            >
              {trendingPreview && <img src={trendingPreview} alt="" />}
              <span>
                <TrendUp size={18} weight="bold" /> Trending
              </span>
            </button>
            {categories === null && Array.from({ length: 6 }, (_, i) => <div key={i} className="kp-cat ui-skeleton" />)}
            {categories?.map((c) => (
              <button
                key={c.query}
                className="kp-cat"
                onClick={() => {
                  setQuery(c.query);
                  setDebounced(c.query);
                  setMode('results');
                }}
              >
                <img src={c.preview_url} alt="" loading="lazy" />
                <span>{c.category}</span>
              </button>
            ))}
          </div>
        )}
        {mode === 'favorites' &&
          (favorites.length ? (
            <Masonry tiles={favoriteTiles} columns={columns} />
          ) : (
            <div className="kp-error kp-fav-empty">
              <Star size={28} weight="duotone" />
              No favorite {label} yet. Tap the star on any {kind === 'gifs' ? 'GIF' : 'sticker'} to keep it here.
            </div>
          ))}
        {mode === 'results' && (
          <>
            {error && <div className="kp-error">{error}</div>}
            {!error && !loading && items.length === 0 && <div className="kp-error">Nothing found for "{debounced}"</div>}
            <Masonry tiles={resultTiles} columns={columns} />
            {loading && (
              <div className="kp-loading">
                <Spinner />
              </div>
            )}
          </>
        )}
      </div>
      <div className="kp-footer">Powered by KLIPY</div>
    </div>
  );
}
