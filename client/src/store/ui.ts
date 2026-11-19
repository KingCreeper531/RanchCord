import { create } from 'zustand';

export type Route =
  | { kind: 'friends' }
  | { kind: 'dm'; channelId: string }
  | { kind: 'group'; groupId: string; channelId: string | null };

export type ThemePref = 'dark' | 'light' | 'system' | 'glass';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

export interface ModalEntry {
  id: number;
  type: string;
  props: Record<string, unknown>;
}

export interface CallPrefs {
  inputId: string;
  outputId: string;
  cameraId: string;
  noiseSuppression: boolean;
  echoCancellation: boolean;
  userVolumes: Record<string, number>;
}

export interface Prefs {
  theme: ThemePref;
  fontSize: number;
  notifications: boolean;
  sounds: boolean;
  membersOpen: boolean;
  lastChannelByGroup: Record<string, string>;
  call: CallPrefs;
  recentEmojis: string[];
  skinTone: number;
  soundboardVolume: number;
  /** How much the personal background is darkened (0-0.9) and blurred (px). */
  wallpaperDim: number;
  wallpaperBlur: number;
}

export interface UiState {
  route: Route;
  modals: ModalEntry[];
  mobilePane: 'nav' | 'main' | 'side';
  toasts: Toast[];
  popover: { kind: 'profile'; userId: string; groupId?: string | null; rect: DOMRect; stamp: number } | null;
  replyTo: Record<string, string | undefined>;
  editing: string | null;
  friendsTab: 'online' | 'all' | 'pending' | 'blocked' | 'add';
  focused: boolean;
  visible: boolean;
  prefs: Prefs;
  connection: 'connecting' | 'online' | 'offline';
  jumpTo: { channelId: string; messageId: string; n: number } | null;
  composerInsert: { channelId: string; text: string; n: number } | null;
}

const PREFS_KEY = 'rc.prefs';

const defaultPrefs: Prefs = {
  theme: 'dark',
  fontSize: 15,
  notifications: true,
  sounds: true,
  membersOpen: true,
  lastChannelByGroup: {},
  call: { inputId: '', outputId: '', cameraId: '', noiseSuppression: true, echoCancellation: true, userVolumes: {} },
  recentEmojis: ['👍', '😂', '❤️', '🔥', '😭', '💀', '🙏', '👀'],
  skinTone: 0,
  soundboardVolume: 0.7,
  wallpaperDim: 0.55,
  wallpaperBlur: 0,
};

function loadPrefs(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<Prefs>;
    const theme = (localStorage.getItem('rc.theme') as ThemePref | null) ?? saved.theme ?? defaultPrefs.theme;
    return { ...defaultPrefs, ...saved, theme, call: { ...defaultPrefs.call, ...saved.call } };
  } catch {
    return defaultPrefs;
  }
}

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'channels') {
    if (parts[1] === '@me') return parts[2] ? { kind: 'dm', channelId: parts[2] } : { kind: 'friends' };
    if (parts[1]) return { kind: 'group', groupId: parts[1], channelId: parts[2] ?? null };
  }
  return { kind: 'friends' };
}

/** The message a shared message link points at (#/channels/<group or @me>/<channel>/<message>). */
export function messageInHash(hash: string): { channelId: string; messageId: string } | null {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  return parts[0] === 'channels' && parts[2] && parts[3] ? { channelId: parts[2], messageId: parts[3] } : null;
}

export function routeToHash(r: Route): string {
  if (r.kind === 'dm') return `#/channels/@me/${r.channelId}`;
  if (r.kind === 'group') return `#/channels/${r.groupId}${r.channelId ? `/${r.channelId}` : ''}`;
  return '#/channels/@me';
}

const initialPrefs = loadPrefs();

export const useUi = create<UiState>(() => ({
  route: parseHash(location.hash),
  modals: [],
  mobilePane: 'nav',
  toasts: [],
  popover: null,
  replyTo: {},
  editing: null,
  friendsTab: 'online',
  focused: document.hasFocus(),
  visible: document.visibilityState === 'visible',
  prefs: initialPrefs,
  connection: 'connecting',
  jumpTo: null,
  composerInsert: null,
}));

const set = useUi.setState;
const get = useUi.getState;

let stampSeq = 0;
let toastSeq = 0;

/** A number that only goes up. Things that open get one, so Back can close the newest first. */
export function nextStamp() {
  return ++stampSeq;
}

