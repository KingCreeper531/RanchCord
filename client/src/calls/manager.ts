import { emit, emitWithAck, onSocket } from '../lib/socket';
import { canShareScreen, isMobileDevice, type ScreenShareChoice } from '../lib/platform';
import { fileUrl } from '../lib/server';
import { sounds, startRing, stopRing, unlockAudio } from '../lib/sound';
import { showNotification } from '../lib/notify';
import { type CallParticipant, patchParticipant, persistVoiceFlags, setSpeaking, useCall } from '../store/call';
import { data, useData } from '../store/data';
import { ui, useUi } from '../store/ui';
import type { VoiceState } from '../types';
import { type Engine, type EngineEvents, MeshEngine, type SignalData, type Slot, streamHandle } from './engines';
import { AudioOutput, SpeakingDetector, getCamera, getMic, getScreen, stopStream } from './media';

interface JoinAck {
  ok: boolean;
  error?: string;
  resumed?: boolean;
  channelId: string;
  participants: VoiceState[];
  iceServers: RTCIceServer[];
  mode: 'p2p' | 'sfu';
  sfu: { url: string; token: string } | null;
}

let engine: Engine | null = null;
let output: AudioOutput | null = null;
let detector: SpeakingDetector | null = null;
let micStream: MediaStream | null = null;
let cameraStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;
let mutedBeforeDeafen = false;
let outgoingRinging = false;

const get = useCall.getState;
const set = useCall.setState;
const meId = () => useData.getState().me?.id ?? '';

function sendState() {
  const s = get();
  if (!s.channelId) return;
  emit('call:state', { muted: s.muted || s.deafened, deafened: s.deafened, video: s.camera, screen: s.screen });
}

function setOutgoingRing(on: boolean) {
  if (on === outgoingRinging) return;
  outgoingRinging = on;
  if (on) startRing(true);
  else if (!Object.keys(useData.getState().rings).length) stopRing();
}

const events: EngineEvents = {
  onTrack(userId, slot, track, handle) {
    if (slot === 'audio' || slot === 'screenAudio') {
      output?.set(`${userId}:${slot}`, userId, track);
      if (slot === 'audio') detector?.track(userId, track);
      return;
    }
    if (slot === 'camera') patchParticipant(userId, { camera: track ? handle ?? streamHandle(track) : null });
    if (slot === 'screen') patchParticipant(userId, { screenShare: track ? handle ?? streamHandle(track) : null });
  },
  onPeerState(userId, state) {
    patchParticipant(userId, { connection: state });
  },
  onReconnecting() {
    set({ status: 'reconnecting' });
  },
  onReconnected() {
    set({ status: 'connected' });
  },
  onDisconnected() {
    if (get().channelId) cleanup('Lost connection to the call');
  },
};

function participantFrom(v: VoiceState): CallParticipant {
  return { ...v, connection: 'connecting', camera: null, screenShare: null };
}

function cleanup(message?: string) {
  engine?.close();
  engine = null;
  stopStream(micStream);
  stopStream(cameraStream);
  stopStream(screenStream);
  micStream = cameraStream = screenStream = null;
  output?.destroy();
  output = null;
  detector?.destroy();
  detector = null;
  setOutgoingRing(false);
  set({
    channelId: null,
    status: 'idle',
    mode: null,
    camera: false,
    screen: false,
    localCamera: null,
    localScreen: null,
    participants: {},
    speaking: {},
    focus: null,
    ringTimedOut: false,
    declined: false,
  });
  if (message) ui.toast(message, 'error');
}

async function startMic() {
  try {
    micStream = await getMic();
  } catch (err) {
    micStream = null;
    const name = (err as DOMException).name;
    ui.toast(
      name === 'NotAllowedError' ? 'RanchCord needs microphone access for calls. You can still listen in.' : "Couldn't open your microphone. You can still listen in.",
      'error',
    );
  }
  const track = micStream?.getAudioTracks()[0] ?? null;
  return track;
}

