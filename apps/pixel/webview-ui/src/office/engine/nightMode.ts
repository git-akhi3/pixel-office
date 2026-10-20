/**
 * Night mode: while a mission is in flight the deck goes dark, black-ops style. The light is faint
 * and steady — no breathing or pulsing — and comes from a few places that give the scene depth: the
 * S.H.I.E.L.D. eagle on the Bridge floor, pools of light through every doorway, wall lamps every few
 * tiles along the long walls, a quiet strip round the Bridge walkway, the theme's own light sources
 * (reactor, stone, spell circle, tanks, braziers), the screens heroes work at and the heroes' own
 * glowing parts. One pass drawn over the scene, before the speech bubbles. Fades in and out.
 *
 * Module state like the theme: the setting (auto / on / off, remembered per browser) and the fade.
 */

import {
  CHARACTER_SITTING_OFFSET_PX,
  nightGlow,
  nightVignette,
  nightWash,
} from '../../constants.js';
import { isAvengersTheme } from '../theme.js';
import type { Character, FurnitureInstance, Seat, TileType as TileTypeVal } from '../types.js';
import { CharacterState, Direction, TILE_SIZE, TileType } from '../types.js';

export type NightSetting = 'auto' | 'on' | 'off';

const STORAGE_KEY = 'pixel-agents.nightMode';
/** Seconds for the lights to go down (or come back up). */
const NIGHT_FADE_SEC = 2.5;
/** How dark the deck gets at full night. */
const WASH_ALPHA = 0.8;
/** The Helicarrier walkway ring is floor pattern 3 (tools/build_layouts.py). */
const WALKWAY_FLOOR = 3;
/** A wall lamp every this many tiles along a wall run. */
const WALL_LAMP_SPACING = 7;

type RGB = [number, number, number];
const COOL_WHITE: RGB = [170, 200, 235];
const STRIP_BLUE: RGB = [70, 130, 220];
const EAGLE_BLUE: RGB = [120, 175, 255];

function readSetting(): NightSetting {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'on' || v === 'off' || v === 'auto') return v;
  } catch {
    // no storage (tests, private windows)
  }
  return 'auto';
}

let setting: NightSetting = readSetting();
/** 0 = day, 1 = full night. */
let level = 0;
let lastNow: number | null = null;

export function getNightSetting(): NightSetting {
  return setting;
}

export function setNightSetting(value: NightSetting): void {
  setting = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // ignore
  }
}

/** Night falls by itself when someone is on a job (a resident or a sub-agent), not for idle sessions. */
export function missionInFlight(characters: Iterable<Character>): boolean {
  for (const ch of characters) {
    if (ch.isActive && (ch.isResident || ch.isSubagent)) return true;
  }
  return false;
}

export function nightLevel(): number {
  return level;
}

interface Glow {
  color: RGB;
  /** Radius in tiles. */
  radius: number;
  strength: number;
  /** A flame: a slight unevenness, nothing more. */
  fire?: boolean;
}

