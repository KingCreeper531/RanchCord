import { App as CapApp } from '@capacitor/app';
import { Keyboard } from '@capacitor/keyboard';
import { StatusBar, Style } from '@capacitor/status-bar';
import '../calls/manager';
import { data, useData } from '../store/data';
import { applyFontSize, applyTheme, resolvedTheme, ui, useUi } from '../store/ui';
import { ackChannel, refreshBootstrap } from './actions';
import { setupBack } from './back';
import { setupHoldMenus } from './holdMenus';
import { isMobileDevice, isNative } from './platform';
import { emit } from './socket';
import { unlockAudio } from './sound';
import { settleViewport, setupViewport } from './viewport';

/** When the app comes back after this long in the background, reload everything so nothing is stale. */
const RESYNC_AFTER_MS = 30_000;

/** One-time setup: theme, focus tracking, idle detection, phone back button, keyboard. */
export function initPlatform() {
  applyTheme();
  applyFontSize();
  setupViewport();
  setupHoldMenus();

  // Hash routing (notification links). Back/forward and the phone back button live in back.ts.
  setupBack();
  window.addEventListener('hashchange', () => ui.syncFromHash());

  // Phones pause the app in the background and can miss live updates (new emojis, sounds,
  // favorites, messages) while asleep. Catch up as soon as it's opened again.
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenAt = Date.now();
    else if (hiddenAt && Date.now() - hiddenAt > RESYNC_AFTER_MS && useData.getState().me) void refreshBootstrap();
  });

  // Focus & visibility: drives read receipts, notifications and auto-idle.
  let idleTimer: number | undefined;
  let afk = false;
  const setAfk = (value: boolean) => {
    if (afk === value) return;
    afk = value;
    emit('presence:afk', value);
  };
  const markActive = () => {
    setAfk(false);
    clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => setAfk(true), 10 * 60 * 1000);
  };
  const update = () => {
    const visible = document.visibilityState === 'visible';
    const focused = document.hasFocus();
    useUi.setState({ visible, focused });
    if (!visible) setAfk(true);
    else markActive();
    if (visible && (focused || isMobileDevice)) {
      const r = useUi.getState().route;
      const id = r.kind === 'dm' ? r.channelId : r.kind === 'group' ? r.channelId : null;
      const s = useData.getState();
      if (id && s.channels[id]?.lastMessageId) ackChannel(id);
    }
  };
  document.addEventListener('visibilitychange', update);
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  for (const ev of ['pointerdown', 'keydown']) {
    window.addEventListener(
      ev,
      () => {
        unlockAudio();
        markActive();
      },
      { passive: true },
    );
  }
  markActive();

  // Typing indicators expire after a few seconds.
  setInterval(() => data.pruneTyping(), 1500);

  if (isNative) setupNative();
}

function setupNative() {
  document.documentElement.classList.add('is-native');
  void StatusBar.setStyle({ style: resolvedTheme() === 'light' ? Style.Light : Style.Dark }).catch(() => {});
  useUi.subscribe((s, prev) => {
    if (s.prefs.theme !== prev.prefs.theme) void StatusBar.setStyle({ style: resolvedTheme() === 'light' ? Style.Light : Style.Dark }).catch(() => {});
  });

  let pausedAt = 0;
  void CapApp.addListener('appStateChange', ({ isActive }) => {
    useUi.setState({ visible: isActive, focused: isActive });
    emit('presence:afk', !isActive);
    if (!isActive) pausedAt = Date.now();
    else if (pausedAt && Date.now() - pausedAt > RESYNC_AFTER_MS && useData.getState().me) void refreshBootstrap();
  });

  void Keyboard.addListener('keyboardWillShow', () => document.documentElement.classList.add('keyboard-open')).catch(() => {});
  void Keyboard.addListener('keyboardWillHide', () => document.documentElement.classList.remove('keyboard-open')).catch(() => {});
  // The web view can stay scrolled up after the keyboard leaves, shifting everything off its taps.
  void Keyboard.addListener('keyboardDidHide', () => setTimeout(settleViewport, 50)).catch(() => {});
}
