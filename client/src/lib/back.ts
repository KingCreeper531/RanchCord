import { useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Keyboard } from '@capacitor/keyboard';
import { nextStamp, setHistoryWriter, ui, useUi } from '../store/ui';
import { isNative } from './platform';
import { isMobileLayout } from './viewport';

/*
 * "Back" closes whatever is on top: a menu, picker or sheet, then dialogs, then editing or
 * replying, and on phones it then slides back to the chat list. It's wired to Android's back
 * button, the browser's back button and swipe (web app, iPhone Safari), and mouse back buttons.
 */

interface Layer {
  stamp: number;
  close: () => void;
}

const layers: Layer[] = [];

/** Lets Back close something. Call the returned function once it has closed. */
export function addBackLayer(close: () => void): () => void {
  const layer: Layer = { stamp: nextStamp(), close };
  layers.push(layer);
  scheduleGuard();
  return () => {
    const i = layers.indexOf(layer);
    if (i === -1) return;
    layers.splice(i, 1);
    scheduleGuard();
  };
}

/** Lets Back close this while `open` is true. */
export function useBackLayer(open: boolean, close: () => void) {
  const latest = useRef(close);
  latest.current = close;
  useEffect(() => (open ? addBackLayer(() => latest.current()) : undefined), [open]);
}

function currentChannelId(): string | null {
  const r = useUi.getState().route;
  return r.kind === 'dm' ? r.channelId : r.kind === 'group' ? r.channelId : null;
}

/** What Back would close right now, or null when nothing is open. */
function topCloser(): (() => void) | null {
  const s = useUi.getState();
  const open: Layer[] = [];
  const layer = layers.at(-1);
  if (layer) open.push(layer);
  const modal = s.modals.at(-1);
  if (modal) open.push({ stamp: modal.id, close: () => ui.closeModal(modal.id) });
  if (s.popover) open.push({ stamp: s.popover.stamp, close: () => ui.closePopover() });
  if (open.length) return open.reduce((a, b) => (b.stamp > a.stamp ? b : a)).close;
  if (s.editing) return () => ui.setEditing(null);
  const channelId = currentChannelId();
  if (channelId && s.replyTo[channelId]) return () => ui.setReply(channelId, undefined);
  if (isMobileLayout() && s.mobilePane !== 'nav') {
    const pane = s.mobilePane === 'side' ? 'main' : 'nav';
    return () => ui.setMobilePane(pane);
  }
  return null;
}

/** Closes whatever is on top. Returns false when there was nothing left to close. */
export function goBack(): boolean {
  const close = topCloser();
  if (!close) return false;
  close();
  return true;
}

/*
 * Browser back: while something can be closed, one extra history entry sits on top, so going
 * back closes that thing instead of leaving the page or changing the chat behind a dialog.
 */
let guarded = false;
let ownBacks = 0;
let scheduled = false;

function scheduleGuard() {
  if (isNative || scheduled) return;
  scheduled = true;
  setTimeout(() => {
    scheduled = false;
    syncGuard();
  }, 0);
}

function syncGuard() {
  if (ownBacks > 0) return; // wait for our own history.back() to land
  const want = topCloser() !== null;
  try {
    if (want && !guarded) {
      history.pushState({ rcBack: true }, '', location.href);
      guarded = true;
    } else if (!want && guarded) {
      guarded = false;
      ownBacks++;
      history.back();
    }
  } catch {
    // Safari limits how often history can change; Back just leaves the page in that rare case.
  }
}

export function setupBack() {
  if (isNative) {
    window.addEventListener('popstate', () => ui.syncFromHash());
    void CapApp.addListener('backButton', () => {
      // With the keyboard up, Back only puts the keyboard away.
      if (document.documentElement.classList.contains('keyboard-open')) {
        void Keyboard.hide().catch(() => {});
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        return;
      }
      if (!goBack()) void CapApp.minimizeApp();
    });
    return;
  }

  // A reload can leave us on an extra entry from before; make it an ordinary page again.
  if ((history.state as { rcBack?: boolean } | null)?.rcBack) history.replaceState(null, '', location.href);

  // Opening another chat while the extra entry is on top turns that entry into the new page.
  setHistoryWriter((hash, replace) => {
    if (guarded) {
      guarded = false;
      history.replaceState(null, '', hash);
    } else if (replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
  });

  window.addEventListener('popstate', (e) => {
    if (ownBacks > 0) {
      ownBacks--;
      scheduleGuard();
      return;
    }
    if (guarded) {
      guarded = false;
      goBack();
      scheduleGuard();
      return;
    }
    if ((e.state as { rcBack?: boolean } | null)?.rcBack) {
      // Went forward onto an old extra entry: tidy it up.
      guarded = true;
      scheduleGuard();
      return;
    }
    ui.syncFromHash();
  });

  useUi.subscribe(scheduleGuard);
  scheduleGuard();
}
