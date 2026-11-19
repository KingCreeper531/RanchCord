import {
  ConnectionState,
  type LocalTrackPublication,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  Room,
  RoomEvent,
  Track,
  VideoPreset,
} from 'livekit-client';
import type { MediaHandle } from '../store/call';
import type { Engine, EngineEvents, Slot } from './engines';

/**
 * LiveKit (SFU) engine: everyone sends one stream to the media server, which forwards it to everyone else.
 * Used automatically when the server has LIVEKIT_* configured. Scales to big calls.
 */

const SOURCE: Record<Slot, Track.Source> = {
  audio: Track.Source.Microphone,
  camera: Track.Source.Camera,
  screen: Track.Source.ScreenShare,
  screenAudio: Track.Source.ScreenShareAudio,
};

function slotOf(source: Track.Source): Slot | null {
  switch (source) {
    case Track.Source.Microphone:
      return 'audio';
    case Track.Source.Camera:
      return 'camera';
    case Track.Source.ScreenShare:
      return 'screen';
    case Track.Source.ScreenShareAudio:
      return 'screenAudio';
    default:
      return null;
  }
}

function handleFor(track: RemoteTrack): MediaHandle {
  return {
    id: track.sid ?? track.mediaStreamTrack.id,
    track: track.mediaStreamTrack,
    attach: (el) => {
      track.attach(el);
    },
    detach: (el) => {
      track.detach(el);
    },
  };
}

export class SfuEngine implements Engine {
  private room: Room;
  private pubs: Partial<Record<Slot, LocalTrackPublication>> = {};
  private micEnabled = true;

  constructor(private ev: EngineEvents) {
    this.room = new Room({
      adaptiveStream: true,
      dynacast: true,
      disconnectOnPageLeave: true,
      publishDefaults: {
        simulcast: true,
        dtx: true,
        red: true,
        videoCodec: 'vp8',
        screenShareEncoding: { maxBitrate: 6_000_000, maxFramerate: 60 },
        screenShareSimulcastLayers: [new VideoPreset(1280, 720, 1_500_000, 30)],
      },
    });
    const r = this.room;
    r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      const slot = slotOf(pub.source);
      if (!slot) return;
      ev.onTrack(p.identity, slot, track.mediaStreamTrack, slot === 'camera' || slot === 'screen' ? handleFor(track) : undefined);
    });
    r.on(RoomEvent.TrackUnsubscribed, (_track: RemoteTrack, pub: RemoteTrackPublication, p: RemoteParticipant) => {
      const slot = slotOf(pub.source);
      if (slot) ev.onTrack(p.identity, slot, null);
    });
    r.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => ev.onPeerState(p.identity, 'connected'));
    r.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
      for (const slot of ['audio', 'camera', 'screen', 'screenAudio'] as Slot[]) ev.onTrack(p.identity, slot, null);
    });
    r.on(RoomEvent.Reconnecting, () => ev.onReconnecting?.());
    r.on(RoomEvent.Reconnected, () => ev.onReconnected?.());
    r.on(RoomEvent.Disconnected, (reason) => ev.onDisconnected?.(String(reason ?? 'disconnected')));
  }

  async connect(url: string, token: string) {
    await this.room.connect(url, token, { autoSubscribe: true });
    for (const p of this.room.remoteParticipants.values()) this.ev.onPeerState(p.identity, 'connected');
  }

  get connected() {
    return this.room.state === ConnectionState.Connected;
  }

  async setTrack(slot: Slot, track: MediaStreamTrack | null) {
    const lp = this.room.localParticipant;
    const existing = this.pubs[slot];
    if (existing?.track) {
      if (track && existing.track.mediaStreamTrack !== track && slot === 'audio') {
        await existing.track.replaceTrack(track, true).catch(() => {});
        track.enabled = this.micEnabled;
        return;
      }
      await lp.unpublishTrack(existing.track, false).catch(() => {});
      delete this.pubs[slot];
    }
    if (!track) return;
    if (slot === 'audio') track.enabled = this.micEnabled;
    this.pubs[slot] = await lp.publishTrack(track, {
      source: SOURCE[slot],
      simulcast: slot === 'camera' || slot === 'screen',
      videoEncoding: slot === 'camera' ? { maxBitrate: 1_700_000, maxFramerate: 30 } : undefined,
    });
  }

  setMicEnabled(enabled: boolean) {
    this.micEnabled = enabled;
    const pub = this.pubs.audio;
    if (!pub?.track) return;
    pub.track.mediaStreamTrack.enabled = enabled;
    if (enabled) void pub.unmute();
    else void pub.mute();
  }

  close() {
    void this.room.disconnect();
  }
}
