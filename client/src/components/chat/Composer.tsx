import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import {
  At,
  File as FileIcon,
  Gif,
  PaperPlaneRight,
  PlusCircle,
  Smiley,
  Sticker,
  X,
  XCircle,
  FileVideo,
  FileAudio,
} from '@phosphor-icons/react';
import { askToLinkStorage, sendMessage, sendTyping, stopTyping, uploadAttachment } from '../../lib/actions';
import { loadEmojiData, searchEmojis, emojiDataSync, type EmojiResult } from '../../lib/emoji';
import { formatBytes } from '../../lib/format';
import { isMobileDevice } from '../../lib/platform';
import { fileUrl } from '../../lib/server';
import { Emoji } from '../../lib/twemoji';
import { useShallow } from 'zustand/react/shallow';
import { PERM, can } from '../../lib/perms';
import { displayNameIn, useData } from '../../store/data';
import { ui, useUi } from '../../store/ui';
import type { Attachment, User } from '../../types';
import { Avatar, Tooltip } from '../ui';

export interface ComposerHandle {
  addFiles(files: File[]): void;
  focus(): void;
}

interface PendingFile {
  key: string;
  file: File;
  preview: string | null;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
  abort: AbortController;
  promise: Promise<Attachment | null>;
}

type Suggestion =
  | { kind: 'user'; user: User; name: string }
  | { kind: 'role'; id: string; name: string; color: string | null }
  | { kind: 'everyone'; value: '@everyone' | '@here'; hint: string }
  | { kind: 'emoji'; result: EmojiResult };

interface AcState {
  trigger: '@' | ':';
  query: string;
  start: number;
  items: Suggestion[];
  index: number;
}

const drafts = new Map<string, string>();

function useChannelMembers(channelId: string) {
  return useData(useShallow((s) => {
    const ch = s.channels[channelId];
    if (!ch) return [] as string[];
    if (ch.type === 'dm') return [s.me!.id, ch.recipientId].filter(Boolean) as string[];
    return Object.keys(s.groups[ch.groupId ?? '']?.members ?? {});
  }));
}