/** What gives off light in the theme packs, by furniture id (mirrored variants share the base id). */
const PROP_GLOW: Record<string, Glow> = {
  SHIELD_EMBLEM: { color: EAGLE_BLUE, radius: 3.4, strength: 0.55 },
  ARC_REACTOR: { color: [110, 200, 255], radius: 2.6, strength: 0.45 },
  IRON_HELMET: { color: [120, 210, 255], radius: 0.9, strength: 0.25 },
  HOLO_TABLE: { color: [90, 170, 255], radius: 1.8, strength: 0.3 },
  BRIDGE_SCREEN: { color: [90, 170, 255], radius: 1.6, strength: 0.25 },
  SKY_WINDOW: { color: [120, 140, 190], radius: 2.0, strength: 0.18 },
  CAP_SHIELD: { color: EAGLE_BLUE, radius: 1.2, strength: 0.2 },
  DATA_WALL: { color: [90, 200, 200], radius: 1.6, strength: 0.22 },
  SERVER_RACK: { color: [80, 230, 120], radius: 1.0, strength: 0.2 },
  MIND_STONE_CASE: { color: [255, 220, 80], radius: 2.0, strength: 0.4 },
  SPELL_CIRCLE: { color: [255, 150, 50], radius: 2.4, strength: 0.4 },
  AGAMOTTO_STAND: { color: [90, 230, 140], radius: 1.6, strength: 0.3 },
  CANDELABRA: { color: [255, 170, 80], radius: 1.4, strength: 0.3, fire: true },
  SANCTUM_WINDOW: { color: [255, 180, 90], radius: 1.6, strength: 0.18 },
  SPOTLIGHT: { color: [255, 70, 70], radius: 2.2, strength: 0.3 },
  GAMMA_TANK: { color: [120, 255, 90], radius: 2.2, strength: 0.35 },
  HAZARD_SIGN: { color: [255, 220, 60], radius: 0.9, strength: 0.2 },
  LANDING_LIGHT: { color: [255, 210, 90], radius: 1.4, strength: 0.35 },
  BRAZIER: { color: [255, 150, 60], radius: 2.0, strength: 0.4, fire: true },
  MJOLNIR_PEDESTAL: { color: [170, 210, 255], radius: 1.6, strength: 0.3 },
  BIFROST_RUNE: { color: [200, 130, 255], radius: 2.2, strength: 0.35 },
  TYPEWRITER: { color: [255, 230, 180], radius: 0.9, strength: 0.15 },
  // the classic office
  PC_FRONT_OFF: { color: [120, 200, 255], radius: 0.9, strength: 0.12 },
};

/** Heroes glow on their own, faintly: keyed on the resident's label. */
const HERO_GLOW: Array<[RegExp, Glow & { at: 'chest' | 'head' }]> = [
  [/iron man|hulkbuster/i, { color: [110, 200, 255], radius: 1.0, strength: 0.35, at: 'chest' }],
  [/vision/i, { color: [255, 220, 80], radius: 0.8, strength: 0.3, at: 'head' }],
  [/strange/i, { color: [90, 230, 140], radius: 0.8, strength: 0.25, at: 'chest' }],
  [/^hulk/i, { color: [120, 255, 90], radius: 1.0, strength: 0.18, at: 'chest' }],
  [/thor/i, { color: [180, 220, 255], radius: 1.0, strength: 0.25, at: 'chest' }],
  [/loki/i, { color: [90, 230, 140], radius: 0.8, strength: 0.18, at: 'head' }],
  [/widow/i, { color: [80, 150, 235], radius: 0.7, strength: 0.18, at: 'chest' }],
  [/captain/i, { color: EAGLE_BLUE, radius: 0.8, strength: 0.15, at: 'chest' }],
  [/spidey/i, { color: [255, 255, 255], radius: 0.6, strength: 0.15, at: 'head' }],
];

const SCREEN_GLOW: Glow = { color: [120, 210, 255], radius: 2.0, strength: 0.35 };

function fireNoise(now: number, phase: number): number {
  return 0.5 + 0.5 * Math.sin(now / 71 + phase) * Math.sin(now / 113 + phase * 2.3);
}

function intensity(g: Glow, now: number, phase: number): number {
  return g.fire ? g.strength * (0.92 + 0.08 * fireNoise(now, phase)) : g.strength;
}

function drawGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusPx: number,
  color: RGB,
  alpha: number,
): void {
  if (alpha <= 0.005 || radiusPx <= 0) return;
  const [r, g, b] = color;
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radiusPx);
  grad.addColorStop(0, nightGlow(r, g, b, alpha));
  grad.addColorStop(0.35, nightGlow(r, g, b, alpha * 0.4));
  grad.addColorStop(1, nightGlow(r, g, b, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(cx - radiusPx, cy - radiusPx, radiusPx * 2, radiusPx * 2);
}

/** A pool of light on the floor: an ellipse, wider than tall, like light falling from above. */
function drawPool(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusPx: number,
  color: RGB,
  alpha: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, 0.6);
  drawGlow(ctx, 0, 0, radiusPx, color, alpha);
  ctx.restore();
}

