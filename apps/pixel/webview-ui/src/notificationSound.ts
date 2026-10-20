import {
  NOTIFICATION_NOTE_1_HZ,
  NOTIFICATION_NOTE_1_START_SEC,
  NOTIFICATION_NOTE_2_HZ,
  NOTIFICATION_NOTE_2_START_SEC,
  NOTIFICATION_NOTE_DURATION_SEC,
  NOTIFICATION_VOLUME,
  PERMISSION_NOTE_1_HZ,
  PERMISSION_NOTE_1_START_SEC,
  PERMISSION_NOTE_2_HZ,
  PERMISSION_NOTE_2_START_SEC,
  PERMISSION_NOTE_DURATION_SEC,
  PERMISSION_VOLUME,
} from './constants.js';
import { isAvengersTheme } from './office/theme.js';
import { isE2E } from './runtime.js';

let soundEnabled = true;
let audioCtx: AudioContext | null = null;

/** E2E test hook: append every (attempted) sound invocation to a window-side log
 *  under window.__pixelAgentsTestHooks.playedSounds (namespace and type
 *  declared by testHooks.ts). Records BEFORE the soundEnabled gate so tests
 *  verify dispatch independent of user audio prefs. Gated on the e2e harness
 *  flag so this unbounded log never grows in a real session. */
function recordSoundForTests(kind: 'done' | 'permission'): void {
  if (!isE2E || typeof window === 'undefined') return;
  if (!window.__pixelAgentsTestHooks) window.__pixelAgentsTestHooks = {};
  if (!window.__pixelAgentsTestHooks.playedSounds) {
    window.__pixelAgentsTestHooks.playedSounds = [];
  }
  window.__pixelAgentsTestHooks.playedSounds.push({ kind, at: Date.now() });
}

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled;
}

export function isSoundEnabled(): boolean {
  return soundEnabled;
}

function playNote(
  ctx: AudioContext,
  freq: number,
  startOffset: number,
  duration: number = NOTIFICATION_NOTE_DURATION_SEC,
  volume: number = NOTIFICATION_VOLUME,
): void {
  const t = ctx.currentTime + startOffset;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t);

  gain.gain.setValueAtTime(volume, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

  osc.connect(gain);
  gain.connect(ctx.destination);

  osc.start(t);
  osc.stop(t + duration);
}

// ── The Avengers theme's sounds ───────────────────────────────────────────────
// Original brass stings synthesised here (no recorded music): a two-hit "heads up" when an
// agent needs you, and a short fanfare when a turn is done.

const HERO_VOLUME = 0.05;

/** A brass-like voice: three slightly detuned saws through a lowpass that opens on the attack. */
function brass(ctx: AudioContext, freq: number, start: number, dur: number, vol: number): void {
  const t = ctx.currentTime + start;
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.Q.value = 1.1;
  filter.frequency.setValueAtTime(freq * 2, t);
  filter.frequency.exponentialRampToValueAtTime(freq * 6, t + 0.06);
  filter.frequency.exponentialRampToValueAtTime(freq * 2.5, t + dur);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(vol, t + 0.03);
  gain.gain.setValueAtTime(vol, t + Math.max(0.03, dur * 0.7));
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
  for (const cents of [-6, 0, 6]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, t);
    osc.detune.setValueAtTime(cents, t);
    osc.connect(filter);
    osc.start(t);
    osc.stop(t + dur + 0.1);
  }
  filter.connect(gain);
  gain.connect(ctx.destination);
}

function chord(ctx: AudioContext, freqs: number[], start: number, dur: number, vol: number): void {
  for (const f of freqs) brass(ctx, f, start, dur, vol);
}

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** A timpani hit: a sine that drops in pitch plus a short burst of low noise. */
function drum(ctx: AudioContext, start: number, vol: number, low = 65): void {
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(low * 2.2, t);
  osc.frequency.exponentialRampToValueAtTime(low, t + 0.09);
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t);
  osc.stop(t + 0.55);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, 0.12);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 700;
  const ngain = ctx.createGain();
  ngain.gain.setValueAtTime(vol * 0.6, t);
  ngain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  noise.connect(filter);
  filter.connect(ngain);
  ngain.connect(ctx.destination);
  noise.start(t);
}

