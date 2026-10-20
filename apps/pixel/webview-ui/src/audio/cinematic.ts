/**
 * The director's soundtrack: effects for its sound events (portal, handoff, smash, thunder, ding,
 * sting, fanfare, voice blips) and an original music bed, all synthesised with Web Audio. The same
 * scheduling plays live while a scenario runs and renders offline to a WAV for the recorder.
 */

import {
  assembleSting,
  crash,
  drum,
  getAudioContext,
  noiseBuffer,
  victoryFanfare,
} from '../notificationSound.js';
import type { SoundEvent } from '../office/engine/director.js';

const SAMPLE_RATE = 48000;

function envelope(
  gain: GainNode,
  t: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
): void {
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, peak), t + attack);
  gain.gain.setValueAtTime(Math.max(0.0001, peak), t + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
}

function tone(
  ctx: BaseAudioContext,
  out: AudioNode,
  type: OscillatorType,
  freq: number,
  t: number,
  peak: number,
  attack: number,
  hold: number,
  release: number,
  detune = 0,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  osc.detune.setValueAtTime(detune, t);
  envelope(gain, t, peak, attack, hold, release);
  osc.connect(gain);
  gain.connect(out);
  osc.start(t);
  osc.stop(t + attack + hold + release + 0.05);
}

function noise(
  ctx: BaseAudioContext,
  out: AudioNode,
  t: number,
  seconds: number,
  peak: number,
  filterType: BiquadFilterType,
  from: number,
  to = from,
  attack = 0.005,
): void {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx, seconds + 0.05);
  const filter = ctx.createBiquadFilter();
  filter.type = filterType;
  filter.frequency.setValueAtTime(from, t);
  if (to !== from) filter.frequency.exponentialRampToValueAtTime(to, t + seconds);
  const gain = ctx.createGain();
  envelope(gain, t, peak, attack, 0, seconds - attack);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(out);
  src.start(t);
}

/** A bell: a sine with a quiet octave above it. */
function bell(ctx: BaseAudioContext, out: AudioNode, freq: number, t: number, peak: number, seconds: number): void {
  tone(ctx, out, 'sine', freq, t, peak, 0.01, 0.05, seconds);
  tone(ctx, out, 'sine', freq * 2, t, peak * 0.3, 0.01, 0.02, seconds * 0.6);
}

// ── effects ───────────────────────────────────────────────────────────────────

export function scheduleEffect(ctx: BaseAudioContext, e: SoundEvent, at: number): void {
  const out = ctx.destination;
  switch (e.kind) {
    case 'sting':
      assembleSting(ctx, at);
      return;
    case 'fanfare':
      victoryFanfare(ctx, at);
      return;
    case 'ding':
      bell(ctx, out, 659.25, at, 0.08, 0.5);
      bell(ctx, out, 880, at + 0.12, 0.08, 0.7);
      return;
    case 'handoff':
      bell(ctx, out, 1046.5, at, 0.06, 0.4);
      bell(ctx, out, 1568, at + 0.1, 0.05, 0.6);
      return;
    case 'portal':
      noise(ctx, out, at, 0.9, 0.12, 'bandpass', 150, 2600, 0.15);
      tone(ctx, out, 'sine', 220, at, 0.05, 0.1, 0.3, 0.5);
      tone(ctx, out, 'sine', 880, at + 0.3, 0.03, 0.2, 0.1, 0.5);
      return;
    case 'smash':
      drum(ctx, at, 0.9, 42);
      noise(ctx, out, at, 0.35, 0.3, 'lowpass', 320);
      crash(ctx, at + 0.02, 0.6, 0.04);
      return;
    case 'thunder':
      noise(ctx, out, at, 0.08, 0.35, 'highpass', 1800);
      noise(ctx, out, at + 0.05, 1.6, 0.25, 'lowpass', 140, 60, 0.02);
      drum(ctx, at + 0.05, 0.5, 38);
      return;
    case 'talk': {
      const seconds = Math.min(e.seconds ?? 1, 3);
      const base = 230 + (e.pitch ?? 0.5) * 240;
      for (let i = 0, t = 0; t < seconds; i++, t += 0.085) {
        const wobble = 1 + ((i * 7) % 5) * 0.03;
        tone(ctx, out, 'square', base * wobble, at + t, 0.018, 0.004, 0.025, 0.02);
      }
      return;
    }
    case 'music':
      return; // scheduled as a bed over its on..off span
  }
}

// ── the music bed ───────────────────────────────────────────────────────────

const BPM = 92;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
/** D minor, four bars: Dm, Bb, F, C — bass note and the chord above it (Hz). */
const PROGRESSION: Array<{ bass: number; chord: number[] }> = [
  { bass: 73.42, chord: [146.83, 174.61, 220.0] },
  { bass: 58.27, chord: [116.54, 146.83, 174.61] },
  { bass: 87.31, chord: [174.61, 220.0, 261.63] },
  { bass: 65.41, chord: [130.81, 164.81, 196.0] },
];