function facingDelta(dir: Direction): { dx: number; dy: number } {
  switch (dir) {
    case Direction.UP:
      return { dx: 0, dy: -1 };
    case Direction.DOWN:
      return { dx: 0, dy: 1 };
    case Direction.LEFT:
      return { dx: -1, dy: 0 };
    default:
      return { dx: 1, dy: 0 };
  }
}

// ── Where the fixed lights are, worked out once per layout ────────────────────

interface FixedLights {
  /** Doorways: floor tiles in a gap of a wall; light falls through them. */
  doors: Array<{ col: number; row: number }>;
  /** Wall lamps: a wall tile with floor below it, every few tiles along a run. */
  lamps: Array<{ col: number; row: number }>;
  /** The outer edge of the walkway ring. */
  strip: Array<{ col: number; row: number }>;
}

let fixedFor: TileTypeVal[][] | null = null;
let fixed: FixedLights = { doors: [], lamps: [], strip: [] };

function tileAt(tileMap: TileTypeVal[][], c: number, r: number): TileTypeVal | null {
  const row = tileMap[r];
  return row && c >= 0 && c < row.length ? row[c] : null;
}

function isFloor(t: TileTypeVal | null): boolean {
  return t !== null && t !== TileType.WALL && t !== TileType.VOID;
}

/** A wall within two tiles in that direction, with nothing but floor in between (a door's jamb). */
function wallWithinTwo(tileMap: TileTypeVal[][], c: number, r: number, dc: number, dr: number): boolean {
  const one = tileAt(tileMap, c + dc, r + dr);
  if (one === TileType.WALL) return true;
  return isFloor(one) && tileAt(tileMap, c + 2 * dc, r + 2 * dr) === TileType.WALL;
}

function findFixedLights(tileMap: TileTypeVal[][]): FixedLights {
  const doors: FixedLights['doors'] = [];
  const lamps: FixedLights['lamps'] = [];
  const strip: FixedLights['strip'] = [];
  for (let r = 0; r < tileMap.length; r++) {
    let run = 0; // consecutive wall tiles with floor below, for lamp spacing
    for (let c = 0; c < tileMap[r].length; c++) {
      const t = tileMap[r][c];
      if (t === TileType.WALL) {
        if (isFloor(tileAt(tileMap, c, r + 1))) {
          run++;
          // Skip the first tiles of a run so lamps sit away from corners and doors.
          if (run % WALL_LAMP_SPACING === 4) lamps.push({ col: c, row: r });
        } else {
          run = 0;
        }
        continue;
      }
      run = 0;
      if (!isFloor(t)) continue;
      const up = tileAt(tileMap, c, r - 1);
      const down = tileAt(tileMap, c, r + 1);
      const left = tileAt(tileMap, c - 1, r);
      const right = tileAt(tileMap, c + 1, r);
      const inHorizontalWall =
        isFloor(up) &&
        isFloor(down) &&
        wallWithinTwo(tileMap, c, r, -1, 0) &&
        wallWithinTwo(tileMap, c, r, 1, 0);
      const inVerticalWall =
        isFloor(left) &&
        isFloor(right) &&
        wallWithinTwo(tileMap, c, r, 0, -1) &&
        wallWithinTwo(tileMap, c, r, 0, 1);
      if (inHorizontalWall || inVerticalWall) doors.push({ col: c, row: r });
      if (t === WALKWAY_FLOOR) {
        const edge = [up, down, left, right].some((n) => n !== WALKWAY_FLOOR);
        if (edge) strip.push({ col: c, row: r });
      }
    }
  }
  return { doors, lamps, strip };
}

