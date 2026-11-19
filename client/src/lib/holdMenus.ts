import { isIOS } from './platform';

/*
 * iPhones never send the "contextmenu" event on a long press, so the menus on servers, channels,
 * DMs, stickers and the mic/headphone buttons couldn't be opened there. Holding one of them still
 * for a moment now sends that event, the way Android and computers already do.
 * (Messages have their own hold handling in messageGestures.ts.)
 */

const HOLD_MS = 500;
/** How far a finger may drift and still count as holding still. */
const SLOP = 10;
const HOLDABLE = '.side-row, .side-category, .rail-btn, .sp-tile, .call-ctrl, .user-panel button';

export function setupHoldMenus() {
  if (!isIOS) return;
  let timer = 0;
  let start: { x: number; y: number; target: Element } | null = null;
  let fired = false;

  const cancel = () => {
    clearTimeout(timer);
    start = null;
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      fired = false;
      cancel();
      const target = (e.target as Element | null)?.closest?.(HOLDABLE);
      if (!target || e.touches.length !== 1) return;
      const t = e.touches[0];
      start = { x: t.clientX, y: t.clientY, target };
      timer = window.setTimeout(() => {
        if (!start) return;
        fired = true;
        navigator.vibrate?.(10);
        start.target.dispatchEvent(
          new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y }),
        );
        start = null;
      }, HOLD_MS);
    },
    { passive: true },
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!start) return;
      const t = e.touches[0];
      if (Math.abs(t.clientX - start.x) > SLOP || Math.abs(t.clientY - start.y) > SLOP) cancel();
    },
    { passive: true },
  );

  document.addEventListener(
    'touchend',
    (e) => {
      cancel();
      // The menu is open now: letting go mustn't also tap the row underneath it.
      if (fired) {
        fired = false;
        if (e.cancelable) e.preventDefault();
      }
    },
    { passive: false },
  );
  document.addEventListener('touchcancel', cancel, { passive: true });
}
