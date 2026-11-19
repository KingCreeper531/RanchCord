import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowLeft,
  Bell,
  Camera,
  CopySimple,
  Crown,
  DesktopTower,
  Gift,
  Image as ImageIcon,
  MusicNotes,
  Palette,
  PencilSimple,
  SignOut,
  Smiley,
  SpeakerHigh,
  Trash,
  User,
  X,
  Sparkle,
  ShieldStar,
  Cloud,
} from '@phosphor-icons/react';
import { call } from '../../calls/manager';
import { listDevices } from '../../calls/media';
import {
  changePassword,
  deleteEmoji,
  deleteSound,
  logout,
  removeAvatar,
  removeBanner,
  renameEmoji,
  resetFriendCode,
  updateProfile,
  uploadAvatar,
  uploadBanner,
} from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { formatFriendCode, formatShortDate } from '../../lib/format';
import { disableWebPush, enableWebPush, notificationPermission, requestNotifications } from '../../lib/notify';
import { desktop, isDesktopApp, isMobileDevice, isNative } from '../../lib/platform';
import { clearServerBase, fileUrl, serverBase } from '../../lib/server';
import { EmojiText } from '../../lib/twemoji';
import { useBrand } from '../../lib/brand';
import { useCall } from '../../store/call';
import { useData } from '../../store/data';
import { type ThemePref, ui, useUi } from '../../store/ui';
import { Avatar, Button, Slider, Switch, TextField } from '../ui';
import { keepsAnimation, pickImage } from '../modals/ImageCrop';
import { BackgroundPicker } from './BackgroundPicker';
import { Row, Section } from './parts';
import { ServerAdminTab } from './ServerAdmin';
import { MyStorageTab } from './MyStorage';

type Tab = 'account' | 'profile' | 'storage' | 'perks' | 'appearance' | 'voice' | 'notifications' | 'emojis' | 'sounds' | 'server' | 'app';

const NAV: { group: string; items: { id: Tab; label: string; icon: React.ReactNode; admin?: boolean }[] }[] = [
  {
    group: 'User settings',
    items: [
      { id: 'account', label: 'My Account', icon: <User size={18} /> },
      { id: 'profile', label: 'Profile', icon: <PencilSimple size={18} /> },
      { id: 'storage', label: 'My Storage', icon: <Cloud size={18} /> },
      { id: 'perks', label: 'Nitro Perks (free)', icon: <Gift size={18} /> },
    ],
  },
  {
    group: 'App settings',
    items: [
      { id: 'appearance', label: 'Appearance', icon: <Palette size={18} /> },
      { id: 'voice', label: 'Voice & Video', icon: <SpeakerHigh size={18} /> },
      { id: 'notifications', label: 'Notifications', icon: <Bell size={18} /> },
    ],
  },
  {
    group: 'Server',
    items: [
      { id: 'emojis', label: 'Photo Emojis', icon: <Smiley size={18} /> },
      { id: 'sounds', label: 'Soundboard', icon: <MusicNotes size={18} /> },
      { id: 'server', label: 'Server Admin', icon: <ShieldStar size={18} />, admin: true },
      { id: 'app', label: 'App & Connection', icon: <DesktopTower size={18} /> },
    ],
  },
];

