import type { MediaHandle } from '../store/call';

export const SLOTS = ['audio', 'camera', 'screen', 'screenAudio'] as const;
export type Slot = (typeof SLOTS)[number];

export interface EngineEvents {
  onTrack(userId: string, slot: Slot, track: MediaStreamTrack | null, handle?: MediaHandle): void;
  onPeerState(userId: string, state: 'connecting' | 'connected' | 'failed'): void;
  onReconnecting?(): void;
  onReconnected?(): void;
  onDisconnected?(reason: string): void;
}

export interface Engine {
  setTrack(slot: Slot, track: MediaStreamTrack | null): Promise<void> | void;
  setMicEnabled(enabled: boolean): void;
  addPeer?(userId: string, initiator: boolean): void;
  removePeer?(userId: string): void;
  signal?(from: string, data: SignalData): void;
  resetPeers?(userIds: string[]): void;
  close(): void;
}

export interface SignalData {
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

export function streamHandle(track: MediaStreamTrack): MediaHandle {
  return {
    id: track.id,
    track,
    attach(el) {
      el.srcObject = new MediaStream([track]);
      void el.play().catch(() => {});
    },
    detach(el) {
      el.srcObject = null;
    },
  };
}

/* ======================================================================
 * Peer-to-peer mesh. Every person connects to every other person.
 * Each connection always carries 4 fixed slots (mic, camera, screen, screen audio),
 * so turning the camera or screen share on/off never needs renegotiation.
 * ====================================================================== */

interface Peer {
  pc: RTCPeerConnection;
  polite: boolean;
  initiator: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  pending: RTCIceCandidateInit[];
  queue: Promise<void>;
}

export class MeshEngine implements Engine {
  private peers = new Map<string, Peer>();
  private local: Record<Slot, MediaStreamTrack | null> = { audio: null, camera: null, screen: null, screenAudio: null };
  private micEnabled = true;

  constructor(
    private iceServers: RTCIceServer[],
    private send: (to: string, data: SignalData) => void,
    private ev: EngineEvents,
  ) {}

  addPeer(userId: string, initiator: boolean) {
    this.removePeer(userId);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const peer: Peer = { pc, polite: !initiator, initiator, makingOffer: false, ignoreOffer: false, pending: [], queue: Promise.resolve() };
    this.peers.set(userId, peer);
    this.ev.onPeerState(userId, 'connecting');

    if (initiator) {
      for (const slot of SLOTS) {
        const kind = slot === 'audio' || slot === 'screenAudio' ? 'audio' : 'video';
        const track = this.local[slot];
        pc.addTransceiver(track ?? kind, { direction: 'sendrecv' });
      }
    }

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        this.send(userId, { description: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn('[call] offer failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate) this.send(userId, { candidate: e.candidate.toJSON() });
    };
    pc.ontrack = (e) => {
      const index = pc.getTransceivers().indexOf(e.transceiver);
      const slot = SLOTS[index];
      if (!slot) return;
      this.ev.onTrack(userId, slot, e.track, slot === 'camera' || slot === 'screen' ? streamHandle(e.track) : undefined);
    };
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') {
        this.ev.onPeerState(userId, 'connected');
        this.applyBitrates();
      } else if (s === 'failed') {
        this.ev.onPeerState(userId, 'failed');
        if (peer.initiator) pc.restartIce();
      } else if (s === 'disconnected' || s === 'connecting' || s === 'new') {
        this.ev.onPeerState(userId, 'connecting');
      }
    };
  }

  removePeer(userId: string) {
    const peer = this.peers.get(userId);
    if (!peer) return;
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    peer.pc.close();
    this.peers.delete(userId);
    for (const slot of SLOTS) this.ev.onTrack(userId, slot, null);
  }

  resetPeers(userIds: string[]) {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
    for (const id of userIds) this.addPeer(id, true);
  }

  signal(from: string, data: SignalData) {
    let peer = this.peers.get(from);
    if (!peer) {
      this.addPeer(from, false);
      peer = this.peers.get(from)!;
    }
    const p = peer;
    p.queue = p.queue.then(() => this.handleSignal(from, p, data)).catch((err) => console.warn('[call] signal error', err));
  }

  private async handleSignal(from: string, peer: Peer, data: SignalData) {
    const pc = peer.pc;
    if (data.description) {
      const desc = data.description;
      const collision = desc.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
      peer.ignoreOffer = !peer.polite && collision;
      if (peer.ignoreOffer) return;
      await pc.setRemoteDescription(desc);
      if (desc.type === 'offer') {
        this.attachLocal(peer);
        await pc.setLocalDescription();
        this.send(from, { description: pc.localDescription!.toJSON() });
      }
      for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    } else if (data.candidate) {
      if (!pc.remoteDescription) {
        peer.pending.push(data.candidate);
        return;
      }
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!peer.ignoreOffer) console.warn('[call] bad candidate', err);
      }
    }
  }

  /** Answering side: put our tracks on the transceivers the offer created. */
  private attachLocal(peer: Peer) {
    const transceivers = peer.pc.getTransceivers();
    SLOTS.forEach((slot, i) => {
      const t = transceivers[i];
      if (!t) return;
      if (t.direction !== 'sendrecv') t.direction = 'sendrecv';
      const track = this.local[slot];
      if (t.sender.track !== track) void t.sender.replaceTrack(track).catch(() => {});
    });
  }

  async setTrack(slot: Slot, track: MediaStreamTrack | null) {
    if (slot === 'audio' && track) track.enabled = this.micEnabled;
    this.local[slot] = track;
    const i = SLOTS.indexOf(slot);
    await Promise.all(
      [...this.peers.values()].map(async (peer) => {
        const t = peer.pc.getTransceivers()[i];
        if (t && t.sender.track !== track) await t.sender.replaceTrack(track).catch(() => {});
      }),
    );
    this.applyBitrates();
  }

  setMicEnabled(enabled: boolean) {
    this.micEnabled = enabled;
    if (this.local.audio) this.local.audio.enabled = enabled;
  }

  /** Spread each person's upload bandwidth over everyone they're sending to. */
  private applyBitrates() {
    const n = Math.max(1, this.peers.size);
    const camera = n <= 1 ? 1_500_000 : n <= 3 ? 800_000 : n <= 6 ? 450_000 : n <= 12 ? 250_000 : 150_000;
    const screen = n <= 1 ? 6_000_000 : n <= 3 ? 3_000_000 : n <= 6 ? 1_500_000 : n <= 12 ? 900_000 : 500_000;
    for (const peer of this.peers.values()) {
      const ts = peer.pc.getTransceivers();
      const set = async (t: RTCRtpTransceiver | undefined, max: number) => {
        if (!t?.sender.track) return;
        const params = t.sender.getParameters();
        if (!params.encodings?.length) return;
        if (params.encodings[0].maxBitrate === max) return;
        params.encodings[0].maxBitrate = max;
        await t.sender.setParameters(params).catch(() => {});
      };
      void set(ts[1], camera);
      void set(ts[2], screen);
    }
  }

  close() {
    for (const id of [...this.peers.keys()]) this.removePeer(id);
  }
}
