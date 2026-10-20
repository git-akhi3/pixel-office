/**
 * Night mode: while a mission is in flight the deck goes dark and whatever gives off light stands
 * out — the theme's props (reactor, mind stone, spell circle, gamma tanks, braziers, runes), the
 * screens heroes are working at, the heroes' own glowing parts, and the strip lights along the
 * Bridge's walkway. One pass drawn over the scene, before the speech bubbles. Fades in and out.
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
import { CharacterState, Direction, TILE_SIZE } from '../types.js';

export type NightSetting = 'auto' | 'on' | 'off';

const STORAGE_KEY = 'pixel-agents.nightMode';
/** Seconds for the lights to go down (or come back up). */
const NIGHT_FADE_SEC = 2.5;
/** How dark the deck gets at full night. */
const WASH_ALPHA = 0.74;
/** The Helicarrier walkway ring is floor pattern 3 (tools/build_layouts.py). */
const WALKWAY_FLOOR = 3;

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

/** Night fades in by itself when someone is on a job (a resident or a sub-agent), not for idle sessions. */
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
  color: [number, number, number];
  /** Radius in tiles. */
  radius: number;
  strength: number;
  /** Slow breathing, period in seconds. */
  pulse?: number;
  /** Fire / electronics: uneven flicker. */
  flicker?: boolean;
  /** A camera flash: a short burst every few seconds. */
  flash?: boolean;
}

/** What glows in the theme packs, by furniture id (mirrored variants share the base id). */
const PROP_GLOW: Record<string, Glow> = {
  ARC_REACTOR: { color: [110, 200, 255], radius: 3.2, strength: 0.9, pulse: 2.4 },
  IRON_HELMET: { color: [120, 210, 255], radius: 1.0, strength: 0.5, pulse: 2 },
  ARMOR_RACK: { color: [120, 210, 255], radius: 1.2, strength: 0.35, pulse: 3 },
  WORKBENCH: { color: [255, 190, 100], radius: 1.4, strength: 0.3, flicker: true },
  ROBOT_ARM: { color: [255, 150, 60], radius: 1.2, strength: 0.3, flicker: true },
  TOOL_WALL: { color: [255, 200, 120], radius: 1.2, strength: 0.2 },
  HOLO_TABLE: { color: [90, 170, 255], radius: 2.2, strength: 0.6, pulse: 3.1 },
  BRIDGE_SCREEN: { color: [90, 170, 255], radius: 2.0, strength: 0.5, pulse: 4 },
  SKY_WINDOW: { color: [150, 170, 220], radius: 2.2, strength: 0.35 },
  SHIELD_EMBLEM: { color: [120, 170, 255], radius: 2.6, strength: 0.35, pulse: 3.0 },
  CAP_SHIELD: { color: [120, 170, 255], radius: 1.4, strength: 0.35, pulse: 3.7 },
  DATA_WALL: { color: [90, 200, 200], radius: 2.0, strength: 0.45, pulse: 5 },
  SERVER_RACK: { color: [80, 230, 120], radius: 1.2, strength: 0.4, flicker: true },
  MIND_STONE_CASE: { color: [255, 220, 80], radius: 2.4, strength: 0.8, pulse: 2.8 },
  FLOATING_BOOKS: { color: [255, 220, 120], radius: 1.2, strength: 0.3, pulse: 3.5 },
  SPELL_CIRCLE: { color: [255, 150, 50], radius: 2.8, strength: 0.8, pulse: 1.8 },
  AGAMOTTO_STAND: { color: [90, 230, 140], radius: 2.0, strength: 0.6, pulse: 2.2 },
  MANDALA_RUG: { color: [255, 170, 70], radius: 2.2, strength: 0.3, pulse: 4.5 },
  CANDELABRA: { color: [255, 170, 80], radius: 1.6, strength: 0.5, flicker: true },
  SANCTUM_WINDOW: { color: [255, 180, 90], radius: 2.0, strength: 0.35 },
  SPOTLIGHT: { color: [255, 70, 70], radius: 2.6, strength: 0.55, pulse: 1.4 },
  EVIDENCE_BOARD: { color: [255, 120, 100], radius: 1.4, strength: 0.25 },
  GAMMA_TANK: { color: [120, 255, 90], radius: 2.6, strength: 0.7, pulse: 2.6 },
  HAZARD_SIGN: { color: [255, 220, 60], radius: 1.0, strength: 0.4, flicker: true },
  LANDING_LIGHT: { color: [255, 210, 90], radius: 1.8, strength: 0.6, pulse: 1.2 },
  QUINJET: { color: [120, 180, 255], radius: 2.4, strength: 0.3, pulse: 3.3 },
  HANGAR_DOOR: { color: [255, 120, 60], radius: 1.6, strength: 0.3, flicker: true },
  SHAWARMA_COUNTER: { color: [255, 190, 110], radius: 1.8, strength: 0.4 },
  TYPEWRITER: { color: [255, 230, 180], radius: 1.0, strength: 0.25 },
  CAMERA_TRIPOD: { color: [255, 255, 255], radius: 2.4, strength: 1.0, flash: true },
  BRAZIER: { color: [255, 150, 60], radius: 2.4, strength: 0.7, flicker: true },
  MJOLNIR_PEDESTAL: { color: [170, 210, 255], radius: 2.0, strength: 0.55, flicker: true },
  BIFROST_RUNE: { color: [200, 130, 255], radius: 2.6, strength: 0.7, pulse: 2.0 },
  GOLD_BANNER: { color: [255, 210, 110], radius: 1.4, strength: 0.25 },
  THRONE: { color: [255, 210, 110], radius: 1.6, strength: 0.3 },
  // the classic office
  PC_FRONT_OFF: { color: [120, 200, 255], radius: 0.9, strength: 0.15 },
  CLOCK: { color: [255, 240, 200], radius: 0.8, strength: 0.2 },
};

