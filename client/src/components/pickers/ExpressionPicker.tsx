import { useEffect, useRef } from 'react';
import { isMobileDevice } from '../../lib/platform';
import type { KlipyEmbed } from '../../types';
import { EmojiPicker } from './EmojiPicker';
import { KlipyPicker } from './KlipyPicker';

type Tab = 'emoji' | 'gifs' | 'stickers';

export function ExpressionPicker({
  tab,
  onTab,
  onClose,
  onEmoji,
  onKlipy,
}: {
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  onEmoji: (text: string) => void;
  onKlipy: (embed: KlipyEmbed) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      if (ref.current?.contains(target)) return;
      if (target.closest('.composer-tools')) return;
      if (target.closest('.ui-modal-layer')) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <>
      {isMobileDevice && <div className="xp-backdrop" onClick={onClose} />}
      <div ref={ref} className="xp" role="dialog" aria-label="Expression picker">
        {isMobileDevice && <div className="xp-handle" />}
        <div className="xp-tabs" role="tablist">
          {(['gifs', 'stickers', 'emoji'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`xp-tab${tab === t ? ' is-active' : ''}`} onClick={() => onTab(t)}>
              {t === 'gifs' ? 'GIFs' : t === 'stickers' ? 'Stickers' : 'Emoji'}
            </button>
          ))}
        </div>
        <div className="xp-body">
          {tab === 'emoji' && (
            <EmojiPicker
              onPick={(p) => {
                onEmoji(p.kind === 'custom' ? `:${p.emoji.name}: ` : p.char);
                if (isMobileDevice) onClose();
              }}
            />
          )}
          {tab === 'gifs' && <KlipyPicker key="gifs" kind="gifs" onPick={onKlipy} />}
          {tab === 'stickers' && <KlipyPicker key="stickers" kind="stickers" onPick={onKlipy} />}
        </div>
      </div>
    </>
  );
}
