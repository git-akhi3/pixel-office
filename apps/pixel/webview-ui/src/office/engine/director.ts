/**
 * Director mode: plays a scripted scenario on the office — heroes walk, gather, talk, work, hand
 * off, gates open, the camera follows — for demos and recordings. The script is plain text, one
 * command per line; `#` starts a comment; a trailing `&` runs a command without waiting for it.
 *
 *   wait 2
 *   title "Pixel Office" 3
 *   night on | off | auto
 *   cinematic on | off                       letterbox bars
 *   camera follow <who> | at <area|col,row> | zoom <n> | free
 *   walk <who> <area | col,row | who>        waits for arrival
 *   face <who> <up|down|left|right | who | area>
 *   say <who> "text" [seconds]               a dialogue bubble; waits unless &
 *   gather <area> [who ...]                  everyone (or those named) rings the area's centre
 *   work <who> "task"                        to the desk, label shows the task; waits until seated
 *   done <who>                               back off duty with the done bubble and sound
 *   gate <who>                               needs-approval bubble and sting
 *   approve <who>
 *   release <who | all>                      hands control back to the idle wander
 *   handoff <from> <to>                      from walks up to to and passes a glowing brief
 *   arrive <name> "Label" <area>             a new character steps out of a portal in the area
 *   leave <who>                              the character leaves through a portal
 *   shake [seconds] [pixels]                 the camera shakes
 *   dust <who> | bolt <who> | flash | confetti <who|area>
 *   sound <kind>                             portal, handoff, smash, thunder, ding, sting, fanfare
 *   music on | off
 *   areas off | on                           the room name overlay
 *   extras off | on                          sessions that are not heroes leave the shot
 *   end
 *
 * `who` is a resident's role (coder) or hero name (ironman, hulk, cap, fury...). Directed
 * characters stand still between commands instead of wandering.
 */

import type { Character } from '../types.js';
import { CharacterState, Direction, TILE_SIZE } from '../types.js';
import type { OfficeState } from './officeState.js';

export interface Dialogue {
  id: number;
  text: string;
  /** Seconds the bubble has been up (drives the typewriter). */
  age: number;
  /** Seconds it stays. */
  duration: number;
}

export interface TitleCard {
  text: string;
  age: number;
  duration: number;
}

export type DirectorEffect =
  | { kind: 'brief'; x0: number; y0: number; x1: number; y1: number; age: number; duration: number }
  | { kind: 'dust'; x: number; y: number; age: number; duration: number }
  | { kind: 'flash'; age: number; duration: number }
  | { kind: 'bolt'; x: number; y: number; age: number; duration: number }
  | { kind: 'confetti'; x: number; y: number; age: number; duration: number };

export type SoundKind =
  | 'portal'
  | 'handoff'
  | 'smash'
  | 'thunder'
  | 'ding'
  | 'sting'
  | 'fanfare'
  | 'talk'
  | 'music';

/** One entry of the soundtrack: when (scenario seconds) and what; `seconds` and `pitch` for talk, `seconds` 1/0 for music on/off. */
export interface SoundEvent {
  t: number;
  kind: SoundKind;
  seconds?: number;
  pitch?: number;
}

type Wait = (dt: number) => boolean; // true when finished

interface Command {
  args: string[];
  background: boolean;
  line: number;
}

/** Characters per second the dialogue text appears at. */
export const DIALOGUE_CHARS_PER_SEC = 28;
const WALK_TIMEOUT_SEC = 25;
const WORK_TIMEOUT_SEC = 20;