/** Plays the bed from `from` to `to` (seconds from the context's clock), fading out at the end. */
export function scheduleMusic(ctx: BaseAudioContext, from: number, to: number): GainNode {
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, from);
  master.gain.exponentialRampToValueAtTime(0.5, from + 2);
  master.gain.setValueAtTime(0.5, Math.max(from + 2, to - 3));
  master.gain.exponentialRampToValueAtTime(0.0001, to);
  const pad = ctx.createBiquadFilter();
  pad.type = 'lowpass';
  pad.frequency.value = 900;
  pad.connect(master);
  master.connect(ctx.destination);

  for (let bar = 0; from + bar * BAR < to; bar++) {
    const t = from + bar * BAR;
    const { bass, chord } = PROGRESSION[bar % PROGRESSION.length];
    // bass
    tone(ctx, master, 'triangle', bass, t, 0.16, 0.02, BAR - 0.25, 0.2);
    // pad: two detuned triangles per chord tone, swelling over the bar
    for (const f of chord) {
      tone(ctx, pad, 'triangle', f, t, 0.03, 0.6, BAR - 1.2, 0.6, -6);
      tone(ctx, pad, 'triangle', f, t, 0.03, 0.6, BAR - 1.2, 0.6, 6);
    }
    // a pulse on eighth notes, the drive under everything
    for (let i = 0; i < 8; i++) {
      tone(ctx, pad, 'square', bass * 2, t + (i * BEAT) / 2, i % 2 === 0 ? 0.03 : 0.018, 0.005, 0.05, 0.08);
    }
    // kick on 1 and 3, a soft hat on the off-beats
    for (let beat = 0; beat < 4; beat++) {
      const bt = t + beat * BEAT;
      if (beat % 2 === 0) tone(ctx, master, 'sine', 55, bt, 0.35, 0.005, 0.03, 0.25);
      noise(ctx, master, bt + BEAT / 2, 0.04, 0.05, 'highpass', 7000);
    }
  }
  return master;
}

// ── live playback ───────────────────────────────────────────────────────────

let liveMusic: GainNode | null = null;

/** Plays a director sound event now, in the page. */
export function playLive(e: SoundEvent): void {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime + 0.02;
    if (e.kind === 'music') {
      if (e.seconds === 0) {
        if (liveMusic) {
          liveMusic.gain.cancelScheduledValues(now);
          liveMusic.gain.setValueAtTime(liveMusic.gain.value, now);
          liveMusic.gain.exponentialRampToValueAtTime(0.0001, now + 2.5);
          liveMusic = null;
        }
      } else if (!liveMusic) {
        liveMusic = scheduleMusic(ctx, now, now + 15 * 60);
      }
      return;
    }
    scheduleEffect(ctx, e, now);
  } catch {
    // no audio
  }
}

// ── offline rendering for the recorder ──────────────────────────────────────

function wavBase64(buffer: AudioBuffer): string {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const data = new DataView(new ArrayBuffer(44 + frames * channels * 2));
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  data.setUint32(4, 36 + frames * channels * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, channels, true);
  data.setUint32(24, buffer.sampleRate, true);
  data.setUint32(28, buffer.sampleRate * channels * 2, true);
  data.setUint16(32, channels * 2, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, frames * channels * 2, true);
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, chans[c][i]));
      data.setInt16(o, v < 0 ? v * 32768 : v * 32767, true);
      o += 2;
    }
  }
  const bytes = new Uint8Array(data.buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)));
  }
  return btoa(out);
}

/** Renders a scenario's sound log to a stereo 48 kHz WAV (base64), `duration` seconds long. */
export async function renderSoundtrack(log: readonly SoundEvent[], duration: number): Promise<string> {
  const ctx = new OfflineAudioContext(2, Math.ceil(SAMPLE_RATE * Math.max(1, duration)), SAMPLE_RATE);
  let musicFrom: number | null = null;
  for (const e of log) {
    if (e.kind === 'music') {
      if (e.seconds === 0) {
        if (musicFrom !== null) scheduleMusic(ctx, musicFrom, e.t);
        musicFrom = null;
      } else if (musicFrom === null) {
        musicFrom = e.t;
      }
    } else {
      scheduleEffect(ctx, e, e.t);
    }
  }
  if (musicFrom !== null) scheduleMusic(ctx, musicFrom, duration);
  const buffer = await ctx.startRendering();
  // A soft limiter: nothing clips, loud hits round off instead.
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) data[i] = Math.tanh(data[i] * 1.4) * 0.85;
  }
  return wavBase64(buffer);
}
