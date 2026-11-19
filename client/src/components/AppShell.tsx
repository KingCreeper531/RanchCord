import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useData } from '../store/data';
import { ui, useUi } from '../store/ui';
import { hasCustomTitleBar } from '../lib/platform';
import { useBrand } from '../lib/brand';
import { isMessageSwipe } from '../lib/messageGestures';
import { useIsMobileLayout } from '../lib/viewport';
import { ChatView } from './chat/ChatView';
import { VoiceChannelView } from './calls/VoiceChannelView';
import { FriendsView } from './FriendsView';
import { MemberList } from './MemberList';
import { Rail } from './Rail';
import { Sidebar } from './Sidebar';
import { Wallpaper, useHasWallpaper } from './Wallpaper';

function TitleBar() {
  const connection = useUi((s) => s.connection);
  const brand = useBrand();
  return (
    <div className="titlebar">
      <img src={brand.logo} alt="" />
      {brand.name}
      {connection === 'offline' && <span className="titlebar-status">Reconnecting…</span>}
    </div>
  );
}

/** Picks what goes in the main area for the current route (and fixes up stale routes). */
function MainContent({ mobile }: { mobile: boolean }) {
  const route = useUi((s) => s.route);
  const membersOpen = useUi((s) => s.prefs.membersOpen);
  const groupExists = useData((s) => (route.kind === 'group' ? Boolean(s.groups[route.groupId]) : true));
  const channel = useData((s) => (route.kind === 'group' && route.channelId ? s.channels[route.channelId] : route.kind === 'dm' ? s.channels[route.channelId] : undefined));
  const ready = useData((s) => s.ready);

  useEffect(() => {
    if (!ready) return;
    if (route.kind === 'group') {
      if (!groupExists) {
        ui.navigate({ kind: 'friends' }, { replace: true, openMain: false });
        return;
      }
      if (!route.channelId || !channel) {
        const s = useData.getState();
        const g = s.groups[route.groupId];
        const last = useUi.getState().prefs.lastChannelByGroup[route.groupId];
        const pick = (last && s.channels[last] && s.channels[last].type === 'text' ? last : null) ?? g.channelIds.find((id) => s.channels[id]?.type === 'text') ?? null;
        if (pick) ui.navigate({ kind: 'group', groupId: route.groupId, channelId: pick }, { replace: true, openMain: false });
      }
    } else if (route.kind === 'dm' && !channel) {
      ui.navigate({ kind: 'friends' }, { replace: true, openMain: false });
    }
  }, [ready, route, groupExists, channel]);

  if (route.kind === 'friends') return <FriendsView />;
  if (route.kind === 'dm') return channel ? <ChatView channelId={route.channelId} /> : null;
  if (!channel) return null;
  if (channel.type === 'voice') return <VoiceChannelView channelId={channel.id} />;
  return (
    <div className="main-split">
      <ChatView channelId={channel.id} />
      {!mobile && membersOpen && <MemberList groupId={route.groupId} />}
    </div>
  );
}

/* ---------------- mobile: swipeable panels ---------------- */

function MobileShell() {
  const pane = useUi((s) => s.mobilePane);
  const route = useUi((s) => s.route);
  const mainRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; y: number; t: number; locked: 'x' | 'y' | null } | null>(null);
  // Measured, so turning the phone (or the notch padding) never leaves the panels misplaced.
  const [width, setWidth] = useState(() => window.innerWidth);
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || window.innerWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const navOffset = width - 56;
  const sideWidth = Math.min(width * 0.86, 340);
  const hasSide = route.kind === 'group';
  const base = pane === 'nav' ? navOffset : pane === 'side' ? -sideWidth : 0;
  const x = drag ?? base;

  const onTouchStart = (e: React.TouchEvent) => {
    // A swipe whose finger-up got lost (the touched element vanished mid-swipe) must not leave the panels stuck halfway.
    if (drag !== null) setDrag(null);
    const t = e.touches[0];
    start.current = { x: t.clientX, y: t.clientY, t: Date.now(), locked: null };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = start.current;
    if (!s) return;
    const t = e.touches[0];
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.locked) {
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      s.locked = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y';
      // Sliding a message to reply, or swiping inside pickers and sliders, isn't a panel swipe.
      if (s.locked === 'x' && (isMessageSwipe() || (e.target as HTMLElement).closest('.no-swipe, .kp, .ep, input[type=range], .stage'))) s.locked = 'y';
    }
    if (s.locked !== 'x') return;
    let next = base + dx;
    next = Math.max(hasSide ? -sideWidth : 0, Math.min(navOffset, next));
    setDrag(next);
  };
  const onTouchEnd = () => {
    const s = start.current;
    start.current = null;
    if (drag === null || !s) return;
    const dx = drag - base;
    const fast = Date.now() - s.t < 250 && Math.abs(dx) > 30;
    let target = pane;
    if (pane === 'main') {
      if (dx > navOffset / 3 || (fast && dx > 0)) target = 'nav';
      else if (hasSide && (dx < -sideWidth / 3 || (fast && dx < 0))) target = 'side';
    } else if (pane === 'nav') {
      if (dx < -navOffset / 3 || (fast && dx < 0)) target = 'main';
    } else if (pane === 'side') {
      if (dx > sideWidth / 3 || (fast && dx > 0)) target = 'main';
    }
    setDrag(null);
    ui.setMobilePane(target);
  };

  return (
    <div ref={bodyRef} className="app-body" onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
      <div className="m-nav" style={{ visibility: x > 0 ? 'visible' : 'hidden' }}>
        <Rail />
        <Sidebar />
      </div>
      {hasSide && route.kind === 'group' && (
        <div className="m-side" style={{ visibility: x < 0 ? 'visible' : 'hidden' }}>
          <MemberList groupId={route.groupId} />
        </div>
      )}
      <div
        ref={mainRef}
        className="m-main"
        style={{ transform: `translate3d(${x}px,0,0)`, transition: drag === null ? 'transform 280ms cubic-bezier(.22,.8,.24,1)' : 'none' }}
      >
        <Wallpaper />
        <main className="main">
          <MainContent mobile />
        </main>
        {pane !== 'main' && drag === null && <div className="m-main-veil" onClick={() => ui.setMobilePane('main')} />}
      </div>
    </div>
  );
}

export function AppShell() {
  const mobile = useIsMobileLayout();
  const wallpaper = useHasWallpaper();
  return (
    <div className={`app${mobile ? ' app-mobile' : ''}${wallpaper ? ' has-wallpaper' : ''}`}>
      <Wallpaper />
      {hasCustomTitleBar && !mobile && <TitleBar />}
      {mobile ? (
        <MobileShell />
      ) : (
        <div className="app-body">
          <Rail />
          <Sidebar />
          <main className="main">
            <MainContent mobile={false} />
          </main>
        </div>
      )}
    </div>
  );
}
