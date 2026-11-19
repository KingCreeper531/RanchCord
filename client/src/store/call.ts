import { create } from 'zustand';

/** A video/audio track we can show. Works the same for peer-to-peer and LiveKit tracks. */
export interface MediaHandle {
  id: string;
  track: MediaStreamTrack;
  attach(el: HTMLMediaElement): void;
  detach(el: HTMLMediaElement): void;
}

export interface CallParticipant {
  userId: string;
  muted: boolean;
  deafened: boolean;
  video: boolean;
  screen: boolean;
  joinedAt: number;
  connection: 'connecting' | 'connected' | 'failed';
  camera: MediaHandle | null;
  screenShare: MediaHandle | null;
}

export interface CallState {
  channelId: string | null;
  status: 'idle' | 'joining' | 'connected' | 'reconnecting';
  mode: 'p2p' | 'sfu' | null;
  muted: boolean;
  deafened: boolean;
  camera: boolean;
  screen: boolean;
  localCamera: MediaHandle | null;
  localScreen: MediaHandle | null;
  participants: Record<string, CallParticipant>;
  speaking: Record<string, boolean>;
  focus: { userId: string; kind: 'camera' | 'screen' } | null;
  ringTimedOut: boolean;
  declined: boolean;
  error: string | null;
  /** Soundboard sound someone just played, shown as a bubble on their tile. */
  soundFx: Record<string, { emoji: string; name: string; at: number }>;
}

const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem('rc.voice') ?? '{}') as { muted?: boolean; deafened?: boolean };
  } catch {
    return {};
  }
})();

export const useCall = create<CallState>(() => ({
  channelId: null,
  status: 'idle',
  mode: null,
  muted: Boolean(saved.muted),
  deafened: Boolean(saved.deafened),
  camera: false,
  screen: false,
  localCamera: null,
  localScreen: null,
  participants: {},
  speaking: {},
  focus: null,
  ringTimedOut: false,
  declined: false,
  error: null,
  soundFx: {},
}));

export function persistVoiceFlags() {
  const { muted, deafened } = useCall.getState();
  localStorage.setItem('rc.voice', JSON.stringify({ muted, deafened }));
}

export function patchParticipant(userId: string, patch: Partial<CallParticipant>) {
  useCall.setState((s) => {
    const p = s.participants[userId];
    if (!p) return s;
    return { participants: { ...s.participants, [userId]: { ...p, ...patch } } };
  });
}

export function setSpeaking(userId: string, speaking: boolean) {
  useCall.setState((s) => (Boolean(s.speaking[userId]) === speaking ? s : { speaking: { ...s.speaking, [userId]: speaking } }));
}
