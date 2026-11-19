import { useEffect, useMemo, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  AndroidLogo,
  AppleLogo,
  ArrowBendUpLeft,
  ArrowSquareOut,
  CopySimple,
  DownloadSimple,
  Hash,
  MagnifyingGlass,
  LinkSimple,
  PencilSimple,
  PushPin,
  PushPinSlash,
  SpeakerHigh,
  Trash,
  WindowsLogo,
  X,
} from '@phosphor-icons/react';
import { loadPins, openDm, pinMessage, toggleReaction, unpinMessage, updateProfile, uploadEmoji } from '../../lib/actions';
import { PERM, can } from '../../lib/perms';
import { errorMessage } from '../../lib/api';
import { initials } from '../../lib/format';
import { isAndroid, isIOS } from '../../lib/platform';
import { downloadUrl, fileUrl } from '../../lib/server';
import { Emoji } from '../../lib/twemoji';
import { friendIds, sortedDmIds, useData, dmRecipient } from '../../store/data';
import { ui } from '../../store/ui';
import { Avatar, Button, ModalFrame, TextField } from '../ui';
import { confirmDelete, messageLink } from '../chat/MessageItem';
import { keepsAnimation, pickImage } from './ImageCrop';

/* ---------------- confirm ---------------- */

export function ConfirmModal({
  title,
  body,
  confirmLabel = 'Confirm',
  danger,
  requireText,
  onConfirm,
  onClose,
}: {
  title: string;
  body?: string;
  confirmLabel?: string;
  danger?: boolean;
  requireText?: string;
  onConfirm: () => Promise<unknown> | unknown;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [typed, setTyped] = useState('');
  const ok = !requireText || typed.trim() === requireText;
  const go = async () => {
    if (!ok) return;
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
      setBusy(false);
    }
  };
  return (
    <ModalFrame
      title={title}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} disabled={!ok} onClick={() => void go()} autoFocus={!requireText}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {body && <p className="confirm-body">{body}</p>}
      {requireText && (
        <TextField label={`Type "${requireText}" to confirm`} value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void go()} />
      )}
    </ModalFrame>
  );
}

/* ---------------- custom status ---------------- */

export function CustomStatusModal({ onClose }: { onClose: () => void }) {
  const me = useData((s) => s.me!);
  const [value, setValue] = useState(me.customStatus);
  const [busy, setBusy] = useState(false);
  const save = async (text: string) => {
    setBusy(true);
    try {
      await updateProfile({ customStatus: text.trim() });
      onClose();
    } catch (err) {
      ui.toast(errorMessage(err), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame
      title="Set a custom status"
      onClose={onClose}
      size="sm"
      footer={
        <>
          {me.customStatus && (
            <Button variant="danger-ghost" onClick={() => void save('')}>
              Clear status
            </Button>
          )}
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void save(value)}>
            Save
          </Button>
        </>
      }
    >
      <TextField
        label="What's happening?"
        value={value}
        maxLength={80}
        autoFocus
        placeholder="Eating ranch with everything"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void save(value)}
      />
    </ModalFrame>
  );
}

/* ---------------- new DM ---------------- */

export function NewDmModal({ onClose }: { onClose: () => void }) {
  const friends = useData(useShallow((s) => friendIds(s).map((id) => s.users[id]).filter(Boolean)));
  const [q, setQ] = useState('');
  const list = friends
    .filter((u) => !q || u.displayName.toLowerCase().includes(q.toLowerCase()) || u.username.includes(q.toLowerCase()))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  return (
    <ModalFrame title="Message a friend" onClose={onClose} size="sm">
      <div className="ep-search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a friend's name" autoFocus />
        <MagnifyingGlass size={16} className="ep-search-icon" />
      </div>
      <div className="invite-list scroll">
        {list.length === 0 && <div className="side-hint">{friends.length ? 'Nobody matches that.' : "You don't have any friends added yet."}</div>}
        {list.map((u) => (
          <button
            key={u.id}
            className="invite-row is-button"
            onClick={() => {
              onClose();
              void openDm(u.id).catch((err) => ui.toast(errorMessage(err), 'error'));
            }}
          >
            <Avatar user={u} size={32} />
            <span className="invite-row-name truncate">{u.displayName}</span>
            <span className="muted">{u.username}</span>
          </button>
        ))}
      </div>
    </ModalFrame>
  );
}