export class Director {
  dialogues = new Map<number, Dialogue>();
  title: TitleCard | null = null;
  cinematic = false;
  /** Zoom the camera is heading for, in CSS pixels per sprite pixel (the UI scales by the display), or null. */
  cameraZoom: number | null = null;
  /** The zoom the view shows right now, eased toward cameraZoom every update; null = the editor's zoom. */
  viewZoom: number | null = null;
  /** Recording: the loop advances only by the steps the recorder asks for (fixed timestep). */
  stepMode = false;
  /** Recording: returns the canvas as an image data URL; set by the canvas component. */
  captureFrame: (() => string) | null = null;
  private pendingDt = 0;
  private framesSinceStep = 0;
  private stepResolve: (() => void) | null = null;
  /** A `night` command waiting for the UI layer to apply it (the engine does not render). */
  nightRequest: 'auto' | 'on' | 'off' | null = null;
  /** `extras off`: characters that are not heroes (and their labels) stay out of the shot. */
  hideExtras = false;
  /** An `areas` command waiting for the UI layer to apply it. */
  areasRequest: boolean | null = null;
  /** Effects in flight, drawn by the renderer (office/engine/directorEffects.ts). */
  effects: DirectorEffect[] = [];
  /** A camera shake in flight. */
  shake: { age: number; duration: number; pixels: number } | null = null;
  /** Seconds since the scenario started, and everything that made a sound, for the soundtrack. */
  clock = 0;
  startedAt = 0;
  soundLog: SoundEvent[] = [];
  playing = false;
  done = false;
  /** Commands the director could not run, with their line numbers. */
  errors: string[] = [];
  /** Plays the office's sounds; set by the UI layer (the engine stays free of browser audio). */
  onSound: ((event: SoundEvent) => void) | null = null;
  private queue: Command[] = [];
  private wait: Wait | null = null;
  private pendingScript: string | null = null;
  private os: OfficeState;

  constructor(os: OfficeState) {
    this.os = os;
  }

  /** Starts a script; runs once the layout has its residents. */
  play(script: string): void {
    this.stop();
    this.pendingScript = script;
    this.done = false;
    this.errors = [];
  }

  stop(): void {
    for (const ch of this.os.characters.values()) {
      if (ch.directed) this.releaseCharacter(ch);
    }
    this.queue = [];
    this.wait = null;
    this.dialogues.clear();
    this.title = null;
    this.cinematic = false;
    this.hideExtras = false;
    this.cameraZoom = null;
    this.viewZoom = null;
    this.effects = [];
    this.shake = null;
    this.playing = false;
    this.pendingScript = null;
  }

  /** Recording: freeze real time; every `step()` advances the office by one frame of `fps`. */
  record(fps: number): void {
    this.stepMode = true;
    this.stepDt = 1 / fps;
  }
  private stepDt = 1 / 30;

  /** Advances one frame and resolves once that frame (and the overlays' next tick) has rendered. */
  step(): Promise<void> {
    this.pendingDt = this.stepDt;
    this.framesSinceStep = 0;
    return new Promise((resolve) => {
      this.stepResolve = resolve;
    });
  }

  /** The time the game loop should advance this frame: real time, or the pending step when recording. */
  takeDt(realDt: number): number {
    if (!this.stepMode) return realDt;
    const dt = this.pendingDt;
    this.pendingDt = 0;
    return dt;
  }

  /** Called by the canvas after each render; the second render after a step settles the overlays. */
  frameRendered(): void {
    if (!this.stepResolve) return;
    if (++this.framesSinceStep >= 1) {
      const resolve = this.stepResolve;
      this.stepResolve = null;
      resolve();
    }
  }

  /** Where the camera shake puts the view this frame. */
  shakeOffset(): { x: number; y: number } {
    const s = this.shake;
    if (!s) return { x: 0, y: 0 };
    const k = s.pixels * (1 - s.age / s.duration);
    return { x: (Math.random() * 2 - 1) * k, y: (Math.random() * 2 - 1) * k };
  }

  private sound(kind: SoundKind, extra: Partial<SoundEvent> = {}): void {
    const event: SoundEvent = { t: this.clock, kind, ...extra };
    this.soundLog.push(event);
    this.onSound?.(event);
  }