export const call = {
  async join(channelId: string, opts: { video?: boolean } = {}) {
    const s = get();
    if (s.channelId === channelId) {
      if (opts.video && !s.camera) await call.toggleCamera();
      return;
    }
    if (s.channelId) call.leave(true);
    unlockAudio();
    data.ring(channelId, null);
    if (!Object.keys(useData.getState().rings).length) stopRing();

    set({ channelId, status: 'joining', participants: {}, speaking: {}, focus: null, ringTimedOut: false, declined: false, error: null });
    output = new AudioOutput();
    output.setDeafened(get().deafened);
    output.setSink(useUi.getState().prefs.call.outputId);
    detector = new SpeakingDetector((id, on) => setSpeaking(id, on && !(id === meId() && (get().muted || get().deafened))));

    const micTrack = await startMic();
    if (get().channelId !== channelId) return;

    let ack: JoinAck;
    try {
      ack = await emitWithAck<JoinAck>('call:join', {
        channelId,
        muted: get().muted || get().deafened,
        deafened: get().deafened,
        video: false,
        screen: false,
      });
    } catch (err) {
      cleanup((err as Error).message || "Couldn't join the call");
      return;
    }
    if (!ack.ok) {
      cleanup(ack.error ?? "Couldn't join the call");
      return;
    }
    if (get().channelId !== channelId) return;

    const others = ack.participants.filter((p) => p.userId !== meId());
    set({
      mode: ack.mode,
      participants: Object.fromEntries(others.map((p) => [p.userId, participantFrom(p)])),
    });

    try {
      if (ack.mode === 'sfu' && ack.sfu) {
        const { SfuEngine } = await import('./sfu');
        const sfu = new SfuEngine(events);
        engine = sfu;
        await sfu.connect(ack.sfu.url, ack.sfu.token);
      } else {
        engine = new MeshEngine(ack.iceServers, (to, payload) => emit('call:signal', { channelId, to, data: payload }), events);
      }
    } catch (err) {
      emit('call:leave');
      cleanup(`Couldn't connect to the call server: ${(err as Error).message}`);
      return;
    }
    if (get().channelId !== channelId) return;

    if (micTrack) {
      await engine.setTrack('audio', micTrack);
      detector.track(meId(), micTrack);
    }
    engine.setMicEnabled(!get().muted && !get().deafened);
    if (engine instanceof MeshEngine) for (const p of others) engine.addPeer(p.userId, true);

    set({ status: 'connected' });
    sounds.join();
    const ch = useData.getState().channels[channelId];
    if (ch?.type === 'dm' && others.length === 0) setOutgoingRing(true);
    if (opts.video) await call.toggleCamera();
  },

  leave(silent = false) {
    if (!get().channelId) return;
    emit('call:leave');
    cleanup();
    if (!silent) sounds.leave();
  },

  toggleMute() {
    const s = get();
    unlockAudio();
    if (s.deafened) {
      set({ deafened: false, muted: false });
      output?.setDeafened(false);
      sounds.undeafen();
    } else {
      set({ muted: !s.muted });
      if (s.muted) sounds.unmute();
      else sounds.mute();
    }
    const n = get();
    engine?.setMicEnabled(!n.muted && !n.deafened);
    if (n.muted || n.deafened) setSpeaking(meId(), false);
    persistVoiceFlags();
    sendState();
  },

  toggleDeafen() {
    const s = get();
    unlockAudio();
    if (s.deafened) {
      set({ deafened: false, muted: mutedBeforeDeafen });
      sounds.undeafen();
    } else {
      mutedBeforeDeafen = s.muted;
      set({ deafened: true, muted: true });
      sounds.deafen();
    }
    const n = get();
    output?.setDeafened(n.deafened);
    engine?.setMicEnabled(!n.muted && !n.deafened);
    if (n.muted) setSpeaking(meId(), false);
    persistVoiceFlags();
    sendState();
  },

  async toggleCamera() {
    if (!get().channelId || !engine) return;
    if (get().camera) {
      await engine.setTrack('camera', null);
      stopStream(cameraStream);
      cameraStream = null;
      set({ camera: false, localCamera: null });
      sendState();
      return;
    }
    try {
      cameraStream = await getCamera();
    } catch (err) {
      ui.toast((err as DOMException).name === 'NotAllowedError' ? 'RanchCord needs camera access for video.' : "Couldn't start your camera.", 'error');
      return;
    }
    const track = cameraStream.getVideoTracks()[0];
    await engine.setTrack('camera', track);
    set({ camera: true, localCamera: streamHandle(track) });
    sendState();
  },

  /** Quality picker first, then the browser's/WebView2's screen picker (the old Electron app drew its own). */
  toggleScreen() {
    if (get().screen) {
      void call.stopScreen();
      return;
    }
    if (!canShareScreen) {
      ui.toast("Screen sharing isn't available on this device, but you can watch other people's.", 'error');
      return;
    }
    if (window.ranchDesktop && window.ranchDesktop.nativeScreenPicker !== false) void call.startScreen(null);
    else ui.openModal('screenShare');
  },

  async startScreen(choice: ScreenShareChoice | null) {
    if (!get().channelId || !engine) return;
    let result: Awaited<ReturnType<typeof getScreen>>;
    try {
      result = await getScreen(choice);
    } catch (err) {
      if ((err as DOMException).name !== 'NotAllowedError' && (err as DOMException).name !== 'AbortError') {
        ui.toast("Couldn't start screen sharing.", 'error');
      }
      return;
    }
    if (!get().channelId || !engine) {
      stopStream(result.stream);
      return;
    }
    screenStream = result.stream;
    const video = screenStream.getVideoTracks()[0];
    const audio = screenStream.getAudioTracks()[0] ?? null;
    video.addEventListener('ended', () => void call.stopScreen());
    await engine.setTrack('screen', video);
    if (audio) await engine.setTrack('screenAudio', audio);
    set({ screen: true, localScreen: streamHandle(video), focus: { userId: meId(), kind: 'screen' } });
    sounds.screenOn();
    sendState();
  },

  async stopScreen() {
    if (!get().screen) return;
    await engine?.setTrack('screen', null);
    await engine?.setTrack('screenAudio', null);
    stopStream(screenStream);
    screenStream = null;
    const f = get().focus;
    set({ screen: false, localScreen: null, focus: f?.userId === meId() && f.kind === 'screen' ? null : f });
    sounds.screenOff();
    sendState();
  },

  ringAgain() {
    const id = get().channelId;
    if (!id) return;
    set({ ringTimedOut: false, declined: false });
    emit('call:ring', { channelId: id });
    setOutgoingRing(true);
  },

  decline(channelId: string) {
    emit('call:decline', { channelId });
    data.ring(channelId, null);
    if (!Object.keys(useData.getState().rings).length) stopRing();
  },

  setFocus(focus: { userId: string; kind: 'camera' | 'screen' } | null) {
    set({ focus });
  },

  playSound(soundId: string) {
    if (!get().channelId) {
      previewSound(soundId);
      return;
    }
    emit('call:sound', { soundId });
  },

  async switchMic() {
    if (!get().channelId || !engine) return;
    const old = micStream;
    const track = await startMic();
    if (track) {
      await engine.setTrack('audio', track);
      detector?.track(meId(), track);
      engine.setMicEnabled(!get().muted && !get().deafened);
    }
    stopStream(old);
  },

  async switchCamera() {
    if (!get().camera || !engine) return;
    const old = cameraStream;
    try {
      cameraStream = await getCamera();
      const track = cameraStream.getVideoTracks()[0];
      await engine.setTrack('camera', track);
      set({ localCamera: streamHandle(track) });
      stopStream(old);
    } catch {
      ui.toast("Couldn't switch camera", 'error');
    }
  },

  setOutputDevice(id: string) {
    output?.setSink(id);
  },

  refreshVolumes() {
    output?.refreshVolumes();
  },
};