export function SettingsModal({ tab: initial, onClose }: { tab?: Tab; onClose: () => void }) {
  const [tab, setTab] = useState<Tab | null>(isMobileDevice && !initial ? null : initial ?? 'account');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.ui-modal-layer + .ui-modal-layer')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const isAdmin = useData((s) => Boolean(s.me?.isAdmin));
  const nav = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.admin || isAdmin) }));
  const current = nav.flatMap((g) => g.items).find((i) => i.id === tab);
  return (
    <div className={`settings${tab ? ' has-tab' : ''}`} onClick={(e) => e.stopPropagation()}>
      <nav className="settings-nav scroll">
        <div className="settings-nav-inner">
          {nav.map((g) => (
            <div key={g.group} className="settings-nav-group">
              <div className="settings-nav-title">{g.group}</div>
              {g.items.map((i) => (
                <button key={i.id} className={`settings-nav-item${tab === i.id ? ' is-active' : ''}`} onClick={() => setTab(i.id)}>
                  {i.icon}
                  {i.label}
                </button>
              ))}
            </div>
          ))}
          <div className="settings-nav-group">
            <button
              className="settings-nav-item is-danger"
              onClick={() =>
                ui.openModal('confirm', {
                  title: 'Log out?',
                  body: 'You can log back in any time.',
                  confirmLabel: 'Log out',
                  danger: true,
                  onConfirm: () => logout(),
                })
              }
            >
              <SignOut size={18} /> Log out
            </button>
          </div>
        </div>
      </nav>
      <main className="settings-main scroll">
        <div className="settings-content">
          {isMobileDevice && (
            <button className="settings-back" onClick={() => setTab(null)}>
              <ArrowLeft size={18} weight="bold" /> Settings
            </button>
          )}
          {current && <h1 className="settings-h1">{current.label}</h1>}
          {tab === 'account' && <AccountTab />}
          {tab === 'profile' && <ProfileTab />}
          {tab === 'storage' && <MyStorageTab />}
          {tab === 'perks' && <PerksTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'voice' && <VoiceTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'emojis' && <EmojisTab />}
          {tab === 'sounds' && <SoundsTab />}
          {tab === 'server' && <ServerAdminTab />}
          {tab === 'app' && <AppTab />}
        </div>
      </main>
      <button className="settings-close" onClick={onClose} aria-label="Close settings">
        <X size={20} weight="bold" />
        <span>ESC</span>
      </button>
    </div>
  );
}


/* ---------------- account ---------------- */

function AccountTab() {
  const me = useData((s) => s.me!);
  const [username, setUsername] = useState(me.username);
  const [displayName, setDisplayName] = useState(me.displayName);
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwBusy, setPwBusy] = useState(false);
  const dirty = username !== me.username || displayName !== me.displayName;

  return (
    <>
      <div className="account-card">
        <div className="account-banner" style={{ background: me.banner ? `center/cover url(${fileUrl(me.banner)})` : me.bannerColor }} />
        <div className="account-head">
          <Avatar user={me} size={80} />
          <div>
            <h2>{me.displayName}</h2>
            <span className="muted">{me.username}</span>
          </div>
          {me.isAdmin && (
            <span className="account-admin">
              <Crown size={14} weight="fill" /> Server admin
            </span>
          )}
        </div>
        <div className="account-fields">
          <TextField label="Display name" value={displayName} maxLength={32} onChange={(e) => setDisplayName(e.target.value)} />
          <TextField label="Username" value={username} maxLength={32} onChange={(e) => setUsername(e.target.value.toLowerCase())} hint="Lowercase letters, numbers, _ and ." />
          <div>
            <Button
              disabled={!dirty}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await updateProfile({ username, displayName });
                  ui.toast('Saved', 'success');
                } catch (err) {
                  ui.toast(errorMessage(err), 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save changes
            </Button>
          </div>
        </div>
      </div>

      <Section title="Friend code" hint="Friends can add you with this code or your username.">
        <div className="friend-code-card">
          <div className="friend-code">{formatFriendCode(me.friendCode)}</div>
          <div className="ui-row">
            <Button
              variant="secondary"
              icon={<CopySimple size={16} weight="bold" />}
              onClick={() => {
                void navigator.clipboard.writeText(formatFriendCode(me.friendCode));
                ui.toast('Copied', 'success');
              }}
            >
              Copy
            </Button>
            <Button
              variant="ghost"
              onClick={() =>
                ui.openModal('confirm', {
                  title: 'Get a new friend code?',
                  body: "Your old code will stop working. Friends you've already added stay your friends.",
                  confirmLabel: 'New code',
                  onConfirm: () => resetFriendCode(),
                })
              }
            >
              New code
            </Button>
          </div>
        </div>
      </Section>

      <Section title="Password">
        <div className="settings-grid">
          <TextField label="Current password" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <TextField label="New password" type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
        </div>
        <div>
          <Button
            variant="secondary"
            loading={pwBusy}
            disabled={!pw.current || pw.next.length < 6}
            onClick={async () => {
              setPwBusy(true);
              try {
                await changePassword(pw.current, pw.next);
                setPw({ current: '', next: '' });
                ui.toast('Password changed. Other devices were logged out.', 'success');
              } catch (err) {
                ui.toast(errorMessage(err), 'error');
              } finally {
                setPwBusy(false);
              }
            }}
          >
            Change password
          </Button>
        </div>
      </Section>
      <p className="muted settings-foot">Member since {formatShortDate(me.createdAt)}</p>
    </>
  );
}