  update(dt: number): void {
    if (this.playing) this.clock += dt;
    if (this.cameraZoom !== null) {
      // Ease toward the target zoom with a 0.45 s time constant (frame-rate independent).
      this.viewZoom =
        this.viewZoom === null
          ? this.cameraZoom
          : this.viewZoom + (this.cameraZoom - this.viewZoom) * (1 - Math.exp(-dt / 0.45));
      if (Math.abs(this.viewZoom - this.cameraZoom) < 0.002) this.viewZoom = this.cameraZoom;
    }
    for (const e of this.effects) e.age += dt;
    this.effects = this.effects.filter((e) => e.age < e.duration);
    if (this.shake) {
      this.shake.age += dt;
      if (this.shake.age >= this.shake.duration) this.shake = null;
    }
    for (const [id, d] of this.dialogues) {
      d.age += dt;
      if (d.age >= d.duration) this.dialogues.delete(id);
    }
    if (this.title) {
      this.title.age += dt;
      if (this.title.age >= this.title.duration) this.title = null;
    }
    if (this.pendingScript !== null && this.os.residentIds.size > 0) {
      this.queue = parseScript(this.pendingScript);
      this.pendingScript = null;
      this.playing = true;
      this.clock = 0;
      this.soundLog = [];
      this.startedAt = Date.now();
    }
    if (!this.playing) return;
    if (this.wait) {
      if (!this.wait(dt)) return;
      this.wait = null;
    }
    while (this.playing && !this.wait) {
      const cmd = this.queue.shift();
      if (!cmd) {
        this.finish();
        return;
      }
      try {
        const wait = this.run(cmd);
        if (wait && !cmd.background) this.wait = wait;
      } catch (e) {
        this.errors.push(`line ${cmd.line}: ${(e as Error).message}`);
      }
    }
  }

  private finish(): void {
    this.playing = false;
    this.done = true;
    for (const ch of this.os.characters.values()) if (ch.directed) this.releaseCharacter(ch);
    this.os.cameraFollowId = null;
  }

  // ── commands ───────────────────────────────────────────────────────────────

