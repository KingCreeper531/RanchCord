/**
 * All app sounds are synthesized with WebAudio, so there are no audio files to ship.
 */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Call from any user gesture so later sounds are allowed to play. */
export function unlockAudio() {
  audio();
}

function tone(freq: number, start: number, duration: number, gain = 0.12, type: OscillatorType = 'sine', glideTo?: number) {
  const ac = audio();
  if (!ac) return;
  const t = ac.currentTime + start;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t + duration * 0.8);
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(amp).connect(ac.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

export const sounds = {
  message() {
    tone(740, 0, 0.13, 0.09);
    tone(1110, 0.07, 0.2, 0.08);
  },
  mention() {
    tone(880, 0, 0.12, 0.1);
    tone(1320, 0.08, 0.14, 0.09);
    tone(1760, 0.16, 0.22, 0.07);
  },
  join() {
    tone(523, 0, 0.16, 0.09);
    tone(659, 0.09, 0.16, 0.09);
    tone(784, 0.18, 0.28, 0.09);
  },
  leave() {
    tone(784, 0, 0.16, 0.08);
    tone(622, 0.09, 0.16, 0.08);
    tone(466, 0.18, 0.3, 0.08);
  },
  mute() {
    tone(520, 0, 0.09, 0.08, 'triangle', 380);
  },
  unmute() {
    tone(380, 0, 0.09, 0.08, 'triangle', 560);
  },
  deafen() {
    tone(440, 0, 0.12, 0.08, 'triangle', 260);
  },
  undeafen() {
    tone(300, 0, 0.12, 0.08, 'triangle', 500);
  },
  screenOn() {
    tone(660, 0, 0.1, 0.07);
    tone(990, 0.07, 0.16, 0.07);
  },
  screenOff() {
    tone(990, 0, 0.1, 0.07);
    tone(660, 0.07, 0.16, 0.07);
  },
};

let ringTimer: number | null = null;

/** Incoming call ringtone. Loops until stopRing(). */
export function startRing(outgoing = false) {
  stopRing();
  const play = () => {
    if (outgoing) {
      tone(440, 0, 0.5, 0.05);
      tone(480, 0, 0.5, 0.05);
    } else {
      [0, 0.16, 0.32].forEach((d, i) => tone([784, 988, 1175][i], d, 0.28, 0.1));
      [0.9, 1.06, 1.22].forEach((d, i) => tone([784, 988, 1175][i], d, 0.28, 0.1));
    }
  };
  play();
  ringTimer = window.setInterval(play, outgoing ? 3000 : 2600);
}

export function stopRing() {
  if (ringTimer !== null) clearInterval(ringTimer);
  ringTimer = null;
}