/** A cymbal swell: high-passed noise that fades. */
function crash(ctx: AudioContext, start: number, dur: number, vol: number): void {
  const t = ctx.currentTime + start;
  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer(ctx, dur);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 4000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(vol, t);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  noise.start(t);
}

// Pitches (Hz)
const D3 = 146.83, E3 = 164.81, A3 = 220.0, B3 = 246.94;
const D4 = 293.66, E4 = 329.63, FS4 = 369.99, G4 = 392.0, A4 = 440.0, B4 = 493.88, D5 = 587.33;

/** Needs you: two brass hits stepping up, with a drum under each. About 0.7 s. */
function playAssembleSting(ctx: AudioContext): void {
  drum(ctx, 0, 0.5);
  chord(ctx, [D3, A3, D4], 0, 0.22, HERO_VOLUME);
  drum(ctx, 0.24, 0.4);
  chord(ctx, [E3, B3, E4], 0.24, 0.42, HERO_VOLUME);
}

/** Done: a short fanfare — an arpeggio up to a held top note, a turn, and a resolve. About 2.8 s. */
function playVictoryFanfare(ctx: AudioContext): void {
  const v = HERO_VOLUME;
  // the call
  drum(ctx, 0, 0.55);
  brass(ctx, D4, 0.0, 0.13, v);
  brass(ctx, FS4, 0.15, 0.13, v);
  brass(ctx, A4, 0.3, 0.13, v);
  drum(ctx, 0.46, 0.6);
  brass(ctx, D5, 0.46, 0.5, v);
  chord(ctx, [D3, A3, FS4], 0.46, 0.5, v * 0.55);
  // the turn
  brass(ctx, B4, 1.0, 0.2, v);
  brass(ctx, A4, 1.22, 0.2, v);
  brass(ctx, G4, 1.44, 0.22, v);
  chord(ctx, [B3, D4], 1.0, 0.66, v * 0.5);
  drum(ctx, 1.44, 0.45);
  brass(ctx, A4, 1.68, 0.24, v);
  chord(ctx, [A3, E4], 1.68, 0.24, v * 0.5);
  // the resolve
  drum(ctx, 1.95, 0.8);
  crash(ctx, 1.95, 1.1, 0.05);
  brass(ctx, D5, 1.95, 0.85, v);
  chord(ctx, [D3, A3, D4, FS4], 1.95, 0.85, v * 0.6);
}

export async function playDoneSound(): Promise<void> {
  recordSoundForTests('done');
  if (!soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    // Resume suspended context (webviews suspend until user gesture)
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    if (isAvengersTheme()) {
      playVictoryFanfare(audioCtx);
      return;
    }
    // Ascending two-note chime: E5 → B5
    playNote(audioCtx, NOTIFICATION_NOTE_1_HZ, NOTIFICATION_NOTE_1_START_SEC);
    playNote(audioCtx, NOTIFICATION_NOTE_2_HZ, NOTIFICATION_NOTE_2_START_SEC);
  } catch {
    // Audio may not be available
  }
}

export async function playPermissionSound(): Promise<void> {
  recordSoundForTests('permission');
  if (!soundEnabled) return;
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume();
    }
    if (isAvengersTheme()) {
      playAssembleSting(audioCtx);
      return;
    }
    // Descending two-note tap: A5 → E5
    playNote(
      audioCtx,
      PERMISSION_NOTE_1_HZ,
      PERMISSION_NOTE_1_START_SEC,
      PERMISSION_NOTE_DURATION_SEC,
      PERMISSION_VOLUME,
    );
    playNote(
      audioCtx,
      PERMISSION_NOTE_2_HZ,
      PERMISSION_NOTE_2_START_SEC,
      PERMISSION_NOTE_DURATION_SEC,
      PERMISSION_VOLUME,
    );
  } catch {
    // Audio may not be available
  }
}

/** Call from any user-gesture handler to ensure AudioContext is unlocked */
export function unlockAudio(): void {
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  } catch {
    // ignore
  }
}