  private run(cmd: Command): Wait | null {
    const [name, ...a] = cmd.args;
    switch (name) {
      case 'wait':
        return timer(num(a[0], 1));
      case 'title': {
        const duration = num(a[1], 3);
        this.title = { text: a[0] ?? '', age: 0, duration };
        return timer(duration);
      }
      case 'night':
        this.nightRequest = a[0] === 'on' ? 'on' : a[0] === 'off' ? 'off' : 'auto';
        return null;
      case 'cinematic':
        this.cinematic = a[0] !== 'off';
        return null;
      case 'extras':
        this.hideExtras = a[0] === 'off';
        return null;
      case 'areas':
        this.areasRequest = a[0] !== 'off';
        return null;
      case 'music':
        this.sound('music', { seconds: a[0] === 'off' ? 0 : 1 });
        return null;
      case 'sound':
        this.sound((a[0] ?? 'ding') as SoundKind);
        return null;
      case 'shake':
        this.shake = { age: 0, duration: num(a[0], 0.5), pixels: num(a[1], 5) };
        return null;
      case 'flash':
        this.effects.push({ kind: 'flash', age: 0, duration: num(a[0], 0.35) });
        return null;
      case 'dust': {
        const ch = this.who(a[0]);
        this.effects.push({ kind: 'dust', x: ch.x, y: ch.y, age: 0, duration: 0.7 });
        return null;
      }
      case 'bolt': {
        const ch = this.who(a[0]);
        this.effects.push({ kind: 'bolt', x: ch.x, y: ch.y - 16, age: 0, duration: 0.5 });
        this.effects.push({ kind: 'flash', age: 0, duration: 0.25 });
        return null;
      }
      case 'confetti': {
        const p = this.pointFor(a.join(' '));
        if (!p) throw new Error(`confetti where: ${a.join(' ')}`);
        this.effects.push({ kind: 'confetti', x: p.x, y: p.y - 24, age: 0, duration: 2.5 });
        return null;
      }
      case 'handoff': {
        const from = this.who(a[0]);
        const to = this.who(a[1]);
        this.direct(from);
        this.direct(to);
        const spot = this.os.closestFreeWalkable(to.tileCol, to.tileRow, from.id);
        if (!spot) throw new Error('no room beside ' + a[1]);
        const already = from.tileCol === spot.col && from.tileRow === spot.row;
        if (!already && !this.os.walkToTile(from.id, spot.col, spot.row)) throw new Error('no path');
        const arrive = arrival([from]);
        let passing = -1;
        return (dt) => {
          if (passing < 0) {
            if (!arrive(dt)) return false;
            from.dir = directionToward(from, to.tileCol + 0.5, to.tileRow + 0.5);
            to.dir = directionToward(to, from.tileCol + 0.5, from.tileRow + 0.5);
            this.effects.push({
              kind: 'brief',
              x0: from.x,
              y0: from.y - 14,
              x1: to.x,
              y1: to.y - 14,
              age: 0,
              duration: 0.8,
            });
            this.sound('handoff');
            passing = 0;
          }
          passing += dt;
          return passing >= 1.0;
        };
      }
      case 'arrive': {
        const name = a[0];
        const label = a[1] ?? name;
        const area = a.slice(2).join(' ');
        if (!name || !area) throw new Error('arrive <name> "Label" <area>');
        const id = this.os.spawnExtra(name, label, area);
        const ch = this.os.characters.get(id);
        if (!ch) throw new Error('could not spawn ' + name);
        this.direct(ch);
        this.sound('portal');
        return () => ch.matrixEffect === null;
      }
      case 'leave': {
        const ch = this.who(a[0]);
        this.dialogues.delete(ch.id);
        this.os.removeExtra(ch.id);
        this.sound('portal');
        return () => !this.os.characters.has(ch.id);
      }
      case 'camera':
        return this.camera(a);
      case 'walk': {
        const ch = this.who(a[0]);
        const target = this.spotFor(a.slice(1).join(' '), ch);
        if (!target) throw new Error(`nowhere to walk: ${a.slice(1).join(' ')}`);
        this.direct(ch);
        if (!this.os.walkToTile(ch.id, target.col, target.row)) {
          if (ch.tileCol !== target.col || ch.tileRow !== target.row) throw new Error('no path');
        }
        return arrival([ch]);
      }
      case 'face': {
        const ch = this.who(a[0]);
        this.direct(ch);
        ch.dir = this.directionFor(a.slice(1).join(' '), ch);
        return null;
      }
      case 'say': {
        const ch = this.who(a[0]);
        const text = a[1] ?? '';
        const duration = num(a[2], Math.max(2, 1 + text.length / 14));
        this.dialogues.set(ch.id, { id: ch.id, text, age: 0, duration });
        this.sound('talk', {
          seconds: Math.min(duration, text.length / DIALOGUE_CHARS_PER_SEC),
          pitch: pitchFor(ch.label ?? ch.agentName ?? ''),
        });
        return timer(duration);
      }
      case 'gather': {
        // "gather The Bridge" names the area in several words; "gather Bridge fury cap" names who.
        const whole = a.join(' ');
        return this.os.areaCentre(whole) ? this.gather(whole, []) : this.gather(a[0] ?? '', a.slice(1));
      }
      case 'work': {
        const ch = this.who(a[0]);
        this.direct(ch);
        ch.directedTask = a[1] ?? 'Working';
        ch.bubbleType = null;
        this.os.setAgentActive(ch.id, true);
        return seated(ch);
      }
      case 'done': {
        const ch = this.who(a[0]);
        ch.directedTask = null;
        this.os.setAgentActive(ch.id, false);
        this.os.showWaitingBubble(ch.id, false);
        this.sound('ding');
        return null;
      }
      case 'gate': {
        const ch = this.who(a[0]);
        this.os.showPermissionBubble(ch.id);
        this.sound('sting');
        return null;
      }
      case 'approve': {
        const ch = this.who(a[0]);
        ch.bubbleType = null;
        ch.bubbleTimer = 0;
        return null;
      }
      case 'release':
        if (a[0] === 'all' || !a[0]) {
          for (const ch of this.os.characters.values()) if (ch.directed) this.releaseCharacter(ch);
        } else {
          this.releaseCharacter(this.who(a[0]));
        }
        return null;
      case 'end':
        this.finish();
        return null;
      default:
        throw new Error(`unknown command: ${name}`);
    }
  }

