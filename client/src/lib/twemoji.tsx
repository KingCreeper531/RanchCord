import { memo, useState, type ReactNode } from 'react';
import { EMOJI_SOURCE } from './emoji';

/**
 * Discord-style emoji: every emoji is drawn with Discord's Twemoji artwork (bundled under /twemoji),
 * so they look identical on Windows, Android and iPhone.
 */

const VS16 = /️/g;
const ZWJ = '‍';

/** Twemoji file naming: code points joined by "-", dropping FE0F unless it's part of a ZWJ sequence. */
export function twemojiCode(emoji: string): string {
  const text = emoji.includes(ZWJ) ? emoji : emoji.replace(VS16, '');
  const out: string[] = [];
  for (const ch of text) out.push(ch.codePointAt(0)!.toString(16));
  return out.join('-');
}

export const twemojiUrl = (emoji: string) => `/twemoji/${twemojiCode(emoji)}.svg`;

const missing = new Set<string>();

export const Emoji = memo(function Emoji({ char, className = '', title }: { char: string; className?: string; title?: string }) {
  const [broken, setBroken] = useState(() => missing.has(char));
  if (broken) {
    return (
      <span className={`emoji emoji-native ${className}`} title={title}>
        {char}
      </span>
    );
  }
  return (
    <img
      className={`emoji emoji-tw ${className}`}
      src={twemojiUrl(char)}
      alt={char}
      title={title}
      draggable={false}
      loading="lazy"
      decoding="async"
      onError={() => {
        missing.add(char);
        setBroken(true);
      }}
    />
  );
});

const SPLIT = new RegExp(`(${EMOJI_SOURCE})`, 'u');

/** Plain text with any emoji in it swapped for Twemoji images (for statuses, names, sound labels). */
export function EmojiText({ text, className }: { text: string; className?: string }) {
  if (!text || !/[©® -㌀\ud83c-\ud83e]/.test(text)) return <>{text}</>;
  const parts = text.split(SPLIT);
  const nodes: ReactNode[] = parts.map((part, i) => {
    if (i % 2 === 1 && !(part.length === 1 && part.charCodeAt(0) < 0x2300)) return <Emoji key={i} char={part} className={className} />;
    return part;
  });
  return <>{nodes}</>;
}
