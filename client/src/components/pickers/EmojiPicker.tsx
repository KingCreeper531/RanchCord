import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Basketball,
  Car,
  Clock,
  Flag,
  HandWaving,
  Hamburger,
  Heart,
  Lightbulb,
  MagnifyingGlass,
  PawPrint,
  Plus,
  Smiley,
  X,
} from '@phosphor-icons/react';
import { EMOJI_GROUPS, SKIN_TONES, loadEmojiData, searchEmojis, withSkin, type EmojiData, type EmojiEntry, type EmojiResult } from '../../lib/emoji';
import { isMobileDevice } from '../../lib/platform';
import { fileUrl } from '../../lib/server';
import { useBrand } from '../../lib/brand';
import { Emoji } from '../../lib/twemoji';
import { useData } from '../../store/data';
import { ui, useUi } from '../../store/ui';
import type { CustomEmoji } from '../../types';
import { Spinner, Tooltip } from '../ui';

export type EmojiPick = { kind: 'unicode'; char: string; shortcode: string } | { kind: 'custom'; emoji: CustomEmoji };

const GROUP_ICONS: Record<number, typeof Smiley> = {
  0: Smiley,
  1: HandWaving,
  3: PawPrint,
  4: Hamburger,
  6: Basketball,
  5: Car,
  7: Lightbulb,
  8: Heart,
  9: Flag,
};

type Hover = { label: string; shortcode: string; display: React.ReactNode } | null;

const Cell = memo(function Cell({
  char,
  custom,
  onPick,
  onHover,
}: {
  char?: string;
  custom?: CustomEmoji;
  onPick: () => void;
  onHover: () => void;
}) {
  return (
    <button className="ep-cell" onClick={onPick} onMouseEnter={onHover} onFocus={onHover} aria-label={custom ? `:${custom.name}:` : char}>
      {custom ? <img src={fileUrl(custom.url)} alt="" loading="lazy" draggable={false} /> : <Emoji char={char!} />}
    </button>
  );
});