/* ---------------- soundboard playback ---------------- */

const playing = new Set<HTMLAudioElement>();

function playSoundFile(soundId: string, userId?: string) {
  const sound = useData.getState().sounds[soundId];
  if (!sound) return;
  const vol = useUi.getState().prefs.soundboardVolume * sound.volume;
  if (vol <= 0) return;
  const el = new Audio(fileUrl(sound.url)) as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  el.volume = Math.min(1, Math.max(0, vol));
  const sink = useUi.getState().prefs.call.outputId;
  if (sink && el.setSinkId) void el.setSinkId(sink).catch(() => {});
  playing.add(el);
  el.onended = () => playing.delete(el);
  void el.play().catch(() => playing.delete(el));
  if (userId) {
    useCall.setState((s) => ({ soundFx: { ...s.soundFx, [userId]: { emoji: sound.emoji || '🔊', name: sound.name, at: Date.now() } } }));
    setTimeout(() => {
      useCall.setState((s) => {
        const fx = { ...s.soundFx };
        if (fx[userId] && Date.now() - fx[userId].at >= 2400) delete fx[userId];
        return { soundFx: fx };
      });
    }, 2500);
  }
}

export function previewSound(soundId: string) {
  playSoundFile(soundId);
}

export function stopAllSounds() {
  for (const el of playing) el.pause();
  playing.clear();
}

/* ---------------- socket wiring ---------------- */

onSocket('call:peer-joined', (e: VoiceState & { channelId: string }) => {
  if (e.channelId !== get().channelId || e.userId === meId()) return;
  useCall.setState((s) => ({ participants: { ...s.participants, [e.userId]: participantFrom(e) } }));
  engine?.addPeer?.(e.userId, false);
  setOutgoingRing(false);
  sounds.join();
});