/* ---------------- profile ---------------- */

const COLORS = ['#5cc443', '#39b5e0', '#2c6fcb', '#f2b84b', '#e5534b', '#c178e6', '#f08a5d', '#3fbfa5', '#f4edc9', '#2b302b'];

function ProfileTab() {
  const me = useData((s) => s.me!);
  const [bio, setBio] = useState(me.bio);
  const [busy, setBusy] = useState(false);

  const changeImage = async (kind: 'avatar' | 'banner') => {
    const file = await pickImage();
    if (!file) return;
    const upload = async (blob: Blob, filename: string) => {
      try {
        if (kind === 'avatar') await uploadAvatar(blob, filename);
        else await uploadBanner(blob, filename);
      } catch (err) {
        ui.toast(errorMessage(err), 'error');
        throw err;
      }
    };
    if (keepsAnimation(file)) await upload(file, file.name);
    else
      ui.openModal('crop', {
        file,
        title: kind === 'avatar' ? 'Edit avatar' : 'Edit banner',
        shape: kind === 'avatar' ? 'circle' : 'rounded',
        aspect: kind === 'avatar' ? 1 : 3,
        outWidth: kind === 'avatar' ? 512 : 1200,
        onDone: upload,
      });
  };

  return (
    <div className="profile-editor">
      <div className="profile-editor-form">
        <Section title="Avatar" hint="PNG, JPG, WebP, or an animated GIF.">
          <div className="ui-row">
            <Button icon={<Camera size={16} weight="fill" />} onClick={() => void changeImage('avatar')}>
              Change avatar
            </Button>
            {me.avatar && (
              <Button variant="ghost" onClick={() => void removeAvatar()}>
                Remove
              </Button>
            )}
          </div>
        </Section>
        <Section title="Profile banner" hint="A big picture across the top of your profile. GIFs work.">
          <div className="ui-row">
            <Button variant="secondary" icon={<ImageIcon size={16} weight="fill" />} onClick={() => void changeImage('banner')}>
              {me.banner ? 'Change banner' : 'Upload banner'}
            </Button>
            {me.banner && (
              <Button variant="ghost" onClick={() => void removeBanner()}>
                Remove
              </Button>
            )}
          </div>
        </Section>
        <Section title="Profile theme" hint="Pick two colors to give your profile a gradient.">
          <div className="theme-pickers">
            <ColorPick label="Primary" value={me.bannerColor} onChange={(c) => void updateProfile({ bannerColor: c })} />
            <ColorPick label="Accent" value={me.accentColor || ''} onChange={(c) => void updateProfile({ accentColor: c })} onClear={me.accentColor ? () => void updateProfile({ accentColor: null as unknown as string }) : undefined} />
          </div>
        </Section>
        <Section title="About me" hint="You can use markdown and emoji.">
          <textarea className="ui-textarea" maxLength={400} value={bio} placeholder="Tell your friends something about you" onChange={(e) => setBio(e.target.value)} />
          <div className="ui-row">
            <span className="muted">{400 - bio.length} left</span>
            <span style={{ flex: 1 }} />
            <Button
              disabled={bio === me.bio}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await updateProfile({ bio });
                  ui.toast('Saved', 'success');
                } catch (err) {
                  ui.toast(errorMessage(err), 'error');
                } finally {
                  setBusy(false);
                }
              }}
            >
              Save
            </Button>
          </div>
        </Section>
        <Section title="Custom status">
          <Button variant="secondary" onClick={() => ui.openModal('customStatus')}>
            {me.customStatus ? `“${me.customStatus}”` : 'Set a custom status'}
          </Button>
        </Section>
      </div>
      <div className="profile-editor-preview">
        <span className="ui-section-label">Preview</span>
        <div className={`profile${me.accentColor ? ' has-theme' : ''}`} style={me.accentColor ? { background: `linear-gradient(180deg, ${me.bannerColor}, ${me.accentColor})` } : undefined}>
          <div className="profile-banner" style={{ background: me.banner ? undefined : me.bannerColor }}>
            {me.banner && <img src={fileUrl(me.banner)} alt="" />}
          </div>
          <div className="profile-avatar">
            <Avatar user={me} size={84} presence="online" />
          </div>
          <div className="profile-body">
            <div className="profile-names">
              <h3>{me.displayName}</h3>
              <span className="profile-username">{me.username}</span>
            </div>
            {me.customStatus && <div className="profile-status">{me.customStatus}</div>}
            {bio && (
              <div className="profile-section">
                <span className="ui-section-label">About me</span>
                <div className="profile-bio" style={{ whiteSpace: 'pre-wrap' }}>
                  {bio}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ColorPick({ label, value, onChange, onClear }: { label: string; value: string; onChange: (c: string) => void; onClear?: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="color-pick">
      <span className="ui-field-label">{label}</span>
      <div className="color-swatches">
        {COLORS.map((c) => (
          <button key={c} className={`swatch${value.toLowerCase() === c ? ' is-active' : ''}`} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />
        ))}
        <button className="swatch swatch-custom" onClick={() => input.current?.click()} aria-label="Custom color" style={{ background: value || undefined }}>
          <PencilSimple size={12} weight="bold" />
        </button>
        <input ref={input} type="color" hidden value={value || '#5cc443'} onChange={(e) => onChange(e.target.value)} />
        {onClear && (
          <button className="link-btn" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/* ---------------- perks ---------------- */

function PerksTab() {
  const perks = [
    ['Animated avatars, banners & group icons', 'Upload a GIF and it stays animated.'],
    ['Profile banners & themes', 'Big banner image plus a two-color gradient profile.'],
    ['Photo emojis anywhere', 'Every custom emoji works in every DM and group, animated too.'],
    ['Stickers & GIFs anywhere', 'Full KLIPY GIF and sticker search everywhere.'],
    ['HD screen share', '720p, 1080p or Source quality at up to 60 FPS, with sound.'],
    ['Big uploads', 'Files up to 50 MB each, kept in your own free storage (the server owner can change the limit).'],
    ['Long messages', 'Up to 8,000 characters per message.'],
    ['Custom soundboard', 'Upload your own sounds and play them in any call.'],
    ['Unlimited groups & calls', 'No member caps, no call size caps.'],
  ];
  return (
    <>
      <div className="perks-hero">
        <Sparkle size={28} weight="fill" />
        <div>
          <h2>Everything is unlocked</h2>
          <p>Here every perk is free for everyone. No subscription, no boosts, no catch.</p>
        </div>
      </div>
      <div className="perks-grid">
        {perks.map(([t, d]) => (
          <div key={t} className="perk">
            <strong>{t}</strong>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------- appearance ---------------- */

function AppearanceTab() {
  const theme = useUi((s) => s.prefs.theme);
  const fontSize = useUi((s) => s.prefs.fontSize);
  const themes: { id: ThemePref; label: string }[] = [
    { id: 'dark', label: 'Dark' },
    { id: 'light', label: 'Ranch Light' },
    { id: 'system', label: 'Match system' },
    { id: 'glass', label: 'Liquid Glass' },
  ];
  return (
    <>
      <Section title="Theme">
        <div className="theme-cards">
          {themes.map((t) => (
            <button key={t.id} className={`theme-card theme-card-${t.id}${theme === t.id ? ' is-active' : ''}`} onClick={() => ui.setPrefs({ theme: t.id })}>
              <span className="theme-card-art">
                <i />
                <i />
                <i />
              </span>
              {t.label}
            </button>
          ))}
        </div>
      </Section>
      <Section title={`Chat text size · ${fontSize}px`}>
        <Slider value={fontSize} min={13} max={19} step={1} onChange={(v) => ui.setPrefs({ fontSize: v })} label="Chat text size" />
      </Section>
      <BackgroundPicker />
    </>
  );
}

/* ---------------- voice & video ---------------- */

function MicMeter() {
  const [level, setLevel] = useState(0);
  const [on, setOn] = useState(false);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let raf = 0;
    let ctx: AudioContext | null = null;
    const prefs = useUi.getState().prefs.call;
    navigator.mediaDevices
      .getUserMedia({ audio: { deviceId: prefs.inputId ? { ideal: prefs.inputId } : undefined, noiseSuppression: prefs.noiseSuppression, echoCancellation: prefs.echoCancellation } })
      .then((s) => {
        stream = s;
        ctx = new AudioContext();
        const an = ctx.createAnalyser();
        an.fftSize = 512;
        ctx.createMediaStreamSource(s).connect(an);
        const buf = new Float32Array(an.fftSize);
        const loop = () => {
          an.getFloatTimeDomainData(buf);
          let sum = 0;
          for (const v of buf) sum += v * v;
          setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 6));
          raf = requestAnimationFrame(loop);
        };
        loop();
      })
      .catch(() => {
        ui.toast("Couldn't open your microphone", 'error');
        setOn(false);
      });
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
      void ctx?.close();
      setLevel(0);
    };
  }, [on]);
  return (
    <div className="mic-test">
      <Button variant={on ? 'secondary' : 'primary'} size="sm" onClick={() => setOn(!on)}>
        {on ? 'Stop' : "Let's check"}
      </Button>
      <div className="mic-meter">
        <span style={{ width: `${level * 100}%` }} />
      </div>
    </div>
  );
}

function CameraPreview() {
  const ref = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const cameraId = useUi((s) => s.prefs.call.cameraId);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: cameraId ? { ideal: cameraId } : undefined } })
      .then((s) => {
        stream = s;
        if (ref.current) ref.current.srcObject = s;
      })
      .catch(() => {
        ui.toast("Couldn't open your camera", 'error');
        setOn(false);
      });
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, [on, cameraId]);
  return (
    <div className="cam-preview">
      {on ? <video ref={ref} autoPlay playsInline muted /> : <div className="cam-preview-off">Camera preview</div>}
      <Button size="sm" variant="secondary" onClick={() => setOn(!on)}>
        {on ? 'Stop preview' : 'Test video'}
      </Button>
    </div>
  );
}

function VoiceTab() {
  const prefs = useUi((s) => s.prefs.call);
  const sbVolume = useUi((s) => s.prefs.soundboardVolume);
  const inCall = useCall((s) => Boolean(s.channelId));
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listDevices>>>({ inputs: [], outputs: [], cameras: [] });
  useEffect(() => {
    void listDevices().then(setDevices);
    const onChange = () => void listDevices().then(setDevices);
    navigator.mediaDevices?.addEventListener?.('devicechange', onChange);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', onChange);
  }, []);
  const label = (d: MediaDeviceInfo, i: number, kind: string) => d.label || `${kind} ${i + 1}`;
  return (
    <>
      <div className="settings-grid">
        <div className="ui-field">
          <label className="ui-field-label">Input device</label>
          <select
            className="ui-select"
            value={prefs.inputId}
            onChange={(e) => {
              ui.setCallPrefs({ inputId: e.target.value });
              if (inCall) void call.switchMic();
            }}
          >
            <option value="">Default</option>
            {devices.inputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {label(d, i, 'Microphone')}
              </option>
            ))}
          </select>
        </div>
        <div className="ui-field">
          <label className="ui-field-label">Output device</label>
          <select
            className="ui-select"
            value={prefs.outputId}
            onChange={(e) => {
              ui.setCallPrefs({ outputId: e.target.value });
              call.setOutputDevice(e.target.value);
            }}
          >
            <option value="">Default</option>
            {devices.outputs.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {label(d, i, 'Speaker')}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Section title="Mic test" hint="Talk and watch the bar move.">
        <MicMeter />
      </Section>
      <Row title="Noise suppression" hint="Filters out background noise like keyboards and fans.">
        <Switch checked={prefs.noiseSuppression} onChange={(v) => { ui.setCallPrefs({ noiseSuppression: v }); if (inCall) void call.switchMic(); }} label="Noise suppression" />
      </Row>
      <Row title="Echo cancellation" hint="Stops people hearing themselves when you use speakers.">
        <Switch checked={prefs.echoCancellation} onChange={(v) => { ui.setCallPrefs({ echoCancellation: v }); if (inCall) void call.switchMic(); }} label="Echo cancellation" />
      </Row>
      <Section title="Video">
        <div className="ui-field">
          <label className="ui-field-label">Camera</label>
          <select
            className="ui-select"
            value={prefs.cameraId}
            onChange={(e) => {
              ui.setCallPrefs({ cameraId: e.target.value });
              void call.switchCamera();
            }}
          >
            <option value="">Default</option>
            {devices.cameras.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {label(d, i, 'Camera')}
              </option>
            ))}
          </select>
        </div>
        <CameraPreview />
      </Section>
      <Section title={`Soundboard volume · ${Math.round(sbVolume * 100)}%`} hint="How loud other people's soundboard sounds are for you.">
        <Slider value={sbVolume} onChange={(v) => ui.setPrefs({ soundboardVolume: v })} label="Soundboard volume" />
      </Section>
    </>
  );
}

