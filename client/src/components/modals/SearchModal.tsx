import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MagnifyingGlass, X } from '@phosphor-icons/react';
import { api, errorMessage } from '../../lib/api';
import { formatTimestamp } from '../../lib/format';
import { plainPreview } from '../../lib/markdown';
import { channelLabel, displayNameIn, useData } from '../../store/data';
import { ui } from '../../store/ui';
import type { Message } from '../../types';
import { Avatar, Button, ModalFrame, Spinner } from '../ui';

type Scope = 'chat' | 'group' | 'all';

/** "from:alex" picks out whose messages to search. */
function parseQuery(raw: string) {
  const s = useData.getState();
  let from: string | undefined;
  let unknownFrom: string | undefined;
  const words: string[] = [];
  for (const part of raw.split(/\s+/).filter(Boolean)) {
    const m = /^from:@?(.+)$/i.exec(part);
    if (m) {
      const name = m[1].toLowerCase();
      from = Object.values(s.users).find((u) => u.username.toLowerCase() === name || u.displayName.toLowerCase() === name)?.id;
      unknownFrom = from ? undefined : m[1];
    } else words.push(part);
  }
  return { text: words.join(' '), from, unknownFrom };
}

function highlight(text: string, words: string[]): ReactNode[] {
  if (!words.length) return [text];
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

/** Search messages in this chat, this group, or everywhere you can read. */
export function SearchModal({ channelId, onClose }: { channelId?: string; onClose: () => void }) {
  const groupId = useData((s) => (channelId ? (s.channels[channelId]?.groupId ?? null) : null));
  const [scope, setScope] = useState<Scope>(groupId ? 'group' : channelId ? 'chat' : 'all');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [results, setResults] = useState<Message[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const req = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const parsed = useMemo(() => parseQuery(debounced), [debounced]);

  const search = async (before?: string) => {
    // Anything still on its way belongs to an older search now.
    const id = ++req.current;
    if (parsed.unknownFrom || (!parsed.text && !parsed.from)) {
      setLoading(false);
      setError(null);
      setHasMore(false);
      setResults(parsed.unknownFrom ? [] : null);
      return;
    }
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({ q: parsed.text });
    if (parsed.from) params.set('from', parsed.from);
    if (scope === 'chat' && channelId) params.set('channelId', channelId);
    if (scope === 'group' && groupId) params.set('groupId', groupId);
    if (before) params.set('before', before);
    try {
      const r = await api.get<{ messages: Message[]; hasMore: boolean }>(`/api/search?${params}`);
      if (id !== req.current) return;
      setResults((prev) => (before && prev ? [...prev, ...r.messages] : r.messages));
      setHasMore(r.hasMore);
    } catch (err) {
      if (id === req.current) setError(errorMessage(err));
    } finally {
      if (id === req.current) setLoading(false);
    }
  };

  useEffect(() => {
    void search();
  }, [parsed, scope]);

  const open = (m: Message) => {
    const ch = useData.getState().channels[m.channelId];
    if (!ch) return;
    onClose();
    if (ch.type === 'dm') ui.navigate({ kind: 'dm', channelId: ch.id });
    else if (ch.groupId) ui.navigate({ kind: 'group', groupId: ch.groupId, channelId: ch.id });
    ui.jumpToMessage(m.channelId, m.id);
  };

  const words = parsed.text.split(/\s+/).filter(Boolean);
  const s = useData.getState();

  return (
    <ModalFrame title="Search messages" onClose={onClose} size="md">
      <div className="search-box">
        <MagnifyingGlass size={18} className="search-box-icon" />
        <input
          autoFocus
          value={query}
          placeholder="Search for words, or from:name"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setDebounced(query.trim())}
        />
        {query && (
          <button className="search-box-clear" onClick={() => setQuery('')} aria-label="Clear">
            <X size={14} weight="bold" />
          </button>
        )}
      </div>
      <div className="kp-chips search-scopes">
        {channelId && !groupId && (
          <button className={`kp-chip${scope === 'chat' ? ' is-active' : ''}`} onClick={() => setScope('chat')}>
            This chat
          </button>
        )}
        {channelId && groupId && (
          <>
            <button className={`kp-chip${scope === 'chat' ? ' is-active' : ''}`} onClick={() => setScope('chat')}>
              This channel
            </button>
            <button className={`kp-chip${scope === 'group' ? ' is-active' : ''}`} onClick={() => setScope('group')}>
              This group
            </button>
          </>
        )}
        <button className={`kp-chip${scope === 'all' ? ' is-active' : ''}`} onClick={() => setScope('all')}>
          Everywhere
        </button>
      </div>
      {error && <div className="form-error">{error}</div>}
      {results === null && !loading && <p className="muted search-hint">Type to search. Try from:name to only see someone's messages.</p>}
      {results?.length === 0 && !loading && (
        <p className="muted search-hint">
          {parsed.unknownFrom ? `Nobody here is called "${parsed.unknownFrom}".` : `No messages match "${debounced}".`}
        </p>
      )}
      <div className="search-results">
        {results?.map((m) => {
          const ch = s.channels[m.channelId];
          return (
            <button key={m.id} className="search-result" onClick={() => open(m)}>
              <Avatar user={m.author} size={32} />
              <span className="search-result-body">
                <span className="search-result-head">
                  <strong>{displayNameIn(s, m.author.id, ch?.groupId ?? null)}</strong>
                  <span className="search-result-where">{ch ? (ch.type === 'dm' ? `DM · ${channelLabel(s, ch.id)}` : `#${ch.name}`) : ''}</span>
                  <time>{formatTimestamp(m.createdAt)}</time>
                </span>
                <span className="search-result-text">{highlight(plainPreview(m.content, s.users, s.emojis) || (m.attachments.length ? 'Sent a file' : ''), words)}</span>
              </span>
            </button>
          );
        })}
      </div>
      {loading && (
        <div className="gs-loading search-loading">
          <Spinner />
        </div>
      )}
      {hasMore && !loading && results && (
        <div className="gs-more">
          <Button size="sm" variant="secondary" onClick={() => void search(results.at(-1)?.id)}>
            Show older
          </Button>
        </div>
      )}
    </ModalFrame>
  );
}