export function EmojiPicker({ onPick, autoFocus = true, compact = false }: { onPick: (pick: EmojiPick) => void; autoFocus?: boolean; compact?: boolean }) {
  const [data, setData] = useState<EmojiData | null>(null);
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<Hover>(null);
  const [toneOpen, setToneOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('recent');
  const tone = useUi((s) => s.prefs.skinTone);
  const recent = useUi((s) => s.prefs.recentEmojis);
  const customMap = useData((s) => s.emojis);
  const brand = useBrand();
  const instanceName = brand.name;
  const custom = useMemo(() => Object.values(customMap).sort((a, b) => a.name.localeCompare(b.name)), [customMap]);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadEmojiData().then(setData);
    if (autoFocus && !isMobileDevice) setTimeout(() => input.current?.focus(), 30);
  }, [autoFocus]);

  const pickUnicode = (entry: EmojiEntry) => {
    const char = withSkin(entry, tone);
    ui.pushRecentEmoji(char);
    onPick({ kind: 'unicode', char, shortcode: entry.shortcodes[0] });
  };
  const pickCustom = (emoji: CustomEmoji) => {
    ui.pushRecentEmoji(`c:${emoji.id}`);
    onPick({ kind: 'custom', emoji });
  };

  const hoverUnicode = (entry: EmojiEntry) =>
    setHover({ label: entry.label, shortcode: entry.shortcodes[0], display: <Emoji char={withSkin(entry, tone)} /> });
  const hoverCustom = (e: CustomEmoji) =>
    setHover({ label: 'Photo emoji', shortcode: e.name, display: <img src={fileUrl(e.url)} alt="" /> });

  const results: EmojiResult[] | null = query.trim() && data ? searchEmojis(query, custom, 120) : null;

  const recentItems = useMemo(() => {
    if (!data) return [];
    return recent
      .map((key) => {
        if (key.startsWith('c:')) {
          const e = customMap[key.slice(2)];
          return e ? { key, custom: e } : null;
        }
        const entry = data.byUnicode.get(key) ?? data.byUnicode.get(key.replace(/️/g, ''));
        return entry ? { key, entry, char: key } : null;
      })
      .filter(Boolean)
      .slice(0, 24) as ({ key: string; custom: CustomEmoji } | { key: string; entry: EmojiEntry; char: string })[];
  }, [recent, data, customMap]);

  const jump = (id: string) => {
    const el = scroller.current?.querySelector(`[data-section="${id}"]`) as HTMLElement | null;
    if (el && scroller.current) scroller.current.scrollTo({ top: el.offsetTop - 4, behavior: 'smooth' });
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const sections = [...el.querySelectorAll<HTMLElement>('[data-section]')];
    let current = sections[0]?.dataset.section ?? 'recent';
    for (const s of sections) if (s.offsetTop - 8 <= el.scrollTop) current = s.dataset.section!;
    if (current !== activeSection) setActiveSection(current);
  };

  return (
    <div className={`ep${compact ? ' ep-compact' : ''}`}>
      <div className="ep-top">
        <div className="ep-search">
          <input
            ref={input}
            value={query}
            placeholder="Find the perfect emoji"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results?.length) {
                const r = results[0];
                if (r.kind === 'custom') pickCustom(r.emoji);
                else pickUnicode(r.entry);
              }
            }}
          />
          {query ? (
            <button className="ep-search-clear" onClick={() => setQuery('')} aria-label="Clear">
              <X size={14} weight="bold" />
            </button>
          ) : (
            <MagnifyingGlass size={16} className="ep-search-icon" />
          )}
        </div>
        <div className="ep-tone">
          <Tooltip label="Skin tone">
            <button className="ep-tone-btn" onClick={() => setToneOpen(!toneOpen)} aria-label="Skin tone">
              <Emoji char={`👋${SKIN_TONES[tone]}`} />
            </button>
          </Tooltip>
          {toneOpen && (
            <div className="ep-tone-menu">
              {SKIN_TONES.map((t, i) => (
                <button
                  key={i}
                  className={i === tone ? 'is-active' : ''}
                  onClick={() => {
                    ui.setPrefs({ skinTone: i });
                    setToneOpen(false);
                  }}
                >
                  <Emoji char={`👋${t}`} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="ep-main">
        {!results && (
          <nav className="ep-nav scroll-hidden">
            <NavBtn id="recent" label="Frequently used" active={activeSection} onClick={jump}>
              <Clock size={20} />
            </NavBtn>
            <NavBtn id="custom" label={instanceName} active={activeSection} onClick={jump}>
              <img src={brand.logo} alt="" className="ep-nav-mascot" />
            </NavBtn>
            <span className="ep-nav-sep" />
            {EMOJI_GROUPS.map((g) => {
              const Icon = GROUP_ICONS[g.id];
              return (
                <NavBtn key={g.id} id={`g${g.id}`} label={g.name} active={activeSection} onClick={jump}>
                  <Icon size={20} />
                </NavBtn>
              );
            })}
          </nav>
        )}
        <div ref={scroller} className="ep-scroll scroll" onScroll={onScroll} onMouseLeave={() => setHover(null)}>
          {!data && (
            <div className="ep-loading">
              <Spinner />
            </div>
          )}
          {data && results && (
            <section className="ep-section">
              <h4 className="ep-section-title">Search results</h4>
              {results.length ? (
                <div className="ep-grid">
                  {results.map((r) =>
                    r.kind === 'custom' ? (
                      <Cell key={`c${r.emoji.id}`} custom={r.emoji} onPick={() => pickCustom(r.emoji)} onHover={() => hoverCustom(r.emoji)} />
                    ) : (
                      <Cell key={r.entry.unicode} char={withSkin(r.entry, tone)} onPick={() => pickUnicode(r.entry)} onHover={() => hoverUnicode(r.entry)} />
                    ),
                  )}
                </div>
              ) : (
                <div className="ep-none">No emoji match "{query}"</div>
              )}
            </section>
          )}
          {data && !results && (
            <>
              {recentItems.length > 0 && (
                <section className="ep-section" data-section="recent">
                  <h4 className="ep-section-title">Frequently used</h4>
                  <div className="ep-grid">
                    {recentItems.map((it) =>
                      'custom' in it ? (
                        <Cell key={it.key} custom={it.custom} onPick={() => pickCustom(it.custom)} onHover={() => hoverCustom(it.custom)} />
                      ) : (
                        <Cell key={it.key} char={it.char} onPick={() => {
                          ui.pushRecentEmoji(it.char);
                          onPick({ kind: 'unicode', char: it.char, shortcode: it.entry.shortcodes[0] });
                        }} onHover={() => hoverUnicode(it.entry)} />
                      ),
                    )}
                  </div>
                </section>
              )}
              <section className="ep-section" data-section="custom">
                <h4 className="ep-section-title">{instanceName} emojis</h4>
                <div className="ep-grid">
                  {custom.map((e) => (
                    <Cell key={e.id} custom={e} onPick={() => pickCustom(e)} onHover={() => hoverCustom(e)} />
                  ))}
                  <Tooltip label="Add a photo emoji">
                    <button className="ep-cell ep-add" onClick={() => ui.openModal('emojiUpload')} aria-label="Add a photo emoji">
                      <Plus size={20} weight="bold" />
                    </button>
                  </Tooltip>
                </div>
                {custom.length === 0 && <p className="ep-hint">Turn any photo into an emoji everyone here can use.</p>}
              </section>
              {EMOJI_GROUPS.map((g) => (
                <section key={g.id} className="ep-section ep-lazy" data-section={`g${g.id}`}>
                  <h4 className="ep-section-title">{g.name}</h4>
                  <div className="ep-grid">
                    {(data.byGroup.get(g.id) ?? []).map((entry) => (
                      <Cell key={entry.unicode} char={withSkin(entry, tone)} onPick={() => pickUnicode(entry)} onHover={() => hoverUnicode(entry)} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
      {!compact && (
        <div className="ep-footer">
          {hover ? (
            <>
              <span className="ep-footer-emoji">{hover.display}</span>
              <span className="ep-footer-text">
                <strong>:{hover.shortcode}:</strong>
                <span className="truncate">{hover.label}</span>
              </span>
            </>
          ) : (
            <span className="ep-footer-text muted">Hover an emoji to see its name</span>
          )}
        </div>
      )}
    </div>
  );
}

function NavBtn({ id, label, active, onClick, children }: { id: string; label: string; active: string; onClick: (id: string) => void; children: React.ReactNode }) {
  return (
    <Tooltip label={label} side="right">
      <button className={`ep-nav-btn${active === id ? ' is-active' : ''}`} onClick={() => onClick(id)} aria-label={label}>
        {children}
      </button>
    </Tooltip>
  );
}