/* ---------------- notifications ---------------- */

function NotificationsTab() {
  const prefs = useUi((s) => s.prefs);
  const vapid = useData((s) => s.instance?.vapidPublicKey ?? null);
  const [perm, setPerm] = useState<'granted' | 'denied' | 'default'>('default');
  const [pushOn, setPushOn] = useState(localStorage.getItem('rc.push') === '1');
  useEffect(() => {
    void notificationPermission().then(setPerm);
  }, []);
  const canPush = !isNative && !isDesktopApp && 'PushManager' in window && Boolean(vapid);
  return (
    <>
      <Row title="Desktop & phone notifications" hint={perm === 'denied' ? 'Notifications are blocked. Allow them in your browser or phone settings.' : 'Get notified about DMs, mentions and calls.'}>
        <Switch
          checked={prefs.notifications && perm === 'granted'}
          onChange={async (v) => {
            if (v) {
              const ok = await requestNotifications();
              setPerm(ok ? 'granted' : await notificationPermission());
              ui.setPrefs({ notifications: ok });
            } else ui.setPrefs({ notifications: false });
          }}
          label="Notifications"
        />
      </Row>
      <Row title="Sounds" hint="Play a little sound for mentions and DMs.">
        <Switch checked={prefs.sounds} onChange={(v) => ui.setPrefs({ sounds: v })} label="Sounds" />
      </Row>
      {canPush && (
        <Row title="Notify me when the app is closed" hint="Uses web push (works on Android Chrome and iPhone home-screen apps).">
          <Switch
            checked={pushOn}
            onChange={async (v) => {
              if (v) {
                const ok = (await requestNotifications()) && (await enableWebPush(vapid));
                setPushOn(ok);
                localStorage.setItem('rc.push', ok ? '1' : '0');
                if (!ok) ui.toast("Couldn't turn on push notifications here", 'error');
              } else {
                await disableWebPush();
                setPushOn(false);
                localStorage.setItem('rc.push', '0');
              }
            }}
            label="Push notifications"
          />
        </Row>
      )}
    </>
  );
}