  private camera(a: string[]): Wait | null {
    switch (a[0]) {
      case 'follow':
        this.os.cameraFollowId = this.who(a[1]).id;
        this.os.greeterCameraTarget = null;
        return null;
      case 'at': {
        const spot = this.pointFor(a.slice(1).join(' '));
        if (!spot) throw new Error(`unknown place: ${a.slice(1).join(' ')}`);
        this.os.cameraFollowId = null;
        this.os.greeterCameraTarget = spot;
        return null;
      }
      case 'zoom':
        this.cameraZoom = Math.max(0.5, num(a[1], 2));
        return null;
      case 'free':
        this.os.cameraFollowId = null;
        this.os.greeterCameraTarget = null;
        return null;
      default:
        throw new Error(`camera ${a[0] ?? ''}?`);
    }
  }

  private gather(area: string, names: string[]): Wait | null {
    const centre = this.os.areaCentre(area);
    if (!centre) throw new Error(`unknown area: ${area}`);
    const crew =
      names.length > 0
        ? names.map((n) => this.who(n))
        : [...this.os.residentIds.values()]
            .map((id) => this.os.characters.get(id))
            .filter((ch): ch is Character => !!ch && !ch.isActive);
    // Ring spots: walkable tiles in the area at 2-3 tiles from the centre, spread by angle.
    const tiles = this.os.walkableIn(area).filter((t) => {
      const d = Math.hypot(t.col + 0.5 - centre.col, t.row + 0.5 - centre.row);
      return d >= 1.8 && d <= 3.4;
    });
    tiles.sort(
      (p, q) =>
        Math.atan2(p.row + 0.5 - centre.row, p.col + 0.5 - centre.col) -
        Math.atan2(q.row + 0.5 - centre.row, q.col + 0.5 - centre.col),
    );
    const taken = new Set<string>();
    const walkers: Character[] = [];
    crew.forEach((ch, i) => {
      this.direct(ch);
      const start = Math.floor((i * tiles.length) / Math.max(1, crew.length));
      let spot: { col: number; row: number } | undefined;
      for (let k = 0; k < tiles.length; k++) {
        const t = tiles[(start + k) % tiles.length];
        if (!taken.has(`${t.col},${t.row}`)) {
          spot = t;
          break;
        }
      }
      if (!spot) return;
      taken.add(`${spot.col},${spot.row}`);
      if (this.os.walkToTile(ch.id, spot.col, spot.row)) walkers.push(ch);
    });
    const arrive = arrival(walkers);
    return (dt) => {
      if (!arrive(dt)) return false;
      for (const ch of crew) ch.dir = directionToward(ch, centre.col, centre.row);
      return true;
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private direct(ch: Character): void {
    ch.directed = true;
    ch.chatWith = null;
  }

  private releaseCharacter(ch: Character): void {
    ch.directed = false;
    if (ch.directedTask) {
      ch.directedTask = null;
      this.os.setAgentActive(ch.id, false);
    }
    this.dialogues.delete(ch.id);
  }

  /** The resident a name refers to: its role, or the start of its hero label. */
  who(name: string | undefined): Character {
    const key = norm(name ?? '');
    if (!key) throw new Error('who?');
    const byRole = this.os.residentIds.get(name!) ?? this.os.residentIds.get(key);
    if (byRole !== undefined) {
      const ch = this.os.characters.get(byRole);
      if (ch) return ch;
    }
    let best: Character | null = null;
    for (const id of this.os.residentIds.values()) {
      const ch = this.os.characters.get(id);
      if (!ch) continue;
      const label = norm(ch.label ?? ch.agentName ?? '');
      if (label.startsWith(key) && (!best || label.length < norm(best.label ?? '').length)) best = ch;
    }
    if (!best) throw new Error(`nobody called ${name}`);
    return best;
  }

  /** A free walkable tile for a place: "col,row", a hero (beside them), or an area (near its centre). */
  private spotFor(place: string, forCh: Character): { col: number; row: number } | null {
    const xy = /^(\d+)\s*,\s*(\d+)$/.exec(place.trim());
    if (xy) return { col: Number(xy[1]), row: Number(xy[2]) };
    const centre = this.pointForTile(place, forCh);
    if (!centre) return null;
    return this.os.closestFreeWalkable(centre.col, centre.row, forCh.id);
  }

  private pointForTile(place: string, forCh: Character): { col: number; row: number } | null {
    try {
      const other = this.who(place);
      if (other.id !== forCh.id) return { col: other.tileCol, row: other.tileRow };
    } catch {
      // not a hero: an area
    }
    return this.os.areaCentre(place);
  }

  /** A pixel point for the camera: an area's centre, a hero, or "col,row". */
  private pointFor(place: string): { x: number; y: number } | null {
    const xy = /^(\d+)\s*,\s*(\d+)$/.exec(place.trim());
    if (xy) return { x: (Number(xy[1]) + 0.5) * TILE_SIZE, y: (Number(xy[2]) + 0.5) * TILE_SIZE };
    try {
      const ch = this.who(place);
      return { x: ch.x, y: ch.y };
    } catch {
      // an area
    }
    const c = this.os.areaCentre(place);
    return c ? { x: c.col * TILE_SIZE, y: c.row * TILE_SIZE } : null;
  }

  private directionFor(what: string, ch: Character): Direction {
    const w = what.trim().toLowerCase();
    if (w === 'up') return Direction.UP;
    if (w === 'down') return Direction.DOWN;
    if (w === 'left') return Direction.LEFT;
    if (w === 'right') return Direction.RIGHT;
    const p = this.pointForTile(w, ch);
    if (!p) throw new Error(`face what: ${what}`);
    return directionToward(ch, p.col + 0.5, p.row + 0.5);
  }
}

// ── waits ──────────────────────────────────────────────────────────────────

function timer(seconds: number): Wait {
  let left = seconds;
  return (dt) => {
    left -= dt;
    return left <= 0;
  };
}

function arrival(chars: Character[]): Wait {
  let left = WALK_TIMEOUT_SEC;
  return (dt) => {
    left -= dt;
    return left <= 0 || chars.every((ch) => ch.state !== CharacterState.WALK && ch.path.length === 0);
  };
}

function seated(ch: Character): Wait {
  let left = WORK_TIMEOUT_SEC;
  return (dt) => {
    left -= dt;
    return left <= 0 || ch.state === CharacterState.TYPE;
  };
}

// ── parsing ────────────────────────────────────────────────────────────────

export function parseScript(script: string): Command[] {
  const out: Command[] = [];
  script.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\s#.*$|^#.*$/, '').trim();
    if (!line) return;
    const args: string[] = [];
    for (const m of line.matchAll(/"([^"]*)"|(\S+)/g)) args.push(m[1] ?? m[2]);
    let background = false;
    if (args[args.length - 1] === '&') {
      args.pop();
      background = true;
    }
    if (args.length > 0) out.push({ args, background, line: i + 1 });
  });
  return out;
}

function num(s: string | undefined, fallback: number): number {
  const n = Number(s);
  return s !== undefined && Number.isFinite(n) ? n : fallback;
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** A voice pitch per character (0..1), stable across runs. */
function pitchFor(name: string): number {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 1000;
  return h / 1000;
}

function directionToward(ch: Character, col: number, row: number): Direction {
  const dc = col - (ch.tileCol + 0.5);
  const dr = row - (ch.tileRow + 0.5);
  if (Math.abs(dc) > Math.abs(dr)) return dc > 0 ? Direction.RIGHT : Direction.LEFT;
  return dr > 0 ? Direction.DOWN : Direction.UP;
}
