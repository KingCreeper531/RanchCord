import type { ScreenShareChoice } from '../lib/platform';
import { desktop } from '../lib/platform';
import { useUi } from '../store/ui';

/* ---------------- capture ---------------- */

export async function getMic(): Promise<MediaStream> {
  const prefs = useUi.getState().prefs.call;
  return navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: prefs.inputId ? { ideal: prefs.inputId } : undefined,
      echoCancellation: prefs.echoCancellation,
      noiseSuppression: prefs.noiseSuppression,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });
}

export async function getCamera(): Promise<MediaStream> {
  const prefs = useUi.getState().prefs.call;
  return navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: prefs.cameraId ? { ideal: prefs.cameraId } : undefined,
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    },
    audio: false,
  });
}

const RES: Record<ScreenShareChoice['resolution'], { width: number; height: number } | null> = {
  '720': { width: 1280, height: 720 },
  '1080': { width: 1920, height: 1080 },
  source: null,
};

/**
 * Captures a screen, window or tab. In the Windows app the picker (entire screens + app windows, quality,
 * share sound) is drawn by the desktop shell; in browsers we pass the user's choice as constraints.
 */
export async function getScreen(choice: ScreenShareChoice | null): Promise<{ stream: MediaStream; choice: ScreenShareChoice }> {
  const want = choice ?? { resolution: '1080', fps: 30, audio: true };
  const res = RES[want.resolution];
  const constraints = {
    video: {
      displaySurface: 'monitor',
      frameRate: { ideal: want.fps, max: want.fps },
      ...(res ? { width: { ideal: res.width, max: res.width }, height: { ideal: res.height, max: res.height } } : {}),
    },
    audio: want.audio ? { suppressLocalAudioPlayback: false, echoCancellation: false, noiseSuppression: false, autoGainControl: false } : false,
    systemAudio: 'include',
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    monitorTypeSurfaces: 'include',
  } as DisplayMediaStreamOptions;
  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  let final = want;
  if (desktop && desktop.nativeScreenPicker !== false) {
    // The Electron app's own picker decided quality; apply it to the captured track.
    const picked = await desktop.lastScreenShareChoice().catch(() => null);
    if (picked) final = picked;
    const r = RES[final.resolution];
    const track = stream.getVideoTracks()[0];
    await track
      ?.applyConstraints({ frameRate: { ideal: final.fps, max: final.fps }, ...(r ? { width: { max: r.width }, height: { max: r.height } } : {}) })
      .catch(() => {});
  }
  const video = stream.getVideoTracks()[0];
  if (video) video.contentHint = final.fps >= 60 ? 'motion' : 'detail';
  return { stream, choice: final };
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

export async function listDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputs: devices.filter((d) => d.kind === 'audioinput'),
      outputs: devices.filter((d) => d.kind === 'audiooutput'),
      cameras: devices.filter((d) => d.kind === 'videoinput'),
    };
  } catch {
    return { inputs: [], outputs: [], cameras: [] };
  }
}

/* ---------------- remote audio playback ---------------- */

type SinkAudio = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/** Plays everyone's audio through <audio> elements so deafen, per-user volume and output device work everywhere. */
export class AudioOutput {
  private els = new Map<string, SinkAudio>();
  private host: HTMLDivElement;
  private deafened = false;
  private sinkId = '';

  constructor() {
    this.host = document.createElement('div');
    this.host.style.display = 'none';
    document.body.appendChild(this.host);
  }

  set(key: string, userId: string, track: MediaStreamTrack | null) {
    const existing = this.els.get(key);
    if (!track) {
      if (existing) {
        existing.srcObject = null;
        existing.remove();
        this.els.delete(key);
      }
      return;
    }
    const el = existing ?? (document.createElement('audio') as SinkAudio);
    el.autoplay = true;
    el.dataset.user = userId;
    el.srcObject = new MediaStream([track]);
    el.muted = this.deafened;
    el.volume = this.volumeFor(userId);
    if (this.sinkId && el.setSinkId) void el.setSinkId(this.sinkId).catch(() => {});
    if (!existing) {
      this.host.appendChild(el);
      this.els.set(key, el);
    }
    void el.play().catch(() => {});
  }

  private volumeFor(userId: string) {
    const v = useUi.getState().prefs.call.userVolumes[userId];
    return typeof v === 'number' ? Math.min(1, Math.max(0, v)) : 1;
  }

  setDeafened(deafened: boolean) {
    this.deafened = deafened;
    for (const el of this.els.values()) el.muted = deafened;
  }

  refreshVolumes() {
    for (const el of this.els.values()) el.volume = this.volumeFor(el.dataset.user ?? '');
  }

  setSink(id: string) {
    this.sinkId = id;
    for (const el of this.els.values()) if (el.setSinkId) void el.setSinkId(id).catch(() => {});
  }

  resumeAll() {
    for (const el of this.els.values()) void el.play().catch(() => {});
  }

  destroy() {
    for (const el of this.els.values()) {
      el.srcObject = null;
      el.remove();
    }
    this.els.clear();
    this.host.remove();
  }
}

/* ---------------- speaking detection ---------------- */

export class SpeakingDetector {
  private ctx: AudioContext | null = null;
  private nodes = new Map<string, { source: MediaStreamAudioSourceNode; analyser: AnalyserNode; buf: Float32Array<ArrayBuffer>; last: number; on: boolean }>();
  private timer: number | null = null;

  constructor(private onChange: (id: string, speaking: boolean) => void) {}

  track(id: string, track: MediaStreamTrack | null) {
    this.untrack(id);
    if (!track) return;
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      const source = this.ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      this.nodes.set(id, { source, analyser, buf: new Float32Array(analyser.fftSize), last: 0, on: false });
      this.timer ??= window.setInterval(() => this.tick(), 70);
    } catch {
      /* analysis is best effort */
    }
  }

  untrack(id: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    n.source.disconnect();
    this.nodes.delete(id);
    if (n.on) this.onChange(id, false);
  }

  private tick() {
    const now = performance.now();
    for (const [id, n] of this.nodes) {
      n.analyser.getFloatTimeDomainData(n.buf);
      let sum = 0;
      for (let i = 0; i < n.buf.length; i++) sum += n.buf[i] * n.buf[i];
      const rms = Math.sqrt(sum / n.buf.length);
      if (rms > 0.018) n.last = now;
      const on = now - n.last < 320;
      if (on !== n.on) {
        n.on = on;
        this.onChange(id, on);
      }
    }
  }

  destroy() {
    for (const id of [...this.nodes.keys()]) this.untrack(id);
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}