/* ---------------- emojis ---------------- */

function EmojisTab() {
  const emojis = useData(useShallow((s) => Object.values(s.emojis).sort((a, b) => a.name.localeCompare(b.name))));
  const users = useData((s) => s.users);
  const me = useData((s) => s.me!);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  return (
    <>
      <div className="settings-head-row">
        <p className="settings-hint">Photo emojis are shared by everyone on this server. Use them anywhere with :name:.</p>
        <Button onClick={() => ui.openModal('emojiUpload')}>Add emoji</Button>
      </div>
      <div className="manage-list">
        {emojis.length === 0 && <div className="side-hint">No photo emojis yet.</div>}
        {emojis.map((e) => (
          <div key={e.id} className="manage-row">
            <img src={fileUrl(e.url)} alt="" className="manage-emoji" />
            {editing === e.id ? (
              <input
                className="manage-input"
                autoFocus
                value={name}
                onChange={(ev) => setName(ev.target.value.replace(/\s+/g, '_'))}
                onKeyDown={async (ev) => {
                  if (ev.key === 'Escape') setEditing(null);
                  if (ev.key === 'Enter') {
                    try {
                      await renameEmoji(e.id, name);
                      setEditing(null);
                    } catch (err) {
                      ui.toast(errorMessage(err), 'error');
                    }
                  }
                }}
                onBlur={() => setEditing(null)}
              />
            ) : (
              <span className="manage-name">:{e.name}:</span>
            )}
            <span className="manage-by">
              <Avatar user={users[e.creatorId]} size={20} /> {users[e.creatorId]?.displayName ?? 'Someone'}
            </span>
            {(e.creatorId === me.id || me.isAdmin) && (
              <span className="manage-tools">
                <button
                  onClick={() => {
                    setEditing(e.id);
                    setName(e.name);
                  }}
                  aria-label="Rename"
                >
                  <PencilSimple size={16} />
                </button>
                <button
                  className="is-danger"
                  aria-label="Delete"
                  onClick={() =>
                    ui.openModal('confirm', { title: `Delete :${e.name}:?`, body: 'Old messages will show its name instead.', confirmLabel: 'Delete', danger: true, onConfirm: () => deleteEmoji(e.id) })
                  }
                >
                  <Trash size={16} />
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------- sounds ---------------- */

function SoundsTab() {
  const sounds = useData(useShallow((s) => Object.values(s.sounds).sort((a, b) => a.name.localeCompare(b.name))));
  const users = useData((s) => s.users);
  const me = useData((s) => s.me!);
  return (
    <>
      <div className="settings-head-row">
        <p className="settings-hint">Sounds anyone can play in voice calls. Upload your own clips.</p>
        <Button onClick={() => ui.openModal('soundUpload')}>Upload sound</Button>
      </div>
      <div className="manage-list">
        {sounds.length === 0 && <div className="side-hint">No sounds yet.</div>}
        {sounds.map((s) => (
          <div key={s.id} className="manage-row">
            <span className="manage-emoji">
              <EmojiText text={s.emoji || '🔊'} />
            </span>
            <span className="manage-name">{s.name}</span>
            <span className="manage-by">
              <Avatar user={users[s.creatorId]} size={20} /> {users[s.creatorId]?.displayName ?? 'Someone'}
            </span>
            <span className="manage-tools">
              <button onClick={() => call.playSound(s.id)} aria-label="Play">
                <SpeakerHigh size={16} />
              </button>
              {(s.creatorId === me.id || me.isAdmin) && (
                <button
                  className="is-danger"
                  aria-label="Delete"
                  onClick={() => ui.openModal('confirm', { title: `Delete "${s.name}"?`, confirmLabel: 'Delete', danger: true, onConfirm: () => deleteSound(s.id) })}
                >
                  <Trash size={16} />
                </button>
              )}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}

/* ---------------- app & connection ---------------- */

function AppTab() {
  const instance = useData((s) => s.instance);
  const brand = useBrand();
  const [openAtLogin, setOpenAtLogin] = useState<boolean | null>(null);
  useEffect(() => {
    void desktop?.getOpenAtLogin?.().then(setOpenAtLogin);
  }, []);
  const where = isNative ? serverBase() : location.origin;
  return (
    <>
      <Section title="Server">
        <div className="server-card">
          <img src={brand.logo} alt="" />
          <div>
            <strong>{brand.name}</strong>
            <span className="muted">{where}</span>
          </div>
        </div>
        {(isNative || isDesktopApp) && (
          <div>
            <Button
              variant="secondary"
              onClick={() =>
                ui.openModal('confirm', {
                  title: 'Switch server?',
                  body: "You'll be logged out of this server.",
                  confirmLabel: 'Switch server',
                  onConfirm: async () => {
                    await logout();
                    if (isDesktopApp) desktop!.changeServer();
                    else {
                      clearServerBase();
                      location.reload();
                    }
                  },
                })
              }
            >
              Switch server
            </Button>
          </div>
        )}
      </Section>
      {isDesktopApp && openAtLogin !== null && (
        <Row title="Open when Windows starts" hint="It starts minimized in the tray so you never miss a message.">
          <Switch
            checked={openAtLogin}
            onChange={(v) => {
              desktop?.setOpenAtLogin?.(v);
              setOpenAtLogin(v);
            }}
            label="Open at login"
          />
        </Row>
      )}
      <Section title="Get the apps">
        <Button variant="secondary" onClick={() => ui.openModal('downloads')}>
          Windows, Android & iPhone
        </Button>
      </Section>
      <p className="muted settings-foot">
        RanchCord {isDesktopApp ? `desktop ${desktop?.version}` : isNative ? 'mobile' : 'web'} · calls: {instance?.calls.mode === 'sfu' ? 'media server' : 'peer-to-peer'}
      </p>
    </>
  );
}
