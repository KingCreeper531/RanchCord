import { useSyncExternalStore } from 'react';
import { isIOS, isMobileDevice, isNative } from './platform';

/**
 * Phones always get the phone layout, even held sideways. A sideways phone is wider than 760px,
 * which used to flip it into the desktop layout: tiny panels, hover-only buttons, and taps that
 * seemed to do nothing. The CSS side of this is `html.is-phone` (see vite.config.ts).
 */
export const isPhone = isMobileDevice && Math.min(screen.width, screen.height) <= 540;

const narrow = matchMedia('(max-width: 760px)');
let mobileLayout = isPhone || narrow.matches;
const listeners = new Set<() => void>();

narrow.addEventListener('change', () => {
  const next = isPhone || narrow.matches;
  if (next === mobileLayout) return;
  mobileLayout = next;
  for (const l of listeners) l();
});

/** True while the app uses the one-panel-at-a-time phone layout. */
export function isMobileLayout(): boolean {
  return mobileLayout;
}

export function useIsMobileLayout(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => mobileLayout,
  );
}

const typing = () => {
  const el = document.activeElement;
  return el instanceof HTMLElement && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** Puts the page back at the top if the keyboard (or a stray scroll) left it shifted. */
export function settleViewport() {
  if (typing()) return;
  if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
}

/**
 * Keeps the page pinned in place. Phones scroll the whole page to make room for the keyboard and
 * sometimes leave it shifted after the keyboard closes, so everything looks moved and taps land
 * in the wrong spot. Snap it back whenever the keyboard closes or the screen turns.
 */
export function setupViewport() {
  const root = document.documentElement;
  root.classList.toggle('is-phone', isPhone);
  root.classList.toggle('is-ios', isIOS);

  document.addEventListener('focusout', () => setTimeout(settleViewport, 120));
  window.visualViewport?.addEventListener('resize', () => setTimeout(settleViewport, 60));
  window.addEventListener('orientationchange', () => setTimeout(settleViewport, 350));
  window.addEventListener('scroll', settleViewport, { passive: true });

  // Panels that hide their overflow can still be scrolled by focusing something inside them,
  // which shifts the whole layout sideways with no way to scroll it back. Put them straight back.
  // (Whether an element hides its overflow is remembered, so normal scrolling stays cheap.)
  const hidesOverflow = new WeakMap<Element, boolean>();
  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target;
      if (!(el instanceof HTMLElement) || (!el.scrollLeft && !el.scrollTop)) return;
      let hidden = hidesOverflow.get(el);
      if (hidden === undefined) {
        const style = getComputedStyle(el);
        hidden = /^(hidden|clip)$/.test(style.overflowX) && /^(hidden|clip)$/.test(style.overflowY);
        hidesOverflow.set(el, hidden);
      }
      if (hidden) {
        el.scrollLeft = 0;
        el.scrollTop = 0;
      }
    },
    true,
  );

  // Safari ignores maximum-scale, so a stray pinch zooms the whole app. (The photo viewer zooms on its own.)
  if (isIOS && !isNative) document.addEventListener('gesturestart', (e) => e.preventDefault());
}
