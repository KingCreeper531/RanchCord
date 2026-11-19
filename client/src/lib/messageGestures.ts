import { ui } from '../store/ui';
import { isIOS } from './platform';

/*
 * Touch gestures on chat messages:
 * - swipe a message to the right to reply to it (like other chat apps);
 * - on iPhones, hold a message to open its menu. iPhones never send the long-press event that
 *   Android and computers use, so without this the menu was unreachable there.
 */

let swiping = false;

/** True while a finger is sliding a message to reply, so the swipe between panels stays out of it. */
export function isMessageSwipe() {
  return swiping;
}

/** Touches starting this close to the left edge still open the chat list instead. */
const EDGE = 28;
/** How far the message has to slide before letting go replies. */
const TRIGGER = 56;
const MAX_SLIDE = 80;
const HOLD_MS = 450;
const REPLY_ICON =
  '<svg viewBox="0 0 256 256" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M232,200a8,8,0,0,1-16,0,88.1,88.1,0,0,0-88-88H51.31l34.35,34.34a8,8,0,0,1-11.32,11.32l-48-48a8,8,0,0,1,0-11.32l48-48A8,8,0,0,1,85.66,61.66L51.31,96H128A104.11,104.11,0,0,1,232,200Z"/></svg>';

interface Options {
  channelId: string;
  /** Opens a message's menu after a long hold (iPhones only, see above). */
  onHold: (messageId: string) => void;
}

export function attachMessageGestures(scroller: HTMLElement, { channelId, onHold }: Options): () => void {
  let start: { x: number; y: number; row: HTMLElement; id: string } | null = null;
  let mode: 'pending' | 'swipe' | 'none' = 'none';
  let held = false;
  let timer = 0;
  let icon: HTMLElement | null = null;
  let offset = 0;
  let buzzed = false;

  const slide = (row: HTMLElement, x: number) => {
    offset = x;
    row.style.transform = x ? `translateX(${x}px)` : '';
    if (icon) {
      const p = Math.min(1, x / TRIGGER);
      icon.style.opacity = String(p);
      icon.style.transform = `translateX(${-x}px) scale(${0.6 + 0.4 * p})`;
      icon.classList.toggle('is-ready', x >= TRIGGER);
    }
    if (x >= TRIGGER && !buzzed) {
      buzzed = true;
      navigator.vibrate?.(10);
    } else if (x < TRIGGER) buzzed = false;
  };

  const settle = (row: HTMLElement) => {
    const ic = icon;
    icon = null;
    offset = 0;
    buzzed = false;
    row.style.transition = 'transform 200ms cubic-bezier(.22,.8,.24,1)';
    row.style.transform = '';
    if (ic) {
      ic.style.transition = 'opacity 160ms, transform 200ms cubic-bezier(.22,.8,.24,1)';
      ic.style.opacity = '0';
      ic.style.transform = 'translateX(0) scale(.6)';
    }
    window.setTimeout(() => {
      row.style.transition = '';
      row.classList.remove('is-swiping');
      ic?.remove();
    }, 220);
  };

  const reply = (messageId: string) => {
    ui.setReply(channelId, messageId);
    // Open the keyboard straight away. iPhones only allow that while the finger is still on the screen.
    document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
  };

  const onStart = (e: TouchEvent) => {
    clearTimeout(timer);
    start = null;
    mode = 'none';
    held = false;
    swiping = false;
    if (e.touches.length !== 1) return;
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>('.msg[data-mid]');
    if (!row || row.matches('.msg-system, .is-pending, .is-failed, .is-editing')) return;
    if (target.closest('input, textarea, video, audio, [contenteditable="true"]')) return;
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, row, id: row.dataset.mid! };
    mode = 'pending';
    if (isIOS && !target.closest('a')) {
      timer = window.setTimeout(() => {
        if (mode !== 'pending' || !start) return;
        mode = 'none';
        held = true;
        onHold(start.id);
      }, HOLD_MS);
    }
  };

  const onMove = (e: TouchEvent) => {
    if (!start || mode === 'none') return;
    const t = e.touches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (mode === 'pending') {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      clearTimeout(timer);
      // Measured from the app's fixed frame, not the chat panel, which may still be sliding into place.
      const frame = scroller.closest('.app-body') ?? document.body;
      const fromEdge = start.x - frame.getBoundingClientRect().left < EDGE;
      if (dx <= 0 || Math.abs(dx) < Math.abs(dy) * 1.3 || fromEdge) {
        mode = 'none';
        return;
      }
      mode = 'swipe';
      swiping = true;
      start.row.classList.add('is-swiping');
      icon = document.createElement('span');
      icon.className = 'msg-swipe-icon';
      icon.innerHTML = REPLY_ICON;
      start.row.appendChild(icon);
    }
    if (e.cancelable) e.preventDefault(); // keep the list still while the message slides
    slide(start.row, Math.max(0, Math.min(MAX_SLIDE, dx * 0.55)));
  };

  const onEnd = (e: TouchEvent) => {
    clearTimeout(timer);
    if (held && e.cancelable) e.preventDefault(); // the menu opened: lifting the finger shouldn't also tap
    held = false;
    if (mode === 'swipe' && start) {
      const ready = offset >= TRIGGER;
      const id = start.id;
      settle(start.row);
      if (e.cancelable) e.preventDefault();
      if (ready) reply(id);
    }
    start = null;
    mode = 'none';
    swiping = false;
  };

  const onCancel = () => {
    clearTimeout(timer);
    if (mode === 'swipe' && start) settle(start.row);
    start = null;
    mode = 'none';
    held = false;
    swiping = false;
  };

  scroller.addEventListener('touchstart', onStart, { passive: true });
  scroller.addEventListener('touchmove', onMove, { passive: false });
  scroller.addEventListener('touchend', onEnd);
  scroller.addEventListener('touchcancel', onCancel);
  return () => {
    onCancel();
    scroller.removeEventListener('touchstart', onStart);
    scroller.removeEventListener('touchmove', onMove);
    scroller.removeEventListener('touchend', onEnd);
    scroller.removeEventListener('touchcancel', onCancel);
  };
}