export const Composer = forwardRef<ComposerHandle, { channelId: string; placeholder: string; onPicker: (tab: 'emoji' | 'gifs' | 'stickers') => void; pickerOpen: string | null }>(
  function Composer({ channelId, placeholder, onPicker, pickerOpen }, ref) {
    const [text, setText] = useState(() => drafts.get(channelId) ?? '');
    const [files, setFiles] = useState<PendingFile[]>([]);
    const [ac, setAc] = useState<AcState | null>(null);
    const [replyPing, setReplyPing] = useState(true);
    const [sending, setSending] = useState(false);
    const ta = useRef<HTMLTextAreaElement>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const replyId = useUi((s) => s.replyTo[channelId]);
    const replyMsg = useData((s) => (replyId ? s.messages[channelId]?.list.find((m) => m.id === replyId) : undefined));
    const groupId = useData((s) => s.channels[channelId]?.groupId ?? null);
    const replyName = useData((s) => (replyMsg ? displayNameIn(s, replyMsg.author.id, groupId) : ''));
    const meId = useData((s) => s.me!.id);
    const memberIds = useChannelMembers(channelId);
    const insert = useUi((s) => s.composerInsert);

    // channel switch: swap drafts
    const prevChannel = useRef(channelId);
    useEffect(() => {
      if (prevChannel.current !== channelId) {
        drafts.set(prevChannel.current, ta.current?.value ?? '');
        setText(drafts.get(channelId) ?? '');
        setFiles((list) => {
          list.forEach((f) => f.abort.abort());
          return [];
        });
        setAc(null);
        setReplyPing(true);
        prevChannel.current = channelId;
      }
      if (!isMobileDevice) ta.current?.focus();
    }, [channelId]);

    useEffect(() => () => {
      drafts.set(prevChannel.current, ta.current?.value ?? '');
    }, []);

    useEffect(() => {
      if (replyId && !isMobileDevice) ta.current?.focus();
      setReplyPing(true);
    }, [replyId]);

    // auto-grow
    useEffect(() => {
      const el = ta.current;
      if (!el) return;
      el.style.height = '0px';
      el.style.height = `${Math.min(el.scrollHeight, Math.max(160, window.innerHeight * 0.4))}px`;
    }, [text]);

    const insertText = useCallback((value: string) => {
      const el = ta.current;
      if (!el) {
        setText((t) => t + value);
        return;
      }
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      const before = el.value.slice(0, start);
      const needsSpace = before.length > 0 && !/\s$/.test(before) && /^[@:]/.test(value);
      const next = before + (needsSpace ? ' ' : '') + value + el.value.slice(end);
      setText(next);
      const caret = start + value.length + (needsSpace ? 1 : 0);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(caret, caret);
      });
    }, []);

    // Each insert (an emoji picked from the picker) is used exactly once. It used to stay in the store,
    // so the old emoji popped back into the box whenever this chat's typing box showed up again.
    useEffect(() => {
      if (!insert || insert.channelId !== channelId) return;
      useUi.setState({ composerInsert: null });
      if (Date.now() - insert.n > 3000) return;
      insertText(insert.text);
    }, [insert, channelId, insertText]);

    const addFiles = useCallback((list: File[]) => {
      if (!list.length) return;
      if (!useData.getState().myStorage?.linked) {
        askToLinkStorage();
        return;
      }
      const added = list.slice(0, 20).map((file) => {
        const abort = new AbortController();
        const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`;
        const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : null;
        const update = (patch: Partial<PendingFile>) => setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...patch } : f)));
        const promise = uploadAttachment(file, (p) => update({ progress: p }), abort.signal)
          .then((attachment) => {
            update({ status: 'done', attachment, progress: 1 });
            return attachment;
          })
          .catch((err: Error) => {
            if (err.name !== 'AbortError') update({ status: 'error', error: err.message });
            return null;
          });
        return { key, file, preview, progress: 0, status: 'uploading' as const, abort, promise };
      });
      setFiles((fs) => [...fs, ...added]);
      ta.current?.focus();
    }, []);

    useImperativeHandle(ref, () => ({ addFiles, focus: () => ta.current?.focus() }), [addFiles]);

    const removeFile = (key: string) =>
      setFiles((fs) => {
        const f = fs.find((x) => x.key === key);
        f?.abort.abort();
        if (f?.preview) URL.revokeObjectURL(f.preview);
        return fs.filter((x) => x.key !== key);
      });

    /* ---------- autocomplete ---------- */

    const computeAc = useCallback(
      (value: string, caret: number): AcState | null => {
        const before = value.slice(0, caret);
        const m = /(^|\s)([@:])([^\s@:]{0,32})$/.exec(before);
        if (!m) return null;
        const trigger = m[2] as '@' | ':';
        const query = m[3];
        const start = caret - query.length - 1;
        const s = useData.getState();
        let items: Suggestion[] = [];
        if (trigger === '@') {
          const q = query.toLowerCase();
          const users = memberIds
            .map((id) => s.users[id])
            .filter(Boolean)
            .map((u) => ({ user: u, name: displayNameIn(s, u.id, groupId) }))
            .filter(({ user, name }) => !q || user.username.toLowerCase().includes(q) || name.toLowerCase().includes(q))
            .sort((a, b) => {
              const as = a.user.username.toLowerCase().startsWith(q) || a.name.toLowerCase().startsWith(q) ? 0 : 1;
              const bs = b.user.username.toLowerCase().startsWith(q) || b.name.toLowerCase().startsWith(q) ? 0 : 1;
              const ao = s.presences[a.user.id] ? 0 : 1;
              const bo = s.presences[b.user.id] ? 0 : 1;
              return as - bs || ao - bo || a.name.localeCompare(b.name);
            })
            .slice(0, 8);
          items = users.map((u) => ({ kind: 'user', ...u }));
          if (groupId) {
            const g = s.groups[groupId];
            const canAll = can(s, groupId, PERM.MENTION_EVERYONE);
            for (const r of Object.values(g?.roles ?? {}).sort((a, b) => b.position - a.position)) {
              if ((r.mentionable || canAll) && (!q || r.name.toLowerCase().includes(q))) items.push({ kind: 'role', id: r.id, name: r.name, color: r.color });
            }
            if ('everyone'.startsWith(q)) items.push({ kind: 'everyone', value: '@everyone', hint: 'Notify everyone in this group' });
            if ('here'.startsWith(q)) items.push({ kind: 'everyone', value: '@here', hint: 'Notify everyone online' });
          }
        } else {
          if (query.length < 2) return null;
          if (!emojiDataSync()) void loadEmojiData();
          items = searchEmojis(query, Object.values(s.emojis), 10).map((result) => ({ kind: 'emoji', result }));
        }
        if (!items.length) return null;
        return { trigger, query, start, items, index: 0 };
      },
      [memberIds, groupId],
    );

    const applySuggestion = (sug: Suggestion) => {
      if (!ac) return;
      const el = ta.current!;
      const caret = el.selectionStart ?? text.length;
      let replacement = '';
      if (sug.kind === 'user') replacement = `@${sug.user.username} `;
      else if (sug.kind === 'role') replacement = `@${sug.name} `;
      else if (sug.kind === 'everyone') replacement = `${sug.value} `;
      else replacement = sug.result.kind === 'custom' ? `:${sug.result.emoji.name}: ` : `${sug.result.entry.unicode} `;
      const next = text.slice(0, ac.start) + replacement + text.slice(caret);
      setText(next);
      setAc(null);
      const pos = ac.start + replacement.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(pos, pos);
      });
    };

    /* ---------- send ---------- */

    const uploading = files.some((f) => f.status === 'uploading');
    const canSend = Boolean(text.trim()) || files.some((f) => f.status !== 'error');

    const send = async () => {
      if (sending || !canSend) return;
      const content = text;
      const pending = files;
      setText('');
      drafts.delete(channelId);
      setFiles([]);
      setAc(null);
      stopTyping(channelId);
      const replyToId = replyId ?? null;
      ui.setReply(channelId, undefined);
      let attachments: Attachment[] = [];
      if (pending.length) {
        setSending(true);
        const results = await Promise.all(pending.map((f) => f.promise));
        setSending(false);
        attachments = results.filter((a): a is Attachment => Boolean(a));
        pending.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
        if (!attachments.length && !content.trim()) {
          ui.toast("Your files didn't upload, so nothing was sent", 'error');
          return;
        }
      }
      await sendMessage(channelId, { content, replyToId, replyPing, attachments });
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (ac) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          const d = e.key === 'ArrowDown' ? 1 : -1;
          setAc({ ...ac, index: (ac.index + d + ac.items.length) % ac.items.length });
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          applySuggestion(ac.items[ac.index]);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setAc(null);
          return;
        }
      }
      if (e.key === 'Enter' && !e.shiftKey && !isMobileDevice && !e.nativeEvent.isComposing) {
        e.preventDefault();
        void send();
        return;
      }
      if (e.key === 'Escape') {
        if (replyId) {
          e.preventDefault();
          ui.setReply(channelId, undefined);
        }
        return;
      }
      if (e.key === 'ArrowUp' && !text && !files.length) {
        const list = useData.getState().messages[channelId]?.list ?? [];
        const last = [...list].reverse().find((m) => m.author.id === meId && !m.pending && !m.failed && m.type === 'default');
        if (last) {
          e.preventDefault();
          ui.setEditing(last.id);
        }
      }
    };

    const acList = useMemo(() => ac, [ac]);

    return (
      <div className={`composer${replyMsg ? ' has-reply' : ''}`}>
        {acList && (
          <div className="ac" role="listbox">
            <div className="ac-title">{acList.trigger === '@' ? 'Members' : `Emoji matching :${acList.query}`}</div>
            {acList.items.map((it, i) => (
              <button
                key={i}
                role="option"
                aria-selected={i === acList.index}
                className={`ac-item${i === acList.index ? ' is-active' : ''}`}
                onMouseEnter={() => setAc({ ...acList, index: i })}
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(it);
                }}
              >
                {it.kind === 'user' && (
                  <>
                    <Avatar user={it.user} size={24} />
                    <span className="ac-name">{it.name}</span>
                    <span className="ac-hint">{it.user.username}</span>
                  </>
                )}
                {it.kind === 'role' && (
                  <>
                    <span className="ac-at" style={{ color: it.color ?? undefined }}>
                      <At size={16} weight="bold" />
                    </span>
                    <span className="ac-name" style={{ color: it.color ?? undefined }}>
                      {it.name}
                    </span>
                    <span className="ac-hint">Notify everyone with this role</span>
                  </>
                )}
                {it.kind === 'everyone' && (
                  <>
                    <span className="ac-at">
                      <At size={16} weight="bold" />
                    </span>
                    <span className="ac-name">{it.value}</span>
                    <span className="ac-hint">{it.hint}</span>
                  </>
                )}
                {it.kind === 'emoji' &&
                  (it.result.kind === 'custom' ? (
                    <>
                      <img className="ac-emoji-img" src={fileUrl(it.result.emoji.url)} alt="" />
                      <span className="ac-name">:{it.result.emoji.name}:</span>
                      <span className="ac-hint">photo emoji</span>
                    </>
                  ) : (
                    <>
                      <span className="ac-emoji">
                        <Emoji char={it.result.entry.unicode} />
                      </span>
                      <span className="ac-name">:{it.result.entry.shortcodes[0]}:</span>
                    </>
                  ))}
              </button>
            ))}
          </div>
        )}

        {replyMsg && (
          <div className="composer-reply">
            <span className="truncate">
              Replying to <strong>{replyName}</strong>
            </span>
            {replyMsg.author.id !== meId && (
              <Tooltip label={replyPing ? `${replyName} will be pinged` : `${replyName} won't be pinged`}>
                <button className={`composer-reply-ping${replyPing ? ' is-on' : ''}`} onClick={() => setReplyPing(!replyPing)}>
                  <At size={14} weight="bold" />
                  {replyPing ? 'ON' : 'OFF'}
                </button>
              </Tooltip>
            )}
            <button className="composer-reply-close" aria-label="Cancel reply" onClick={() => ui.setReply(channelId, undefined)}>
              <XCircle size={18} weight="fill" />
            </button>
          </div>
        )}

        <div className="composer-box">
          {files.length > 0 && (
            <div className="composer-files scroll">
              {files.map((f) => {
                const Icon = f.file.type.startsWith('video/') ? FileVideo : f.file.type.startsWith('audio/') ? FileAudio : FileIcon;
                return (
                  <div key={f.key} className={`composer-file is-${f.status}`}>
                    <div className="composer-file-thumb">
                      {f.preview ? <img src={f.preview} alt="" /> : <Icon size={36} weight="duotone" />}
                      {f.status === 'uploading' && (
                        <svg className="composer-file-progress" viewBox="0 0 36 36">
                          <circle cx="18" cy="18" r="15" />
                          <circle cx="18" cy="18" r="15" style={{ strokeDashoffset: 94.25 * (1 - f.progress) }} />
                        </svg>
                      )}
                    </div>
                    <div className="composer-file-name truncate" title={f.file.name}>
                      {f.status === 'error' ? f.error : f.file.name}
                    </div>
                    <div className="composer-file-size">{formatBytes(f.file.size)}</div>
                    <button className="composer-file-remove" aria-label="Remove file" onClick={() => removeFile(f.key)}>
                      <X size={14} weight="bold" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          <div className="composer-row">
            <Tooltip label="Upload a file">
              <button
                className="composer-btn composer-attach"
                onClick={() => (useData.getState().myStorage?.linked ? fileInput.current?.click() : askToLinkStorage())}
                aria-label="Upload a file"
              >
                <PlusCircle size={24} weight="fill" />
              </button>
            </Tooltip>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files?.length) addFiles([...e.target.files]);
                e.target.value = '';
              }}
            />
            <textarea
              ref={ta}
              className="composer-input scroll"
              value={text}
              rows={1}
              placeholder={placeholder}
              spellCheck
              onChange={(e) => {
                const value = e.target.value;
                setText(value);
                setAc(computeAc(value, e.target.selectionStart ?? value.length));
                if (value.trim()) sendTyping(channelId);
              }}
              onSelect={(e) => {
                const el = e.currentTarget;
                if (ac) setAc(computeAc(el.value, el.selectionStart ?? el.value.length));
              }}
              onBlur={() => setTimeout(() => setAc(null), 120)}
              onKeyDown={onKeyDown}
              onPaste={(e) => {
                const pasted = [...e.clipboardData.files];
                if (pasted.length) {
                  e.preventDefault();
                  addFiles(pasted);
                }
              }}
            />
            <div className="composer-tools">
              <Tooltip label="GIFs">
                <button className={`composer-btn${pickerOpen === 'gifs' ? ' is-active' : ''}`} onClick={() => onPicker('gifs')} aria-label="GIFs">
                  <Gif size={26} weight="bold" />
                </button>
              </Tooltip>
              <Tooltip label="Stickers">
                <button className={`composer-btn${pickerOpen === 'stickers' ? ' is-active' : ''}`} onClick={() => onPicker('stickers')} aria-label="Stickers">
                  <Sticker size={23} />
                </button>
              </Tooltip>
              <Tooltip label="Emoji">
                <button className={`composer-btn composer-emoji${pickerOpen === 'emoji' ? ' is-active' : ''}`} onClick={() => onPicker('emoji')} aria-label="Emoji">
                  <Smiley size={24} />
                </button>
              </Tooltip>
              {(isMobileDevice || canSend) && (
                <button
                  className={`composer-send${canSend ? ' is-ready' : ''}`}
                  disabled={!canSend || sending}
                  onClick={() => void send()}
                  aria-label="Send"
                >
                  <PaperPlaneRight size={18} weight="fill" />
                </button>
              )}
            </div>
          </div>
        </div>
        {uploading && <div className="composer-uploading">Uploading… you can keep typing and hit send.</div>}
      </div>
    );
  },
);
