import { useMemo, useState } from 'react';
import { MagnifyingGlass, Plus, Star, Sticker as StickerIcon, X } from '@phosphor-icons/react';
import { deleteSticker, isFavorite, renameSticker, stickerEmbed, toggleFavorite } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { fileUrl } from '../../lib/server';
import { useData } from '../../store/data';
import { ui } from '../../store/ui';
import type { KlipyEmbed, Sticker } from '../../types';
import { Button, openMenu } from '../ui';
import { KlipyPicker } from './KlipyPicker';

type View = 'stickers' | 'favorites' | 'klipy';

const showError = (err: unknown) => ui.toast(errorMessage(err), 'error');

const star = (embed: KlipyEmbed) =>
  void toggleFavorite(embed)
    .then((on) => ui.toast(on ? 'Added to favorites' : 'Removed from favorites', 'success'))
    .catch(showError);

/**
 * The Stickers tab: stickers people on this server uploaded (anyone can add one), your favorites,
 * and KLIPY's sticker library as an extra.
 */
export function StickerPicker({ onPick }: { onPick: (embed: KlipyEmbed) => void }) {
  const stickers = useData((s) => s.stickers);
  const meId = useData((s) => s.me?.id);
  const isAdmin = useData((s) => Boolean(s.me?.isAdmin));
  const allFavorites = useData((s) => s.favorites);
  const favorites = useMemo(() => allFavorites.filter((f) => f.type === 'sticker'), [allFavorites]);
  const [view, setView] = useState<View>('stickers');
  const [query, setQuery] = useState('');

  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(stickers)
      .filter((x) => !q || x.name.toLowerCase().includes(q))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [stickers, query]);

  const upload = () => ui.openModal('stickerUpload', {});

  const menu = (e: React.MouseEvent, x: Sticker) => {
    e.preventDefault();
    const embed = stickerEmbed(x);
    const mine = x.creatorId === meId || isAdmin;
    openMenu(e, [
      { label: isFavorite(allFavorites, embed) ? 'Remove from favorites' : 'Add to favorites', icon: <Star size={16} />, onSelect: () => star(embed) },
      ...(mine
        ? [
            { separator: true as const },
            { label: 'Rename', onSelect: () => ui.openModal('stickerUpload', { renameId: x.id }) },
            {
              label: 'Delete sticker',
              danger: true,
              onSelect: () =>
                ui.openModal('confirm', {
                  title: `Delete "${x.name}"?`,
                  body: 'It disappears for everyone. Messages that already have it will show a broken picture.',
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: () => deleteSticker(x.id).catch(showError),
                }),
            },
          ]
        : []),
    ]);
  };

  const chips = (
    <div className="kp-chips" role="tablist">
      <button className={`kp-chip${view === 'stickers' ? ' is-active' : ''}`} onClick={() => setView('stickers')}>
        <StickerIcon size={14} weight="bold" /> Stickers
      </button>
      <button className={`kp-chip${view === 'favorites' ? ' is-active' : ''}`} onClick={() => setView('favorites')}>
        <Star size={14} weight="fill" /> Favorites
      </button>
      <button className={`kp-chip${view === 'klipy' ? ' is-active' : ''}`} onClick={() => setView('klipy')}>
        From KLIPY
      </button>
    </div>
  );

  if (view === 'klipy') {
    return (
      <div className="sp">
        {chips}
        <div className="sp-klipy">
          <KlipyPicker kind="stickers" onPick={onPick} />
        </div>
      </div>
    );
  }

  return (
    <div className="sp">
      <div className="sp-top">
        <div className="ep-search kp-search">
          <input value={query} placeholder="Search stickers" onChange={(e) => setQuery(e.target.value)} />
          {query ? (
            <button className="ep-search-clear" onClick={() => setQuery('')} aria-label="Clear">
              <X size={14} weight="bold" />
            </button>
          ) : (
            <MagnifyingGlass size={16} className="ep-search-icon" />
          )}
        </div>
        <Button size="sm" icon={<Plus size={16} weight="bold" />} onClick={upload}>
          Upload
        </Button>
      </div>
      {chips}
      <div className="sp-scroll scroll">
        {view === 'stickers' &&
          (list.length ? (
            <div className="sp-grid">
              {list.map((x) => (
                <button key={x.id} className="sp-tile" title={x.name} onClick={() => onPick(stickerEmbed(x))} onContextMenu={(e) => menu(e, x)}>
                  <img src={fileUrl(x.url)} alt={x.name} loading="lazy" draggable={false} />
                </button>
              ))}
            </div>
          ) : query ? (
            <div className="kp-error">No stickers called "{query}"</div>
          ) : (
            <div className="sp-empty">
              <StickerIcon size={40} weight="duotone" />
              <strong>No stickers yet</strong>
              <p>Turn any picture or GIF into a sticker. Everyone here can use it.</p>
              <Button size="sm" icon={<Plus size={16} weight="bold" />} onClick={upload}>
                Upload a sticker
              </Button>
            </div>
          ))}
        {view === 'favorites' &&
          (favorites.length ? (
            <div className="sp-grid">
              {favorites.map((e) => (
                <button
                  key={`${e.kind}:${e.slug}`}
                  className="sp-tile"
                  title={e.title}
                  onClick={() => onPick(e)}
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    openMenu(ev, [{ label: 'Remove from favorites', icon: <Star size={16} />, onSelect: () => star(e) }]);
                  }}
                >
                  <img src={fileUrl(e.webp ?? e.url)} alt={e.title} loading="lazy" draggable={false} />
                </button>
              ))}
            </div>
          ) : (
            <div className="kp-error kp-fav-empty">
              <Star size={28} weight="duotone" />
              No favorite stickers yet. Right-click (or hold) a sticker, or tap the star on one in a chat.
            </div>
          ))}
      </div>
    </div>
  );
}
