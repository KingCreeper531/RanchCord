import { App as CapApp } from '@capacitor/app';
import { Keyboard } from '@capacitor/keyboard';
import { StatusBar, Style } from '@capacitor/status-bar';
import '../calls/manager';
import { data, useData } from '../store/data';
import { applyFontSize, applyTheme, resolvedTheme, ui, useUi } from '../store/ui';
import { ackChannel } from './actions';
import { isMobileDevice, isNative } from './platform';
import { emit } from './socket';
import { unlockAudio } from './sound';

/** One-time setup: theme, focus tracking, idle detection, phone back button, keyboard. */
export function initPlatform() {
  applyTheme();
  applyFontSize();

  // Hash routing (back/forward buttons, notification links).
  window.addEventListener('popstate', () => ui.syncFromHash());
  window.addEventListener('hashchange', () => ui.syncFromHash());

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

  // Android back button: close things first, then go back to the menu, then leave the app.
  void CapApp.addListener('backButton', () => {
    const u = useUi.getState();
    if (u.popover) return ui.closePopover();
    if (u.modals.length) return ui.closeModal();
    if (u.editing) return ui.setEditing(null);
    if (u.mobilePane !== 'nav') return ui.setMobilePane('nav');
    void CapApp.minimizeApp();
  });

  void CapApp.addListener('appStateChange', ({ isActive }) => {
    useUi.setState({ visible: isActive, focused: isActive });
    emit('presence:afk', !isActive);
  });

  void Keyboard.addListener('keyboardWillShow', () => document.documentElement.classList.add('keyboard-open')).catch(() => {});
  void Keyboard.addListener('keyboardWillHide', () => document.documentElement.classList.remove('keyboard-open')).catch(() => {});
}
