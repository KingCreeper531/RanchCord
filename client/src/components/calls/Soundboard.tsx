import { useEffect, useMemo, useRef, useState } from 'react';
import { MusicNotes, Play, Plus, SpeakerHigh, SpeakerX, Trash, UploadSimple } from '@phosphor-icons/react';
import { call, previewSound, stopAllSounds } from '../../calls/manager';
import { deleteSound, uploadSound } from '../../lib/actions';
import { errorMessage } from '../../lib/api';
import { formatDuration } from '../../lib/format';
import { Emoji, EmojiText } from '../../lib/twemoji';
import { useCall } from '../../store/call';
import { useData } from '../../store/data';
import { ui, useUi } from '../../store/ui';
import { Button, EmptyState, ModalFrame, Slider, TextField, Tooltip } from '../ui';

export function SoundboardModal({ onClose }: { onClose: () => void }) {
  const soundsMap = useData((s) => s.sounds);
  const meId = useData((s) => s.me!.id);
  const isAdmin = useData((s) => Boolean(s.me?.isAdmin));
  const inCall = useCall((s) => Boolean(s.channelId));
  const volume = useUi((s) => s.prefs.soundboardVolume);
  const [query, setQuery] = useState('');
  const sounds = useMemo(
    () =>
      Object.values(soundsMap)
        .filter((s) => !query || s.name.toLowerCase().includes(query.toLowerCase()))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [soundsMap, query],
  );
  const last = useRef(0);

  return (
    <ModalFrame
      title="Soundboard"
      subtitle={inCall ? 'Tap a sound to play it for everyone in the call.' : "You're not in a call, so sounds only play for you."}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <div className="sb-volume">
            {volume === 0 ? <SpeakerX size={18} /> : <SpeakerHigh size={18} />}
            <Slider value={volume} onChange={(v) => ui.setPrefs({ soundboardVolume: v })} label="Soundboard volume" />
          </div>
          <span className="spacer" />
          <Button variant="secondary" onClick={stopAllSounds}>
            Stop sounds
          </Button>
          <Button icon={<UploadSimple size={16} weight="bold" />} onClick={() => ui.openModal('soundUpload')}>
            Upload sound
          </Button>
        </>
      }
    >
      {Object.keys(soundsMap).length > 6 && (
        <TextField placeholder="Search sounds" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      )}
      {sounds.length === 0 && !query ? (
        <EmptyState title="No sounds yet" body="Upload clips (MP3, WAV, OGG, M4A) and everyone here can play them in voice calls.">
          <Button icon={<Plus size={16} weight="bold" />} onClick={() => ui.openModal('soundUpload')}>
            Upload the first sound
          </Button>
        </EmptyState>
      ) : (
        <div className="sb-grid">
          {sounds.map((s) => (
            <div key={s.id} className="sb-sound">
              <button
                className="sb-sound-main"
                onClick={() => {
                  const now = Date.now();
                  if (now - last.current < 250) return;
                  last.current = now;
                  call.playSound(s.id);
                }}
              >
                <span className="sb-emoji">
                  <EmojiText text={s.emoji || '🔊'} />
                </span>
                <span className="sb-name truncate">{s.name}</span>
                {s.duration > 0 && <span className="sb-dur">{formatDuration(s.duration * 1000)}</span>}
              </button>
              <div className="sb-tools">
                <Tooltip label="Preview (only you hear it)">
                  <button onClick={() => previewSound(s.id)} aria-label="Preview">
                    <Play size={14} weight="fill" />
                  </button>
                </Tooltip>
                {(s.creatorId === meId || isAdmin) && (
                  <Tooltip label="Delete sound">
                    <button
                      onClick={() =>
                        ui.openModal('confirm', {
                          title: `Delete "${s.name}"?`,
                          body: 'It will be removed from the soundboard for everyone.',
                          confirmLabel: 'Delete',
                          danger: true,
                          onConfirm: () => deleteSound(s.id),
                        })
                      }
                      aria-label="Delete"
                    >
                      <Trash size={14} />
                    </button>
                  </Tooltip>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </ModalFrame>
  );
}

const QUICK_EMOJI = ['🔊', '😂', '💀', '🔥', '🎺', '👏', '🚨', '🐐', '🥗', '💥', '😱', '🤡'];

export function SoundUploadModal({ onClose }: { onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [duration, setDuration] = useState(0);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🔊');
  const [volume, setVolume] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => () => {
    if (url) URL.revokeObjectURL(url);
  }, [url]);

  const choose = (f: File) => {
    setError(null);
    setFile(f);
    const u = URL.createObjectURL(f);
    setUrl(u);
    if (!name) setName(f.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 32));
    const a = new Audio(u);
    a.onloadedmetadata = () => setDuration(Number.isFinite(a.duration) ? a.duration : 0);
    a.onerror = () => setError("That file doesn't seem to be audio this device can play.");
  };

  const preview = () => {
    if (!url) return;
    audio.current?.pause();
    const a = new Audio(url);
    a.volume = volume * useUi.getState().prefs.soundboardVolume;
    audio.current = a;
    void a.play();
  };

  const submit = async () => {
    if (!file || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await uploadSound({ name: name.trim(), emoji, volume, duration, file, filename: file.name });
      ui.toast(`Added "${name.trim()}" to the soundboard`, 'success');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame
      title="Upload a sound"
      subtitle="Everyone on this server can play it in voice calls."
      onClose={onClose}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!file || !name.trim()} onClick={() => void submit()}>
            Upload
          </Button>
        </>
      }
    >
      <input
        ref={input}
        type="file"
        accept="audio/*,.mp3,.wav,.ogg,.m4a,.flac,.webm"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) choose(f);
          e.target.value = '';
        }}
      />
      <button className="sb-drop" onClick={() => input.current?.click()}>
        <MusicNotes size={30} weight="duotone" />
        {file ? (
          <>
            <strong className="truncate">{file.name}</strong>
            <span>{duration ? formatDuration(duration * 1000) : 'Reading…'} · click to pick another</span>
          </>
        ) : (
          <>
            <strong>Choose an audio file</strong>
            <span>MP3, WAV, OGG, M4A or FLAC</span>
          </>
        )}
      </button>
      <TextField label="Sound name" value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="airhorn" />
      <div className="ui-field">
        <span className="ui-field-label">Emoji</span>
        <div className="sb-emoji-pick">
          {QUICK_EMOJI.map((e) => (
            <button key={e} className={emoji === e ? 'is-active' : ''} onClick={() => setEmoji(e)} aria-label={e}>
              <Emoji char={e} />
            </button>
          ))}
          <input className="sb-emoji-input emoji-native" value={emoji} maxLength={8} onChange={(e) => setEmoji(e.target.value)} aria-label="Custom emoji" />
        </div>
      </div>
      <div className="ui-field">
        <span className="ui-field-label">Volume · {Math.round(volume * 100)}%</span>
        <div className="ui-row">
          <Slider value={volume} min={0.05} max={1} onChange={setVolume} label="Sound volume" />
          <Button size="sm" variant="secondary" disabled={!url} onClick={preview} icon={<Play size={14} weight="fill" />}>
            Preview
          </Button>
        </div>
      </div>
      {error && <div className="form-error">{error}</div>}
    </ModalFrame>
  );
}
