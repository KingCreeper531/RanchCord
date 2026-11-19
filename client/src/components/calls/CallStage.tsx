import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowsIn,
  ArrowsOut,
  CornersOut,
  Headphones,
  Microphone,
  MicrophoneSlash,
  Monitor,
  MonitorArrowUp,
  MusicNotes,
  PhoneDisconnect,
  PhoneCall,
  SpeakerHigh,
  VideoCamera,
  VideoCameraSlash,
  WifiSlash,
} from '@phosphor-icons/react';
import { useShallow } from 'zustand/react/shallow';
import { call } from '../../calls/manager';
import { canShareScreen } from '../../lib/platform';
import { EmojiText } from '../../lib/twemoji';
import { type MediaHandle, useCall } from '../../store/call';
import { displayNameIn, dmRecipient, useData } from '../../store/data';
import { ui, useUi } from '../../store/ui';
import { Avatar, Spinner, Tooltip, openMenu } from '../ui';
import { DeafIcon, MobileMenuButtonInline } from './bits';

interface TileSpec {
  key: string;
  userId: string;
  kind: 'camera' | 'screen';
  handle: MediaHandle | null;
  showVideo: boolean;
  self: boolean;
}

function VideoView({ handle, mirror, contain }: { handle: MediaHandle; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    handle.attach(el);
    return () => handle.detach(el);
  }, [handle]);
  return <video ref={ref} className={`tile-video${mirror ? ' is-mirrored' : ''}${contain ? ' is-contain' : ''}`} autoPlay playsInline muted />;
}

