import { Fragment, type ReactNode, useMemo, useState } from 'react';
import { Check, Copy } from '@phosphor-icons/react';
import { EMOJI_SOURCE, shortcodeFor } from './emoji';
import { fileUrl, publicOrigin } from './server';
import { Emoji } from './twemoji';
import { useData, displayNameIn } from '../store/data';
import { ui } from '../store/ui';

/* ---------------- AST ---------------- */

export type MdNode =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'u' | 's' | 'spoiler'; c: MdNode[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: MdNode[] }
  | { t: 'mention'; id: string }
  | { t: 'role'; id: string }
  | { t: 'everyone'; v: string }
  | { t: 'custom'; name: string; id: string; animated: boolean }
  | { t: 'emoji'; v: string }
  | { t: 'time'; unix: number; style: string };

export type MdBlock =
  | { t: 'p'; c: MdNode[] }
  | { t: 'codeblock'; lang: string; v: string }
  | { t: 'quote'; c: MdBlock[] }
  | { t: 'h'; level: 1 | 2 | 3; c: MdNode[] }
  | { t: 'sub'; c: MdNode[] }
  | { t: 'list'; items: MdNode[][] };

const ID = '[0-9A-HJKMNP-TV-Z]{26}';
type Sub = (s: string) => MdNode[];

interface Rule {
  re: RegExp;
  make: (m: RegExpExecArray, sub: Sub) => MdNode | null;
  wordStart?: boolean;
}

