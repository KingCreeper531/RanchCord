import type { CustomEmoji } from '../types';

export interface EmojiEntry {
  unicode: string;
  label: string;
  shortcodes: string[];
  tags: string[];
  group: number;
  skins?: string[];
}

export interface EmojiData {
  list: EmojiEntry[];
  byGroup: Map<number, EmojiEntry[]>;
  byShortcode: Map<string, EmojiEntry>;
  byUnicode: Map<string, EmojiEntry>;
}

export const EMOJI_GROUPS = [
  { id: 0, name: 'Smileys & Emotion' },
  { id: 1, name: 'People & Body' },
  { id: 3, name: 'Animals & Nature' },
  { id: 4, name: 'Food & Drink' },
  { id: 6, name: 'Activities' },
  { id: 5, name: 'Travel & Places' },
  { id: 7, name: 'Objects' },
  { id: 8, name: 'Symbols' },
  { id: 9, name: 'Flags' },
] as const;

export const SKIN_TONES = ['', '🏻', '🏼', '🏽', '🏾', '🏿'];

let promise: Promise<EmojiData> | null = null;
let loaded: EmojiData | null = null;

interface RawEmoji {
  emoji: string;
  label: string;
  hexcode: string;
  group?: number;
  order?: number;
  version?: number;
  tags?: string[];
  skins?: { emoji: string; version?: number }[];
}

/** Newest Unicode emoji version covered by the bundled Discord Twemoji art (@discordapp/twemoji 17). */
const TWEMOJI_VERSION = 17;

export function loadEmojiData(): Promise<EmojiData> {
  promise ??= Promise.all([
    import('emojibase-data/en/data.json'),
    import('emojibase-data/en/shortcodes/github.json'),
  ]).then(([dataMod, codesMod]) => {
    const raw = (dataMod as unknown as { default: RawEmoji[] }).default;
    const codes = (codesMod as { default: Record<string, string | string[]> }).default;
    const maxVersion = TWEMOJI_VERSION;
    const list: EmojiEntry[] = [];
    const byGroup = new Map<number, EmojiEntry[]>();
    const byShortcode = new Map<string, EmojiEntry>();
    const byUnicode = new Map<string, EmojiEntry>();
    const sorted = raw
      .filter((e) => e.group !== undefined && e.group !== 2 && (e.version ?? 0) <= maxVersion)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    for (const e of sorted) {
      const sc = codes[e.hexcode];
      const shortcodes = sc ? (Array.isArray(sc) ? sc : [sc]) : [e.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')];
      const skins = e.skins?.filter((k) => (k.version ?? 0) <= maxVersion).map((k) => k.emoji);
      const entry: EmojiEntry = {
        unicode: e.emoji,
        label: e.label,
        shortcodes,
        tags: e.tags ?? [],
        group: e.group!,
        skins: skins && skins.length === 5 ? skins : undefined,
      };
      list.push(entry);
      if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
      byGroup.get(entry.group)!.push(entry);
      for (const code of shortcodes) if (!byShortcode.has(code)) byShortcode.set(code, entry);
      byUnicode.set(entry.unicode, entry);
      byUnicode.set(entry.unicode.replace(/️/g, ''), entry);
      entry.skins?.forEach((s) => byUnicode.set(s, entry));
    }
    loaded = { list, byGroup, byShortcode, byUnicode };
    return loaded;
  });
  return promise;
}

export const emojiDataSync = () => loaded;

export function withSkin(entry: EmojiEntry, tone: number): string {
  if (!tone || !entry.skins) return entry.unicode;
  return entry.skins[tone - 1] ?? entry.unicode;
}

export function shortcodeFor(unicode: string): string | null {
  const entry = loaded?.byUnicode.get(unicode) ?? loaded?.byUnicode.get(unicode.replace(/️/g, ''));
  return entry ? entry.shortcodes[0] : null;
}

export type EmojiResult = { kind: 'custom'; emoji: CustomEmoji } | { kind: 'unicode'; entry: EmojiEntry };

export function searchEmojis(query: string, custom: CustomEmoji[], limit = 60): EmojiResult[] {
  const q = query.toLowerCase().replace(/^:|:$/g, '').trim();
  if (!q) return [];
  const out: EmojiResult[] = [];
  const customHits = custom
    .filter((e) => e.name.toLowerCase().includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name));
  for (const e of customHits) out.push({ kind: 'custom', emoji: e });
  if (loaded) {
    const scored: { entry: EmojiEntry; score: number }[] = [];
    for (const entry of loaded.list) {
      let score = 0;
      for (const sc of entry.shortcodes) {
        if (sc === q) score = Math.max(score, 100);
        else if (sc.startsWith(q)) score = Math.max(score, 80 - sc.length);
        else if (sc.includes(q)) score = Math.max(score, 40);
      }
      if (!score) {
        const label = entry.label.toLowerCase();
        if (label.startsWith(q)) score = 35;
        else if (label.split(/\s+/).some((w) => w.startsWith(q))) score = 30;
        else if (entry.tags.some((t) => t.startsWith(q))) score = 20;
      }
      if (score) scored.push({ entry, score });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored) {
      out.push({ kind: 'unicode', entry: s.entry });
      if (out.length >= limit) break;
    }
  }
  return out.slice(0, limit);
}

/** `:joy:` -> 😂 and `:customname:` -> <:customname:ID> right before sending. */
export function expandEmojiShortcodes(text: string, custom: CustomEmoji[]): string {
  const byName = new Map(custom.map((e) => [e.name.toLowerCase(), e]));
  // Don't touch code spans/blocks.
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) => {
      if (i % 2 === 1) return part;
      return part.replace(/(^|[^<a-zA-Z0-9_]):([a-zA-Z0-9_+-]{2,32}):/g, (match, pre: string, name: string) => {
        const c = byName.get(name.toLowerCase());
        if (c) return `${pre}<${c.animated ? 'a' : ''}:${c.name}:${c.id}>`;
        const u = loaded?.byShortcode.get(name.toLowerCase());
        return u ? pre + u.unicode : match;
      });
    })
    .join('');
}

/** Matches a single emoji (with skin tones, ZWJ sequences, flags and keycaps). */
export const EMOJI_SOURCE =
  '(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?(?:\\u200D\\p{Extended_Pictographic}(?:\\uFE0F|\\p{Emoji_Modifier})?)*)';