const Tile = memo(function Tile({ spec, groupId, focused, small }: { spec: TileSpec; groupId: string | null; focused: boolean; small?: boolean }) {
  const user = useData((s) => s.users[spec.userId]);
  const name = useData((s) => displayNameIn(s, spec.userId, groupId));
  const speaking = useCall((s) => Boolean(s.speaking[spec.userId]) && spec.kind === 'camera');
  const flags = useCall(
    useShallow((s) => {
      if (spec.self) return { muted: s.muted || s.deafened, deafened: s.deafened, connection: 'connected' as const };
      const p = s.participants[spec.userId];
      return { muted: Boolean(p?.muted), deafened: Boolean(p?.deafened), connection: p?.connection ?? 'connecting' };
    }),
  );
  const fx = useCall((s) => s.soundFx[spec.userId]);
  const volume = useUi((s) => s.prefs.call.userVolumes[spec.userId] ?? 1);
  const ref = useRef<HTMLDivElement>(null);

  const toggleFocus = () => call.setFocus(focused ? null : { userId: spec.userId, kind: spec.kind });
  const fullscreen = () => {
    const el = ref.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div
      ref={ref}
      className={`tile${speaking ? ' is-speaking' : ''}${spec.kind === 'screen' ? ' is-screen' : ''}${focused ? ' is-focused' : ''}${small ? ' is-small' : ''}`}
      style={{ '--tile-tint': user?.bannerColor ?? '#2b302b' } as React.CSSProperties}
      onClick={toggleFocus}
      onDoubleClick={fullscreen}
      onContextMenu={(e) => {
        if (spec.self) return;
        e.preventDefault();
        openMenu(e, [
          { header: `${name}'s volume` },
          ...[1, 0.75, 0.5, 0.25, 0].map((v) => ({
            label: v === 0 ? 'Muted (just for you)' : `${Math.round(v * 100)}%`,
            checked: Math.abs(volume - v) < 0.01,
            onSelect: () => {
              ui.setCallPrefs({ userVolumes: { ...useUi.getState().prefs.call.userVolumes, [spec.userId]: v } });
              call.refreshVolumes();
            },
          })),
          { separator: true },
          { label: 'Profile', onSelect: () => ref.current && ui.showProfile(spec.userId, ref.current, groupId) },
        ]);
      }}
    >
      {spec.showVideo && spec.handle ? (
        <VideoView handle={spec.handle} mirror={spec.self && spec.kind === 'camera'} contain={spec.kind === 'screen'} />
      ) : spec.kind === 'screen' ? (
        <div className="tile-waiting">
          <Spinner size={22} />
          <span>Loading {name}'s screen…</span>
        </div>
      ) : (
        <div className="tile-avatar">
          <Avatar user={user} size={small ? 48 : 84} />
        </div>
      )}
      {flags.connection !== 'connected' && !spec.self && spec.kind === 'camera' && (
        <div className="tile-connecting">{flags.connection === 'failed' ? <WifiSlash size={16} weight="bold" /> : <Spinner size={14} />}</div>
      )}
      {spec.kind === 'screen' && <span className="live-badge tile-live">LIVE</span>}
      {fx && spec.kind === 'camera' && (
        <div className="tile-fx" key={fx.at}>
          <EmojiText text={fx.emoji} />
          <span className="truncate">{fx.name}</span>
        </div>
      )}
      <div className="tile-label">
        {spec.kind === 'camera' && flags.deafened ? (
          <DeafIcon size={14} />
        ) : (
          spec.kind === 'camera' && flags.muted && <MicrophoneSlash size={14} weight="fill" className="tile-muted" />
        )}
        {spec.kind === 'screen' && <Monitor size={14} weight="fill" />}
        <span className="truncate">{spec.self && spec.kind === 'camera' ? `${name} (you)` : name}</span>
        {!spec.self && volume < 1 && spec.kind === 'camera' && <SpeakerHigh size={13} className="tile-vol" />}
      </div>
      {!small && (
        <div className="tile-tools" onClick={(e) => e.stopPropagation()}>
          <Tooltip label={focused ? 'Show everyone' : 'Focus'}>
            <button onClick={toggleFocus} aria-label="Focus">
              {focused ? <ArrowsIn size={16} weight="bold" /> : <ArrowsOut size={16} weight="bold" />}
            </button>
          </Tooltip>
          <Tooltip label="Full screen">
            <button onClick={fullscreen} aria-label="Full screen">
              <CornersOut size={16} weight="bold" />
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
});

function useGrid(ref: React.RefObject<HTMLDivElement | null>, count: number) {
  const [size, setSize] = useState({ w: 0, cols: 1 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const compute = () => {
      const W = el.clientWidth;
      const H = el.clientHeight;
      const gap = 8;
      let best = { w: 0, cols: 1 };
      for (let cols = 1; cols <= Math.max(1, count); cols++) {
        const rows = Math.ceil(count / cols);
        const wByW = (W - gap * (cols - 1)) / cols;
        const wByH = ((H - gap * (rows - 1)) / rows) * (16 / 9);
        const w = Math.floor(Math.min(wByW, wByH));
        if (w > best.w) best = { w, cols };
      }
      setSize(best);
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, count]);
  return size;
}

function Controls({ channelId }: { channelId: string }) {
  const muted = useCall((s) => s.muted);
  const deafened = useCall((s) => s.deafened);
  const camera = useCall((s) => s.camera);
  const screen = useCall((s) => s.screen);
  return (
    <div className="call-controls">
      <CtrlButton label={camera ? 'Turn off camera' : 'Turn on camera'} on={camera} onClick={() => void call.toggleCamera()}>
        {camera ? <VideoCamera size={22} weight="fill" /> : <VideoCameraSlash size={22} weight="fill" />}
      </CtrlButton>
      {canShareScreen && (
        <CtrlButton label={screen ? 'Stop sharing' : 'Share your screen'} on={screen} onClick={() => call.toggleScreen()}>
          {screen ? <Monitor size={22} weight="fill" /> : <MonitorArrowUp size={22} weight="fill" />}
        </CtrlButton>
      )}
      <CtrlButton label="Soundboard" onClick={() => ui.openModal('soundboard', { channelId })}>
        <MusicNotes size={22} weight="fill" />
      </CtrlButton>
      <span className="call-controls-sep" />
      <CtrlButton label={muted ? 'Unmute' : 'Mute'} off={muted || deafened} onClick={() => call.toggleMute()}>
        {muted || deafened ? <MicrophoneSlash size={22} weight="fill" /> : <Microphone size={22} weight="fill" />}
      </CtrlButton>
      <CtrlButton label={deafened ? 'Undeafen' : 'Deafen'} off={deafened} onClick={() => call.toggleDeafen()}>
        {deafened ? <DeafIcon size={22} /> : <Headphones size={22} weight="fill" />}
      </CtrlButton>
      <Tooltip label="Disconnect">
        <button className="call-ctrl call-leave" onClick={() => call.leave()} aria-label="Disconnect">
          <PhoneDisconnect size={24} weight="fill" />
        </button>
      </Tooltip>
    </div>
  );
}

function CtrlButton({ label, on, off, onClick, children }: { label: string; on?: boolean; off?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip label={label}>
      <button className={`call-ctrl${on ? ' is-on' : ''}${off ? ' is-off' : ''}`} onClick={onClick} aria-label={label} aria-pressed={on || off}>
        {children}
      </button>
    </Tooltip>
  );
}

export function CallStage({ channelId, variant }: { channelId: string; variant: 'dm' | 'channel' }) {
  const meId = useData((s) => s.me!.id);
  const groupId = useData((s) => s.channels[channelId]?.groupId ?? null);
  const status = useCall((s) => s.status);
  const camera = useCall((s) => s.camera);
  const localCamera = useCall((s) => s.localCamera);
  const screen = useCall((s) => s.screen);
  const localScreen = useCall((s) => s.localScreen);
  const participants = useCall((s) => s.participants);
  const focus = useCall((s) => s.focus);
  const ringTimedOut = useCall((s) => s.ringTimedOut);
  const declined = useCall((s) => s.declined);
  const recipient = useData((s) => (variant === 'dm' ? dmRecipient(s, channelId) : undefined));
  const [expanded, setExpanded] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);

  const tiles = useMemo(() => {
    const list: TileSpec[] = [
      { key: `${meId}:camera`, userId: meId, kind: 'camera', handle: localCamera, showVideo: camera, self: true },
    ];
    if (screen) list.push({ key: `${meId}:screen`, userId: meId, kind: 'screen', handle: localScreen, showVideo: true, self: true });
    for (const p of Object.values(participants).sort((a, b) => a.joinedAt - b.joinedAt)) {
      list.push({ key: `${p.userId}:camera`, userId: p.userId, kind: 'camera', handle: p.camera, showVideo: p.video && Boolean(p.camera), self: false });
      if (p.screen) list.push({ key: `${p.userId}:screen`, userId: p.userId, kind: 'screen', handle: p.screenShare, showVideo: Boolean(p.screenShare), self: false });
    }
    return list;
  }, [meId, localCamera, camera, screen, localScreen, participants]);

  const focused = focus ? tiles.find((t) => t.userId === focus.userId && t.kind === focus.kind) : undefined;
  const others = focused ? tiles.filter((t) => t !== focused) : tiles;
  const grid = useGrid(gridRef, focused ? 1 : tiles.length);
  const alone = Object.keys(participants).length === 0;

  let notice: React.ReactNode = null;
  if (variant === 'dm' && alone && status === 'connected') {
    notice = declined ? (
      <>{recipient?.displayName} declined. <button onClick={() => call.ringAgain()}>Ring again</button></>
    ) : ringTimedOut ? (
      <>No answer. <button onClick={() => call.ringAgain()}>Ring again</button></>
    ) : (
      <>
        <PhoneCall size={16} weight="fill" /> Calling {recipient?.displayName}…
      </>
    );
  } else if (variant === 'channel' && alone && status === 'connected') {
    notice = <>You're the only one here. Invite a friend to hang out!</>;
  }

  return (
    <div className={`stage stage-${variant}${expanded ? ' is-expanded' : ''}`}>
      {variant === 'channel' && <MobileMenuButtonInline />}
      {status !== 'connected' && (
        <div className="stage-status">
          <Spinner size={14} /> {status === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}
        </div>
      )}
      <div className={`stage-body${focused ? ' is-spotlight' : ''}`}>
        {focused ? (
          <>
            <div className="stage-spot">
              <Tile spec={focused} groupId={groupId} focused />
            </div>
            {others.length > 0 && (
              <div className="stage-strip scroll-hidden">
                {others.map((t) => (
                  <Tile key={t.key} spec={t} groupId={groupId} focused={false} small />
                ))}
              </div>
            )}
          </>
        ) : (
          <div ref={gridRef} className="stage-grid">
            <div className="stage-grid-inner" style={{ gridTemplateColumns: `repeat(${grid.cols}, ${grid.w}px)` }}>
              {tiles.map((t) => (
                <Tile key={t.key} spec={t} groupId={groupId} focused={false} />
              ))}
            </div>
          </div>
        )}
      </div>
      {notice && <div className="stage-notice">{notice}</div>}
      <Controls channelId={channelId} />
      {variant === 'dm' && (
        <Tooltip label={expanded ? 'Shrink' : 'Expand'}>
          <button className="stage-expand" onClick={() => setExpanded(!expanded)} aria-label={expanded ? 'Shrink' : 'Expand'}>
            {expanded ? <ArrowsIn size={18} weight="bold" /> : <ArrowsOut size={18} weight="bold" />}
          </button>
        </Tooltip>
      )}
    </div>
  );
}