const RULES: Rule[] = [
  { re: /\\([\\*_~`|<>#\-[\]():@])/y, make: (m) => ({ t: 'text', v: m[1] }) },
  {
    re: /(`+)([\s\S]*?[^`])\1(?!`)/y,
    make: (m) => ({ t: 'code', v: m[2].length > 2 && m[2].startsWith(' ') && m[2].endsWith(' ') ? m[2].slice(1, -1) : m[2] }),
  },
  { re: new RegExp(`<@(${ID})>`, 'y'), make: (m) => ({ t: 'mention', id: m[1] }) },
  { re: new RegExp(`<@&(${ID})>`, 'y'), make: (m) => ({ t: 'role', id: m[1] }) },
  { re: new RegExp(`<(a?):([a-zA-Z0-9_]{2,32}):(${ID})>`, 'y'), make: (m) => ({ t: 'custom', animated: Boolean(m[1]), name: m[2], id: m[3] }) },
  // Discord timestamps: <t:1700000000> or <t:1700000000:R>, shown in each reader's own time zone.
  { re: /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/y, make: (m) => ({ t: 'time', unix: Number(m[1]), style: m[2] ?? 'f' }) },
  { re: /\[([^\]\n]{1,200})\]\((https?:\/\/[^\s)]+)\)/y, make: (m, sub) => ({ t: 'link', href: m[2], c: sub(m[1]) }) },
  { re: /<(https?:\/\/[^\s>]+)>/y, make: (m) => ({ t: 'link', href: m[1], c: [{ t: 'text', v: m[1] }] }) },
  { re: /https?:\/\/[^\s<]+[^<.,:;"'!?)\]\s]/y, make: (m) => ({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] }) },
  { re: /\|\|([\s\S]+?)\|\|/y, make: (m, sub) => ({ t: 'spoiler', c: sub(m[1]) }) },
  { re: /\*\*\*([\s\S]+?)\*\*\*(?!\*)/y, make: (m, sub) => ({ t: 'strong', c: [{ t: 'em', c: sub(m[1]) }] }) },
  { re: /\*\*([\s\S]+?)\*\*(?!\*)/y, make: (m, sub) => ({ t: 'strong', c: sub(m[1]) }) },
  { re: /__([\s\S]+?)__(?!_)/y, make: (m, sub) => ({ t: 'u', c: sub(m[1]) }) },
  { re: /\*(?=\S)([\s\S]*?\S)\*(?!\*)/y, make: (m, sub) => ({ t: 'em', c: sub(m[1]) }) },
  { re: /_(?=\S)([\s\S]*?\S)_(?![\p{L}\p{N}_])/uy, make: (m, sub) => ({ t: 'em', c: sub(m[1]) }), wordStart: true },
  { re: /~~([\s\S]+?)~~/y, make: (m, sub) => ({ t: 's', c: sub(m[1]) }) },
  { re: /@(everyone|here)\b/y, make: (m) => ({ t: 'everyone', v: m[0] }) },
  {
    re: new RegExp(EMOJI_SOURCE, 'uy'),
    make: (m) => {
      const v = m[0];
      // Text-style symbols like © ® ™ ↔ stay as text unless explicitly emoji-styled.
      if (v.length === 1 && v.charCodeAt(0) < 0x2300) return null;
      return { t: 'emoji', v };
    },
  },
];

const TRIGGERS = new Set(['\\', '`', '<', '[', '|', '*', '_', '~', '@', '#']);
const WORD = /[\p{L}\p{N}_]/u;

export function parseInline(src: string, depth = 0): MdNode[] {
  const out: MdNode[] = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) {
      out.push({ t: 'text', v: buf });
      buf = '';
    }
  };
  const sub: Sub = (s) => (depth > 6 ? [{ t: 'text', v: s }] : parseInline(s, depth + 1));
  while (i < src.length) {
    const ch = src[i];
    const code = src.charCodeAt(i);
    const digitKeycap = code >= 48 && code <= 57 && (src[i + 1] === '⃣' || src[i + 2] === '⃣');
    if (TRIGGERS.has(ch) || code > 127 || digitKeycap || (ch === 'h' && src.startsWith('http', i))) {
      let matched = false;
      for (const rule of RULES) {
        if (rule.wordStart && i > 0 && WORD.test(src[i - 1])) continue;
        rule.re.lastIndex = i;
        const m = rule.re.exec(src);
        if (m && m[0].length) {
          const node = rule.make(m, sub);
          if (!node) continue;
          flush();
          if (node.t === 'text' && out.length && out[out.length - 1].t === 'text') {
            (out[out.length - 1] as { v: string }).v += node.v;
          } else out.push(node);
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    const cp = src.codePointAt(i)!;
    const s = String.fromCodePoint(cp);
    buf += s;
    i += s.length;
  }
  flush();
  return out;
}

function parseLines(text: string): MdBlock[] {
  const lines = text.split('\n');
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const joined = para.join('\n');
    if (joined.trim()) blocks.push({ t: 'p', c: parseInline(joined) });
    else if (joined.length && blocks.length) blocks.push({ t: 'p', c: [{ t: 'text', v: joined }] });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('>>> ')) {
      flushPara();
      blocks.push({ t: 'quote', c: parseLines([line.slice(4), ...lines.slice(i + 1)].join('\n')) });
      return blocks;
    }
    if (/^> ?/.test(line) && line !== '>') {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && /^> ?/.test(lines[i])) {
        quoted.push(lines[i].replace(/^> ?/, ''));
        i++;
      }
      i--;
      blocks.push({ t: 'quote', c: parseLines(quoted.join('\n')) });
      continue;
    }
    const h = /^(#{1,3}) (.+)$/.exec(line);
    if (h) {
      flushPara();
      blocks.push({ t: 'h', level: h[1].length as 1 | 2 | 3, c: parseInline(h[2]) });
      continue;
    }
    const sub = /^-# (.+)$/.exec(line);
    if (sub) {
      flushPara();
      blocks.push({ t: 'sub', c: parseInline(sub[1]) });
      continue;
    }
    if (/^\s*[-*] \S/.test(line)) {
      flushPara();
      const items: MdNode[][] = [];
      while (i < lines.length && /^\s*[-*] \S/.test(lines[i])) {
        items.push(parseInline(lines[i].replace(/^\s*[-*] /, '')));
        i++;
      }
      i--;
      blocks.push({ t: 'list', items });
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

export function parseMarkdown(src: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  const fence = /```(?:([\w+#.-]{1,24})?\n)?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(src))) {
    if (m.index > last) blocks.push(...parseLines(src.slice(last, m.index).replace(/\n$/, '')));
    blocks.push({ t: 'codeblock', lang: m[1] ?? '', v: m[2].replace(/\n$/, '') });
    last = fence.lastIndex;
    if (src[last] === '\n') last++;
  }
  if (last < src.length) blocks.push(...parseLines(src.slice(last)));
  return blocks;
}

/** True when the message is only emoji (up to 27), which Discord-style shows big. */
export function isJumbo(blocks: MdBlock[]): boolean {
  if (blocks.length !== 1 || blocks[0].t !== 'p') return false;
  let count = 0;
  for (const n of blocks[0].c) {
    if (n.t === 'emoji' || n.t === 'custom') count++;
    else if (n.t === 'text' && !n.v.trim()) continue;
    else return false;
  }
  return count > 0 && count <= 27;
}

/* ---------------- rendering ---------------- */

function Mention({ id, groupId }: { id: string; groupId?: string | null }) {
  const name = useData((s) => (s.users[id] ? displayNameIn(s, id, groupId) : null));
  const isMe = useData((s) => s.me?.id === id);
  return (
    <span
      className={`md-mention${isMe ? ' md-mention-me' : ''}`}
      role="button"
      tabIndex={0}
      onClick={(e) => ui.showProfile(id, e.currentTarget, groupId)}
    >
      @{name ?? 'unknown-user'}
    </span>
  );
}

function RoleMention({ id, groupId }: { id: string; groupId?: string | null }) {
  const role = useData((s) => (groupId ? s.groups[groupId]?.roles[id] : undefined));
  const style = role?.color ? { color: role.color, background: `${role.color}26` } : undefined;
  return (
    <span className="md-mention md-mention-role" style={style}>
      @{role?.name ?? 'deleted-role'}
    </span>
  );
}

export function CustomEmojiImage({ id, name, className }: { id: string; name: string; className?: string }) {
  const emoji = useData((s) => s.emojis[id]);
  if (!emoji) return <span className="md-emoji-missing">:{name}:</span>;
  return (
    <img
      className={`emoji emoji-custom ${className ?? ''}`}
      src={fileUrl(emoji.url)}
      alt={`:${emoji.name}:`}
      title={`:${emoji.name}:`}
      draggable={false}
      loading="lazy"
    />
  );
}

const TIME_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
  t: { timeStyle: 'short' },
  T: { timeStyle: 'medium' },
  d: { dateStyle: 'short' },
  D: { dateStyle: 'long' },
  f: { dateStyle: 'long', timeStyle: 'short' },
  F: { dateStyle: 'full', timeStyle: 'short' },
};

function relative(ms: number) {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const diff = (ms - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
  for (const [unit, size] of steps) if (Math.abs(diff) >= size) return rtf.format(Math.round(diff / size), unit);
  return rtf.format(Math.round(diff), 'second');
}

/** A <t:...> timestamp, in the reader's own time zone. */
function TimeStamp({ unix, style }: { unix: number; style: string }) {
  const ms = unix * 1000;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return <>{`<t:${unix}>`}</>;
  const text = style === 'R' ? relative(ms) : new Intl.DateTimeFormat(undefined, TIME_STYLES[style] ?? TIME_STYLES.f).format(date);
  return (
    <time className="md-time" dateTime={date.toISOString()} title={new Intl.DateTimeFormat(undefined, TIME_STYLES.F).format(date)}>
      {text}
    </time>
  );
}

/** Links to a chat or message on this same server open right here. */
function openOwnLink(e: React.MouseEvent<HTMLAnchorElement>) {
  const m = /#\/channels\/[^\s]+$/.exec(e.currentTarget.href);
  if (!m) return;
  const s = useData.getState();
  const base = publicOrigin(s.instance?.publicUrl);
  if (!e.currentTarget.href.startsWith(base) && !e.currentTarget.href.startsWith(location.origin)) return;
  e.preventDefault();
  location.hash = m[0];
}

function Spoiler({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className={`md-spoiler${open ? ' is-open' : ''}`}
      onClick={(e) => {
        if (!open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }
      }}
      role={open ? undefined : 'button'}
      aria-label={open ? undefined : 'Spoiler, click to reveal'}
    >
      <span className="md-spoiler-inner">{children}</span>
    </span>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-codeblock">
      {lang && <span className="md-codeblock-lang">{lang}</span>}
      <button
        className="md-codeblock-copy"
        title="Copy code"
        onClick={() => {
          void navigator.clipboard.writeText(code).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          });
        }}
      >
        {copied ? <Check size={14} weight="bold" /> : <Copy size={14} />}
      </button>
      <pre className="scroll">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function renderNodes(nodes: MdNode[], groupId: string | null | undefined, key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{n.v}</Fragment>;
      case 'strong':
        return <strong key={k}>{renderNodes(n.c, groupId, k)}</strong>;
      case 'em':
        return <em key={k}>{renderNodes(n.c, groupId, k)}</em>;
      case 'u':
        return <u key={k}>{renderNodes(n.c, groupId, k)}</u>;
      case 's':
        return <s key={k}>{renderNodes(n.c, groupId, k)}</s>;
      case 'spoiler':
        return <Spoiler key={k}>{renderNodes(n.c, groupId, k)}</Spoiler>;
      case 'code':
        return (
          <code key={k} className="md-code">
            {n.v}
          </code>
        );
      case 'time':
        return <TimeStamp key={k} unix={n.unix} style={n.style} />;
      case 'link':
        return (
          <a key={k} href={n.href} target="_blank" rel="noreferrer noopener" title={n.href} onClick={openOwnLink}>
            {renderNodes(n.c, groupId, k)}
          </a>
        );
      case 'mention':
        return <Mention key={k} id={n.id} groupId={groupId} />;
      case 'role':
        return <RoleMention key={k} id={n.id} groupId={groupId} />;
      case 'everyone':
        return (
          <span key={k} className="md-mention md-mention-everyone">
            {n.v}
          </span>
        );
      case 'custom':
        return <CustomEmojiImage key={k} id={n.id} name={n.name} />;
      case 'emoji': {
        const sc = shortcodeFor(n.v);
        return (
<Emoji key={k} char={n.v} title={sc ? `:${sc}:` : undefined} />
        );
      }
    }
  });
}

function renderBlocks(blocks: MdBlock[], groupId: string | null | undefined, key = ''): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}b${i}`;
    switch (b.t) {
      case 'p':
        return (
          <div key={k} className="md-p">
            {renderNodes(b.c, groupId, k)}
          </div>
        );
      case 'codeblock':
        return <CodeBlock key={k} lang={b.lang} code={b.v} />;
      case 'quote':
        return (
          <blockquote key={k} className="md-quote">
            {renderBlocks(b.c, groupId, k)}
          </blockquote>
        );
      case 'h': {
        const Tag = `h${b.level}` as 'h1' | 'h2' | 'h3';
        return (
          <Tag key={k} className="md-h">
            {renderNodes(b.c, groupId, k)}
          </Tag>
        );
      }
      case 'sub':
        return (
          <div key={k} className="md-sub">
            {renderNodes(b.c, groupId, k)}
          </div>
        );
      case 'list':
        return (
          <ul key={k} className="md-list">
            {b.items.map((item, j) => (
              <li key={j}>{renderNodes(item, groupId, `${k}l${j}`)}</li>
            ))}
          </ul>
        );
    }
  });
}

export function Markdown({ content, groupId, suffix }: { content: string; groupId?: string | null; suffix?: ReactNode }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);
  const jumbo = useMemo(() => isJumbo(blocks), [blocks]);
  const rendered = renderBlocks(blocks, groupId);
  return (
    <div className={`md selectable${jumbo ? ' md-jumbo' : ''}`}>
      {rendered}
      {suffix}
    </div>
  );
}

/** One-line plain-text preview, used for replies and notifications. */
export function plainPreview(content: string, users: Record<string, { displayName: string }>, emojis: Record<string, { name: string }>) {
  return content
    .replace(new RegExp(`<@(${ID})>`, 'g'), (_, id: string) => `@${users[id]?.displayName ?? 'unknown'}`)
    .replace(new RegExp(`<@&(${ID})>`, 'g'), '@role')
    .replace(new RegExp(`<a?:([a-zA-Z0-9_]{2,32}):(${ID})>`, 'g'), (_, name: string, id: string) => `:${emojis[id]?.name ?? name}:`)
    .replace(/<t:(-?\d{1,13})(?::[tTdDfFR])?>/g, (_, s: string) => new Date(Number(s) * 1000).toLocaleString())
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/\|\|([\s\S]+?)\|\|/g, '▮▮▮')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Inline renderer for short text like reply previews (no blocks). */
export function InlineMarkdown({ content, groupId }: { content: string; groupId?: string | null }) {
  const nodes = useMemo(() => parseInline(content.replace(/\n+/g, ' ')), [content]);
  return <>{renderNodes(nodes, groupId)}</>;
}