/** Heroes glow on their own: keyed on the resident's label. */
const HERO_GLOW: Array<[RegExp, Glow & { at: 'chest' | 'head' }]> = [
  [/iron man|hulkbuster/i, { color: [110, 200, 255], radius: 1.1, strength: 0.7, pulse: 1.6, at: 'chest' }],
  [/vision/i, { color: [255, 220, 80], radius: 0.9, strength: 0.6, pulse: 2.5, at: 'head' }],
  [/strange/i, { color: [90, 230, 140], radius: 0.9, strength: 0.5, pulse: 2.0, at: 'chest' }],
  [/^hulk/i, { color: [120, 255, 90], radius: 1.2, strength: 0.35, pulse: 3, at: 'chest' }],
  [/thor/i, { color: [180, 220, 255], radius: 1.2, strength: 0.5, flicker: true, at: 'chest' }],
  [/loki/i, { color: [90, 230, 140], radius: 0.9, strength: 0.35, pulse: 2.4, at: 'head' }],
  [/widow/i, { color: [80, 150, 235], radius: 0.8, strength: 0.35, pulse: 1.0, at: 'chest' }],
  [/captain/i, { color: [120, 170, 255], radius: 0.9, strength: 0.3, pulse: 2.8, at: 'chest' }],
  [/spidey/i, { color: [255, 255, 255], radius: 0.7, strength: 0.3, pulse: 2, at: 'head' }],
];

const SCREEN_GLOW: Glow = { color: [120, 210, 255], radius: 2.2, strength: 0.6, flicker: true };
const STRIP_COLOR: [number, number, number] = [60, 140, 255];

function flickerNoise(now: number, phase: number): number {
  const a = Math.sin(now / 61 + phase);
  const b = Math.sin(now / 97 + phase * 2.3);
  const c = Math.sin(now / 23 + phase * 0.7);
  return 0.5 + 0.5 * (0.5 * a + 0.3 * b + 0.2 * c);
}

function intensity(g: Glow, now: number, phase: number): number {
  let k = g.strength;
  if (g.pulse) k *= 0.7 + 0.3 * Math.sin((now / 1000) * ((2 * Math.PI) / g.pulse) + phase);
  if (g.flicker) k *= 0.7 + 0.3 * flickerNoise(now, phase);
  if (g.flash) k *= (now / 1000 + phase) % 9 < 0.12 ? 1 : 0;
  return k;
}

function drawGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radiusPx: number,
  color: [number, number, number],
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

  const tile = TILE_SIZE * zoom;
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

  // Everything that glows is added on top.
  ctx.globalCompositeOperation = 'lighter';

  // Strip lights along the walkway ring, a wave of light running round it.
  if (isAvengersTheme()) {
    for (let r = 0; r < tileMap.length; r++) {
      const row = tileMap[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== WALKWAY_FLOOR) continue;
        const k = 0.18 + 0.3 * (0.5 + 0.5 * Math.sin(now / 350 - (c + r) * 0.55));
        drawGlow(
          ctx,
          offsetX + (c + 0.5) * tile,
          offsetY + (r + 0.5) * tile,
          tile * 0.75,
          STRIP_COLOR,
          k * level,
        );
      }
    }
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
        const sx = offsetX + ((seat.seatCol + 0.5 + dx * 1.5) * TILE_SIZE) * zoom;
        const sy = offsetY + ((seat.seatRow + 0.5 + dy * 1.5) * TILE_SIZE) * zoom;
        drawGlow(
          ctx,
          sx,
          sy,
          SCREEN_GLOW.radius * tile,
          SCREEN_GLOW.color,
          intensity(SCREEN_GLOW, now, ch.id * 1.7) * level,
        );
      }
    }
    const label = ch.label ?? '';
    if (!label) continue;
    for (const [match, glow] of HERO_GLOW) {
      if (!match.test(label)) continue;
      const gy = feetY - (glow.at === 'head' ? 24 : 15);
      drawGlow(
        ctx,
        offsetX + ch.x * zoom,
        offsetY + gy * zoom,
        glow.radius * tile,
        glow.color,
        intensity(glow, now, ch.id * 2.1) * level,
      );
      break;
    }
  }

  ctx.restore();
}