/* ---------------- quick switcher (Ctrl+K) ---------------- */

type SwitchItem =
  | { kind: 'dm'; id: string; label: string; sub: string; userId: string }
  | { kind: 'friend'; id: string; label: string; sub: string; userId: string }
  | { kind: 'channel'; id: string; label: string; sub: string; groupId: string; voice: boolean }
  | { kind: 'group'; id: string; label: string; sub: string; icon: string | null };

export function SwitcherModal({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const s = useData();
  const items = useMemo(() => {
    const out: SwitchItem[] = [];
    const dmUsers = new Set<string>();
    for (const id of sortedDmIds(s)) {
      const u = dmRecipient(s, id);
      if (!u) continue;
      dmUsers.add(u.id);
      out.push({ kind: 'dm', id, label: u.displayName, sub: u.username, userId: u.id });
    }
    for (const id of friendIds(s)) {
      const u = s.users[id];
      if (u && !dmUsers.has(id)) out.push({ kind: 'friend', id, label: u.displayName, sub: u.username, userId: id });
    }
    for (const gid of s.groupOrder) {
      const g = s.groups[gid];
      if (!g) continue;
      out.push({ kind: 'group', id: gid, label: g.name, sub: 'Group', icon: g.icon });
      for (const cid of g.channelIds) {
        const c = s.channels[cid];
        if (c) out.push({ kind: 'channel', id: cid, label: c.name ?? '', sub: g.name, groupId: gid, voice: c.type === 'voice' });
      }
    }
    const query = q.trim().toLowerCase().replace(/^[#@]/, '');
    if (!query) return out.slice(0, 12);
    return out
      .map((it) => {
        const l = it.label.toLowerCase();
        const score = l.startsWith(query) ? 3 : l.includes(query) ? 2 : it.sub.toLowerCase().includes(query) ? 1 : 0;
        return { it, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 12)
      .map((x) => x.it);
  }, [s, q]);

  useEffect(() => setIndex(0), [q]);

  const go = (it: SwitchItem) => {
    onClose();
    if (it.kind === 'dm') ui.navigate({ kind: 'dm', channelId: it.id });
    else if (it.kind === 'friend') void openDm(it.userId);
    else if (it.kind === 'group') {
      const g = useData.getState().groups[it.id];
      const first = g?.channelIds.find((id) => useData.getState().channels[id]?.type === 'text') ?? null;
      ui.navigate({ kind: 'group', groupId: it.id, channelId: first });
    } else ui.navigate({ kind: 'group', groupId: it.groupId, channelId: it.id });
  };

  return (
    <div className="switcher" onClick={(e) => e.stopPropagation()}>
      <input
        className="switcher-input"
        autoFocus
        value={q}
        placeholder="Where would you like to go?"
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setIndex((i) => Math.min(items.length - 1, i + 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setIndex((i) => Math.max(0, i - 1));
          } else if (e.key === 'Enter' && items[index]) {
            go(items[index]);
          } else if (e.key === 'Escape') onClose();
        }}
      />
      <div className="switcher-list scroll">
        {items.map((it, i) => (
          <button key={`${it.kind}${it.id}`} className={`switcher-item${i === index ? ' is-active' : ''}`} onMouseEnter={() => setIndex(i)} onClick={() => go(it)}>
            {it.kind === 'dm' || it.kind === 'friend' ? (
              <Avatar user={s.users[it.userId]} size={24} presence={s.presences[it.userId] ?? 'offline'} />
            ) : it.kind === 'group' ? (
              <span className="switcher-icon">{it.icon ? <img src={fileUrl(it.icon)} alt="" /> : initials(it.label)}</span>
            ) : it.voice ? (
              <SpeakerHigh size={20} />
            ) : (
              <Hash size={20} />
            )}
            <span className="switcher-label truncate">{it.label}</span>
            <span className="switcher-sub truncate">{it.sub}</span>
          </button>
        ))}
        {items.length === 0 && <div className="side-hint">Nothing matches "{q}"</div>}
      </div>
      <div className="switcher-hint">
        Tip: press <kbd className="ui-kbd">Ctrl</kbd> + <kbd className="ui-kbd">K</kbd> anywhere to open this.
      </div>
    </div>
  );
}

/* ---------------- full-screen viewer for pictures and GIFs ---------------- */

interface ViewerProps {
  src: string;
  filename?: string;
  /** 'video' for GIFs that come as a looping mp4. */
  kind?: 'image' | 'video';
  poster?: string | null;
  /** Where "Open original" leads, when that isn't `src`. */
  original?: string;
  /** False for media that isn't a file on this server, so there's nothing to download. */
  download?: boolean;
  onClose: () => void;
}

const MAX_ZOOM = 5;

interface Gesture {
  kind: 'pan' | 'pinch' | 'dismiss';
  x: number;
  y: number;
  viewX: number;
  viewY: number;
  scale: number;
  dist: number;
  moved: boolean;
  onMedia: boolean;
}

/**
 * Pinch, double-tap or scroll to zoom, drag to look around, swipe down (or tap outside) to close.
 * Tapping the picture shows or hides the buttons.
 */
export function LightboxModal({ src, filename, kind = 'image', poster, original, download = true, onClose }: ViewerProps) {
  const stage = useRef<HTMLDivElement>(null);
  const media = useRef<HTMLImageElement | HTMLVideoElement | null>(null);
  const view = useRef({ scale: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef({ t: 0, x: 0, y: 0 });
  const tapTimer = useRef(0);
  const [bar, setBar] = useState(true);

  const apply = (animate: boolean, fade = 1) => {
    const el = media.current;
    if (el) {
      const { scale, x, y } = view.current;
      el.style.transition = animate ? 'transform 220ms cubic-bezier(.22,.8,.24,1)' : 'none';
      el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;
    }
    stage.current?.style.setProperty('--lb-fade', String(fade));
  };

  // Keeps a zoomed picture from sliding off the screen.
  const clamp = () => {
    const el = media.current;
    const st = stage.current;
    if (!el || !st) return;
    const v = view.current;
    const maxX = Math.max(0, (el.offsetWidth * v.scale - st.clientWidth) / 2);
    const maxY = Math.max(0, (el.offsetHeight * v.scale - st.clientHeight) / 2);
    v.x = Math.max(-maxX, Math.min(maxX, v.x));
    v.y = Math.max(-maxY, Math.min(maxY, v.y));
  };

  /** Zooms to `scale` while the spot under (cx, cy) stays put. */
  const zoomAt = (scale: number, cx: number, cy: number, animate: boolean) => {
    const st = stage.current;
    if (!st) return;
    const r = st.getBoundingClientRect();
    const px = cx - (r.left + r.width / 2);
    const py = cy - (r.top + r.height / 2);
    const v = view.current;
    const next = Math.max(1, Math.min(MAX_ZOOM, scale));
    v.x = px - ((px - v.x) / v.scale) * next;
    v.y = py - ((py - v.y) / v.scale) * next;
    v.scale = next;
    if (next === 1) {
      v.x = 0;
      v.y = 0;
    }
    clamp();
    apply(animate);
  };

  useEffect(() => {
    const st = stage.current;
    if (!st) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(view.current.scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY, false);
    };
    const onResize = () => {
      clamp();
      apply(false);
    };
    st.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('resize', onResize);
    return () => {
      st.removeEventListener('wheel', onWheel);
      window.removeEventListener('resize', onResize);
      clearTimeout(tapTimer.current);
    };
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button > 0) return;
    stage.current?.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pts = [...pointers.current.values()];
    const v = view.current;
    const onMedia = Boolean(media.current?.contains(e.target as Node));
    if (pts.length === 2) {
      const [a, b] = pts;
      gesture.current = { kind: 'pinch', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, viewX: v.x, viewY: v.y, scale: v.scale, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, moved: true, onMedia };
    } else if (pts.length === 1) {
      gesture.current = { kind: 'pan', x: e.clientX, y: e.clientY, viewX: v.x, viewY: v.y, scale: v.scale, dist: 0, moved: false, onMedia };
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const g = gesture.current;
    if (!g) return;
    const v = view.current;
    const pts = [...pointers.current.values()];
    if (g.kind === 'pinch') {
      if (pts.length < 2) return;
      const [a, b] = pts;
      v.scale = g.scale;
      v.x = g.viewX;
      v.y = g.viewY;
      zoomAt(g.scale * (Math.hypot(a.x - b.x, a.y - b.y) / g.dist), g.x, g.y, false);
      v.x += (a.x + b.x) / 2 - g.x;
      v.y += (a.y + b.y) / 2 - g.y;
      clamp();
      apply(false);
      return;
    }
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 8) return;
    g.moved = true;
    if (v.scale > 1.01) {
      v.x = g.viewX + dx;
      v.y = g.viewY + dy;
      clamp();
      apply(false);
    } else if (e.pointerType !== 'mouse') {
      // Not zoomed in: drag it away to close, like a phone's photo app.
      g.kind = 'dismiss';
      v.x = 0;
      v.y = dy;
      apply(false, Math.max(0.15, 1 - Math.abs(dy) / 380));
    }
  };

  const endPointer = (e: React.PointerEvent, cancelled: boolean) => {
    if (!pointers.current.delete(e.pointerId)) return;
    const g = gesture.current;
    const v = view.current;
    const rest = [...pointers.current.values()];
    if (g?.kind === 'pinch') {
      if (rest.length === 1) {
        // One finger still down: carry on panning from where it is, without a jump.
        gesture.current = { kind: 'pan', x: rest[0].x, y: rest[0].y, viewX: v.x, viewY: v.y, scale: v.scale, dist: 0, moved: true, onMedia: true };
      } else if (rest.length === 0) {
        gesture.current = null;
        if (v.scale < 1.05) Object.assign(v, { scale: 1, x: 0, y: 0 });
        clamp();
        apply(true);
      }
      return;
    }
    gesture.current = null;
    if (!g || cancelled) {
      if (g?.kind === 'dismiss') {
        v.y = 0;
        apply(true);
      }
      return;
    }
    if (g.kind === 'dismiss') {
      if (Math.abs(v.y) > 110) return onClose();
      v.y = 0;
      apply(true);
      return;
    }
    if (g.moved) return;

    // A tap. Two quick taps zoom in or back out.
    const now = Date.now();
    const last = lastTap.current;
    if (now - last.t < 300 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
      clearTimeout(tapTimer.current);
      lastTap.current = { t: 0, x: 0, y: 0 };
      if (v.scale > 1.01) {
        Object.assign(v, { scale: 1, x: 0, y: 0 });
        apply(true);
      } else zoomAt(2.5, e.clientX, e.clientY, true);
      return;
    }
    lastTap.current = { t: now, x: e.clientX, y: e.clientY };
    const single = () => {
      if (!g.onMedia && view.current.scale <= 1.01) onClose();
      else if (g.onMedia) setBar((b) => !b);
    };
    // A mouse click outside the picture closes straight away; taps wait a moment for a second tap.
    if (e.pointerType === 'mouse' && !g.onMedia) single();
    else tapTimer.current = window.setTimeout(single, 260);
  };

  return (
    <div className="lightbox" role="dialog" aria-label={filename || 'Picture'}>
      <div
        ref={stage}
        className="lightbox-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endPointer(e, false)}
        onPointerCancel={(e) => endPointer(e, true)}
      >
        {kind === 'video' ? (
          <video
            ref={(el) => {
              media.current = el;
            }}
            src={src}
            poster={poster ?? undefined}
            autoPlay
            loop
            muted
            playsInline
            disablePictureInPicture
          />
        ) : (
          <img
            ref={(el) => {
              media.current = el;
            }}
            src={src}
            alt={filename ?? ''}
            draggable={false}
          />
        )}
      </div>
      <div className={`lightbox-bar${bar ? '' : ' is-hidden'}`}>
        <span className="truncate">{filename}</span>
        <a href={original ?? src} target="_blank" rel="noreferrer" className="lightbox-btn" aria-label="Open original">
          <ArrowSquareOut size={20} />
        </a>
        {download && (
          <a href={downloadUrl(src)} download={filename} className="lightbox-btn" aria-label="Download">
            <DownloadSimple size={20} />
          </a>
        )}
        <button className="lightbox-btn" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
      </div>
    </div>
  );
}

/* ---------------- photo emoji upload ---------------- */

export function EmojiUploadModal({ onClose }: { onClose: () => void }) {
  const [blob, setBlob] = useState<{ data: Blob; url: string; filename: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taken = useData((s) => Object.values(s.emojis).some((e) => e.name.toLowerCase() === name.toLowerCase()));

  const choose = async () => {
    const file = await pickImage();
    if (!file) return;
    if (!name) setName(file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32).toLowerCase() || 'emoji');
    const done = (data: Blob, filename: string) => setBlob({ data, filename, url: URL.createObjectURL(data) });
    if (keepsAnimation(file)) done(file, file.name);
    else ui.openModal('crop', { file, title: 'Crop your emoji', shape: 'square', outWidth: 160, onDone: done });
  };

  const valid = /^[a-zA-Z0-9_]{2,32}$/.test(name) && !taken;
  const submit = async () => {
    if (!blob || !valid) return;
    setBusy(true);
    setError(null);
    try {
      await uploadEmoji(name, blob.data, blob.filename);
      ui.toast(`:${name}: is ready to use everywhere`, 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="Add a photo emoji"
      subtitle="Turn any picture into an emoji everyone on this server can use. GIFs stay animated."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!blob || !valid} onClick={() => void submit()}>
            Add emoji
          </Button>
        </>
      }
    >
      <div className="emoji-upload">
        <button className="emoji-upload-drop" onClick={() => void choose()}>
          {blob ? <img src={blob.url} alt="" /> : <span>Choose image</span>}
        </button>
        <div className="emoji-upload-preview">
          <span className="ui-section-label">Preview</span>
          <div className="emoji-upload-sample">
            {blob ? (
              <>
                That's so me <img src={blob.url} alt="" className="emoji emoji-custom" />
              </>
            ) : (
              <span className="muted">Pick a photo to see it in chat</span>
            )}
          </div>
          {blob && (
            <button className="link-btn" onClick={() => void choose()}>
              <PencilSimple size={13} /> Pick a different image
            </button>
          )}
        </div>
      </div>
      <TextField
        label="Emoji name"
        value={name}
        prefix=":"
        suffix=":"
        maxLength={32}
        error={name && !/^[a-zA-Z0-9_]{2,32}$/.test(name) ? 'letters, numbers and _ only' : taken ? 'that name is taken' : null}
        onChange={(e) => setName(e.target.value.replace(/\s+/g, '_'))}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
      />
      {error && <div className="form-error">{error}</div>}
    </ModalFrame>
  );
}

/* ---------------- downloads ---------------- */

export function DownloadsModal({ onClose }: { onClose: () => void }) {
  const downloads = useData((s) => s.instance?.downloads ?? {});
  return (
    <ModalFrame title="Get the apps" subtitle="Same account, same chats, on every device." onClose={onClose} size="sm">
      <div className="downloads">
        <DownloadRow icon={<WindowsLogo size={28} weight="fill" />} title="Windows" href={downloads.windows} hint="Installer (.exe)" />
        <DownloadRow icon={<AndroidLogo size={28} weight="fill" />} title="Android" href={downloads.android} hint="App file (.apk). Allow installing from your browser when asked." />
        <DownloadRow icon={<AppleLogo size={28} weight="fill" />} title="iPhone" href={downloads.ios} hint={downloads.ios ? 'Sideload with AltStore or Sideloadly' : 'Open this page in Safari, tap Share, then Add to Home Screen'} />
      </div>
      {(isAndroid || isIOS) && (
        <p className="muted" style={{ fontSize: 13 }}>
          You can also install this page as an app: open the browser menu and choose {isIOS ? '"Add to Home Screen"' : '"Install app"'}.
        </p>
      )}
    </ModalFrame>
  );
}

function DownloadRow({ icon, title, href, hint }: { icon: React.ReactNode; title: string; href?: string; hint: string }) {
  return (
    <div className="download-row">
      <span className="download-icon">{icon}</span>
      <span className="download-text">
        <strong>{title}</strong>
        <span>{hint}</span>
      </span>
      {href ? (
        <a className="ui-btn ui-btn-primary ui-btn-sm" href={fileUrl(href)} download>
          <span className="ui-btn-content">
            <DownloadSimple size={16} weight="bold" /> Download
          </span>
        </a>
      ) : (
        <span className="muted" style={{ fontSize: 13 }}>
          {title === 'iPhone' ? '' : 'Not uploaded yet'}
        </span>
      )}
    </div>
  );
}

/* ---------------- mobile long-press actions ---------------- */

export function MessageActionsModal({ channelId, messageId, canEdit, canDelete, onClose }: { channelId: string; messageId: string; canEdit: boolean; canDelete: boolean; onClose: () => void }) {
  const message = useData((s) => s.messages[channelId]?.list.find((m) => m.id === messageId));
  const canPin = useData((s) => {
    const gid = s.channels[channelId]?.groupId;
    return !gid || can(s, gid, PERM.MANAGE_MESSAGES);
  }) && message?.type === 'default';
  const recent = ui.getRecentReactions().slice(0, 6);
  const ref = useRef(false);
  if (!message) return null;
  const close = () => {
    if (ref.current) return;
    ref.current = true;
    onClose();
  };
  return (
    <ModalFrame onClose={close} size="sm" className="msg-sheet" hideClose>
      <div className="msg-sheet-reactions">
        {recent.map((e) => (
          <button
            key={e}
            onClick={() => {
              void toggleReaction(channelId, messageId, e);
              close();
            }}
          >
            {e.startsWith('c:') ? <img src={fileUrl(useData.getState().emojis[e.slice(2)]?.url)} alt="" /> : <Emoji char={e} />}
          </button>
        ))}
      </div>
      <div className="msg-sheet-actions">
        <button
          onClick={() => {
            ui.setReply(channelId, messageId);
            close();
          }}
        >
          <ArrowBendUpLeft size={20} /> Reply
        </button>
        {canEdit && (
          <button
            onClick={() => {
              ui.setEditing(messageId);
              close();
            }}
          >
            <PencilSimple size={20} /> Edit message
          </button>
        )}
        {canPin && (
          <button
            onClick={() => {
              const act = message.pinnedAt ? unpinMessage(channelId, messageId) : pinMessage(channelId, messageId);
              void act.then(() => ui.toast(message.pinnedAt ? 'Unpinned' : 'Pinned', 'success')).catch((err) => ui.toast(errorMessage(err), 'error'));
              close();
            }}
          >
            {message.pinnedAt ? <PushPinSlash size={20} /> : <PushPin size={20} />} {message.pinnedAt ? 'Unpin message' : 'Pin message'}
          </button>
        )}
        <button
          onClick={() => {
            void navigator.clipboard.writeText(messageLink(message));
            ui.toast('Link copied', 'success');
            close();
          }}
        >
          <LinkSimple size={20} /> Copy message link
        </button>
        {message.content && (
          <button
            onClick={() => {
              void navigator.clipboard.writeText(message.content);
              ui.toast('Copied', 'success');
              close();
            }}
          >
            <CopySimple size={20} /> Copy text
          </button>
        )}
        {canDelete && (
          <button
            className="is-danger"
            onClick={() => {
              close();
              confirmDelete(message);
            }}
          >
            <Trash size={20} /> Delete message
          </button>
        )}
      </div>
    </ModalFrame>
  );
}
