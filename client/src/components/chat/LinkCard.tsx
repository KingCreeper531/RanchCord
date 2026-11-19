import { useEffect, useState } from 'react';
import { Play } from '@phosphor-icons/react';
import { api } from '../../lib/api';
import { ui } from '../../store/ui';

/** What the server found on a linked page (server/src/lib/linkPreview.ts). */
export interface LinkPreview {
  url: string;
  siteName: string | null;
  title: string | null;
  description: string | null;
  image: string | null;
  largeImage: boolean;
  color: string | null;
  youtubeId: string | null;
}

/* Previews are asked for once per link per visit, however many messages repeat it. */
const cache = new Map<string, LinkPreview | null>();
const pending = new Map<string, Promise<LinkPreview | null>>();

function loadPreview(url: string): Promise<LinkPreview | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url)!);
  let p = pending.get(url);
  if (!p) {
    p = api
      .get<{ preview: LinkPreview | null }>(`/api/link-preview?url=${encodeURIComponent(url)}`)
      .then((r) => r.preview)
      .catch(() => null)
      .then((r) => {
        cache.set(url, r);
        pending.delete(url);
        return r;
      });
    pending.set(url, p);
  }
  return p;
}

/** Links worth previewing in a message: not pictures (shown as pictures), not invites, at most 3. */
export function previewableLinks(text: string, skip: (url: string) => boolean): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>]+/g)) {
    let url = m[0].replace(/[.,!?:;'"]+$/, '');
    // A closing bracket belongs to the sentence unless the link opened one itself (like Wikipedia's).
    while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    if (!skip(url) && !out.includes(url)) out.push(url);
    if (out.length === 3) break;
  }
  return out;
}

function YouTubeCard({ p }: { p: LinkPreview }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div className="link-card is-video" style={{ borderLeftColor: p.color ?? undefined }}>
      <div className="link-card-text">
        <span className="link-card-site">{p.siteName ?? 'YouTube'}</span>
        {p.title && (
          <a className="link-card-title" href={p.url} target="_blank" rel="noreferrer noopener">
            {p.title}
          </a>
        )}
        {p.description && <span className="link-card-author">{p.description}</span>}
        <div className="link-card-player">
          {playing ? (
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${p.youtubeId}?autoplay=1&rel=0`}
              title={p.title ?? 'YouTube video'}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          ) : (
            <button className="link-card-play" onClick={() => setPlaying(true)} aria-label="Play video">
              {p.image && <img src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" />}
              <span className="link-card-play-icon">
                <Play size={26} weight="fill" />
              </span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A Discord-style preview card for a link: site, title, description and picture. */
export function LinkCard({ url }: { url: string }) {
  const [p, setP] = useState<LinkPreview | null | undefined>(() => (cache.has(url) ? cache.get(url) : undefined));
  useEffect(() => {
    if (p !== undefined) return;
    let live = true;
    void loadPreview(url).then((r) => live && setP(r));
    return () => {
      live = false;
    };
  }, [url, p]);
  if (!p) return null;
  if (p.youtubeId) return <YouTubeCard p={p} />;
  const openImage = () => p.image && ui.openModal('lightbox', { src: p.image, filename: p.title ?? '', download: false, original: url });
  return (
    <div className={`link-card${p.image && !p.largeImage ? ' has-thumb' : ''}`} style={{ borderLeftColor: p.color ?? undefined }}>
      <div className="link-card-text">
        {p.siteName && <span className="link-card-site">{p.siteName}</span>}
        {p.title && (
          <a className="link-card-title" href={url} target="_blank" rel="noreferrer noopener">
            {p.title}
          </a>
        )}
        {p.description && <p className="link-card-desc">{p.description}</p>}
        {p.image && p.largeImage && (
          <img className="link-card-image" src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" onClick={openImage} />
        )}
      </div>
      {p.image && !p.largeImage && <img className="link-card-thumb" src={p.image} alt="" loading="lazy" referrerPolicy="no-referrer" onClick={openImage} />}
    </div>
  );
}