type HistoryWriter = (hash: string, replace: boolean) => void;
let writeHistory: HistoryWriter = (hash, replace) => (replace ? history.replaceState(null, '', hash) : history.pushState(null, '', hash));

/** lib/back.ts plugs in here, so changing pages can reuse the extra history entry it keeps for Back. */
export function setHistoryWriter(writer: HistoryWriter) {
  writeHistory = writer;
}

/** Shallow comparison of two dialogs' props. */
function sameProps(a: Record<string, unknown>, b: Record<string, unknown>) {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => Object.is(a[k], b[k]));
}

export const ui = {
  navigate(route: Route, opts: { replace?: boolean; openMain?: boolean } = {}) {
    const hash = routeToHash(route);
    if (location.hash !== hash) writeHistory(hash, Boolean(opts.replace));
    set({ route, popover: null, mobilePane: opts.openMain === false ? get().mobilePane : 'main' });
    if (route.kind === 'group' && route.channelId) {
      ui.setPrefs({ lastChannelByGroup: { ...get().prefs.lastChannelByGroup, [route.groupId]: route.channelId } });
    }
  },

  syncFromHash() {
    set({ route: parseHash(location.hash) });
    const target = messageInHash(location.hash);
    if (target) ui.jumpToMessage(target.channelId, target.messageId);
  },

  openModal(type: string, props: Record<string, unknown> = {}) {
    // The same dialog twice in a row (a long press that fires twice, a double tap) only opens once.
    const top = useUi.getState().modals.at(-1);
    if (top && top.type === type && sameProps(top.props, props)) return top.id;
    const id = nextStamp();
    set((s) => ({ modals: [...s.modals, { id, type, props }], popover: null }));
    return id;
  },

  closeModal(id?: number) {
    set((s) => ({ modals: id === undefined ? s.modals.slice(0, -1) : s.modals.filter((m) => m.id !== id) }));
  },

  closeAllModals() {
    set({ modals: [] });
  },

  toast(text: string, tone: Toast['tone'] = 'info') {
    const id = ++toastSeq;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), tone === 'error' ? 5200 : 3200);
  },

  showProfile(userId: string, el: Element, groupId?: string | null) {
    set({ popover: { kind: 'profile', userId, groupId, rect: el.getBoundingClientRect(), stamp: nextStamp() } });
  },

  closePopover() {
    if (get().popover) set({ popover: null });
  },

  setReply(channelId: string, messageId: string | undefined) {
    set((s) => ({ replyTo: { ...s.replyTo, [channelId]: messageId }, editing: null }));
  },

  setEditing(messageId: string | null) {
    set({ editing: messageId });
  },

  setMobilePane(pane: UiState['mobilePane']) {
    set({ mobilePane: pane });
  },

  setPrefs(patch: Partial<Prefs>) {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    if (patch.theme) {
      localStorage.setItem('rc.theme', patch.theme);
      applyTheme();
    }
    if (patch.fontSize) applyFontSize();
  },

  setCallPrefs(patch: Partial<CallPrefs>) {
    ui.setPrefs({ call: { ...get().prefs.call, ...patch } });
  },

  getRecentReactions(): string[] {
    return get().prefs.recentEmojis;
  },

  jumpToMessage(channelId: string, messageId: string) {
    set({ jumpTo: { channelId, messageId, n: Date.now() } });
  },

  insertIntoComposer(channelId: string, text: string) {
    set({ composerInsert: { channelId, text, n: Date.now() } });
  },

  pushRecentEmoji(key: string) {
    const recent = [key, ...get().prefs.recentEmojis.filter((e) => e !== key)].slice(0, 32);
    ui.setPrefs({ recentEmojis: recent });
  },
};

export function resolvedTheme(): 'dark' | 'light' | 'glass' {
  const t = get().prefs.theme;
  if (t === 'system') return matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  return t;
}

export function applyTheme() {
  const theme = resolvedTheme();
  document.documentElement.setAttribute('data-theme', theme);
  const bar = theme === 'light' ? '#e5e2cf' : theme === 'glass' ? '#0b0f18' : '#0f110f';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bar);
  window.ranchDesktop?.setTitleBarColors(bar, theme === 'light' ? '#1f231b' : '#ecefe7');
}

export function applyFontSize() {
  document.documentElement.style.setProperty('--chat-font', `${get().prefs.fontSize}px`);
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (get().prefs.theme === 'system') applyTheme();
});