/** Advance the fade and, when there is any night at all, draw it over the scene. */
export function renderNightMode(
  ctx: CanvasRenderingContext2D,
  canvasWidth: number,
  canvasHeight: number,
  furniture: readonly FurnitureInstance[],
  characters: readonly Character[],
  seats: ReadonlyMap<string, Seat> | undefined,
  tileMap: TileTypeVal[][],
  offsetX: number,
  offsetY: number,
  zoom: number,
  now: number,
): void {
  const dt = lastNow === null ? 0 : Math.min(0.1, Math.max(0, (now - lastNow) / 1000));
  lastNow = now;
  const target =
    setting === 'on'
      ? 1
      : setting === 'off'
        ? 0
        : isAvengersTheme() && missionInFlight(characters)
          ? 1
          : 0;
  if (level < target) level = Math.min(target, level + dt / NIGHT_FADE_SEC);
  else if (level > target) level = Math.max(target, level - dt / NIGHT_FADE_SEC);
  if (level <= 0.001) return;

  if (fixedFor !== tileMap) {
    fixedFor = tileMap;
    fixed = findFixedLights(tileMap);
  }

  const tile = TILE_SIZE * zoom;
  const centre = (col: number, row: number) => ({
    x: offsetX + (col + 0.5) * tile,
    y: offsetY + (row + 0.5) * tile,
  });
  ctx.save();

  // Lights out: a dark navy wash with a vignette toward the edges.
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = nightWash(WASH_ALPHA * level);
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);
  const vignette = ctx.createRadialGradient(
    canvasWidth / 2,
    canvasHeight / 2,
    Math.min(canvasWidth, canvasHeight) * 0.35,
    canvasWidth / 2,
    canvasHeight / 2,
    Math.max(canvasWidth, canvasHeight) * 0.75,
  );
  vignette.addColorStop(0, nightVignette(0));
  vignette.addColorStop(1, nightVignette(0.45 * level));
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Everything that gives off light is added on top.
  ctx.globalCompositeOperation = 'lighter';

  // Doorways: a pool of light on the floor through each one.
  for (const d of fixed.doors) {
    const { x, y } = centre(d.col, d.row);
    drawPool(ctx, x, y, tile * 2.2, COOL_WHITE, 0.22 * level);
  }
  // Wall lamps: a small light on the wall and its fall onto the floor below.
  for (const l of fixed.lamps) {
    const { x, y } = centre(l.col, l.row);
    drawGlow(ctx, x, y + tile * 0.3, tile * 0.5, COOL_WHITE, 0.3 * level);
    drawPool(ctx, x, y + tile * 1.3, tile * 1.8, COOL_WHITE, 0.14 * level);
  }
  // The walkway's edge strip.
  for (const s of fixed.strip) {
    const { x, y } = centre(s.col, s.row);
    drawGlow(ctx, x, y, tile * 0.7, STRIP_BLUE, 0.16 * level);
  }

  // The props.
  for (const f of furniture) {
    const id = f.type?.split(':')[0];
    const glow = id ? PROP_GLOW[id] : undefined;
    if (!glow) continue;
    const h = f.sprite.length;
    const w = h > 0 ? f.sprite[0].length : 0;
    const cx = offsetX + (f.x + w / 2) * zoom;
    const cy = offsetY + (f.y + h / 2) * zoom;
    const phase = (f.x * 0.37 + f.y * 0.11) % (2 * Math.PI);
    drawGlow(ctx, cx, cy, glow.radius * tile, glow.color, intensity(glow, now, phase) * level);
  }

  // Working screens and the heroes themselves.
  for (const ch of characters) {
    if (ch.matrixEffect) continue;
    const sitting = ch.state === CharacterState.TYPE;
    const feetY = ch.y + (sitting ? CHARACTER_SITTING_OFFSET_PX : 0);
    if (sitting && ch.isActive && ch.seatId && seats) {
      const seat = seats.get(ch.seatId);
      if (seat) {
        const { dx, dy } = facingDelta(seat.facingDir);
        const sx = offsetX + (seat.seatCol + 0.5 + dx * 1.5) * TILE_SIZE * zoom;
        const sy = offsetY + (seat.seatRow + 0.5 + dy * 1.5) * TILE_SIZE * zoom;
        drawGlow(ctx, sx, sy, SCREEN_GLOW.radius * tile, SCREEN_GLOW.color, SCREEN_GLOW.strength * level);
      }
    }
    const label = ch.label ?? '';
    if (!label) continue;
    for (const [match, glow] of HERO_GLOW) {
      if (!match.test(label)) continue;
      const gy = feetY - (glow.at === 'head' ? 24 : 15);
      drawGlow(ctx, offsetX + ch.x * zoom, offsetY + gy * zoom, glow.radius * tile, glow.color, glow.strength * level);
      break;
    }
  }

  ctx.restore();
}