onSocket('call:peer-left', (e: { channelId: string; userId: string }) => {
  if (e.channelId !== get().channelId) return;
  engine?.removePeer?.(e.userId);
  output?.set(`${e.userId}:audio`, e.userId, null);
  output?.set(`${e.userId}:screenAudio`, e.userId, null);
  detector?.untrack(e.userId);
  useCall.setState((s) => {
    const participants = { ...s.participants };
    delete participants[e.userId];
    const focus = s.focus?.userId === e.userId ? null : s.focus;
    return { participants, focus };
  });
  sounds.leave();
});

onSocket('call:peer-state', (e: VoiceState & { channelId: string }) => {
  if (e.channelId !== get().channelId) return;
  const before = get().participants[e.userId];
  patchParticipant(e.userId, { muted: e.muted, deafened: e.deafened, video: e.video, screen: e.screen });
  if (before && !before.screen && e.screen && !get().focus) set({ focus: { userId: e.userId, kind: 'screen' } });
  if (before?.screen && !e.screen && get().focus?.userId === e.userId && get().focus?.kind === 'screen') set({ focus: null });
});

onSocket('call:signal', (e: { channelId: string; from: string; data: SignalData }) => {
  if (e.channelId !== get().channelId) return;
  engine?.signal?.(e.from, e.data);
});

onSocket('call:ended', (e: { channelId: string; reason: string }) => {
  if (e.channelId !== get().channelId) return;
  cleanup(e.reason === 'moved' ? 'You joined this call from another device' : e.reason === 'removed' ? undefined : undefined);
  sounds.leave();
});

onSocket('call:declined', (e: { channelId: string; userId: string }) => {
  if (e.channelId !== get().channelId) return;
  set({ declined: true });
  setOutgoingRing(false);
});

onSocket('call:ring-timeout', (e: { channelId: string }) => {
  if (e.channelId !== get().channelId) return;
  set({ ringTimedOut: true });
  setOutgoingRing(false);
});

onSocket('call:ring', (e: { channelId: string; callerId: string }) => {
  if (get().channelId === e.channelId) return;
  data.ring(e.channelId, e.callerId);
  const me = useData.getState().me;
  if (me?.status === 'dnd') return;
  startRing(false);
  const caller = useData.getState().users[e.callerId];
  if (document.visibilityState !== 'visible' || isMobileDevice) {
    void showNotification({
      title: `${caller?.displayName ?? 'Someone'} is calling you`,
      body: 'Tap to answer in RanchCord',
      icon: caller?.avatar,
      tag: `call-${e.channelId}`,
      onClick: () => ui.navigate({ kind: 'dm', channelId: e.channelId }),
    });
  }
});

onSocket('call:ring-end', (e: { channelId: string }) => {
  data.ring(e.channelId, null);
  if (!Object.keys(useData.getState().rings).length && !outgoingRinging) stopRing();
});

onSocket('call:sound', (e: { channelId: string; userId: string; soundId: string }) => {
  if (e.channelId !== get().channelId || get().deafened) {
    if (e.channelId === get().channelId) {
      const sound = useData.getState().sounds[e.soundId];
      if (sound) useCall.setState((s) => ({ soundFx: { ...s.soundFx, [e.userId]: { emoji: sound.emoji || '🔊', name: sound.name, at: Date.now() } } }));
    }
    return;
  }
  playSoundFile(e.soundId, e.userId);
});

// Socket dropped and came back: rejoin the call without hanging up if the server still has us.
onSocket('connect', () => {
  const channelId = get().channelId;
  if (!channelId || get().status === 'joining') return;
  const s = get();
  void emitWithAck<JoinAck>('call:join', { channelId, resume: true, muted: s.muted || s.deafened, deafened: s.deafened, video: s.camera, screen: s.screen })
    .then((ack) => {
      if (!ack.ok) return cleanup(ack.error ?? 'The call ended');
      if (ack.resumed) return;
      // We were dropped from the call while offline: rebuild every connection.
      const others = ack.participants.filter((p) => p.userId !== meId());
      set({ participants: Object.fromEntries(others.map((p) => [p.userId, participantFrom(p)])) });
      engine?.resetPeers?.(others.map((p) => p.userId));
    })
    .catch(() => {});
});

window.addEventListener('beforeunload', () => {
  if (get().channelId) emit('call:leave');
});

export type { Slot };
