/**
 * The Avengers theme's spawn and despawn: a character steps out of a spinning ring of orange sparks
 * (a sorcerer's portal) and leaves as drifting dust. Drawing only; the state half is shared with
 * the matrix effect (`matrixEffectState.ts`): same timer, same per-column seeds.
 */

import {
  DUST_COLOR,
  DUST_DRIFT_X_PX,
  DUST_DRIFT_Y_PX,
  MATRIX_SPRITE_COLS,
  PORTAL_COLORS,
  PORTAL_CORE_COLOR,
  PORTAL_MAX_RADIUS_PX,
  PORTAL_SPARKS,
  PORTAL_SPIN_TURNS_PER_SEC,
} from '../../constants.js';
import type { Character, SpriteData } from '../types.js';
import { effectDuration } from './matrixEffectState.js';

/** Deterministic 0..1 per pixel, so a pixel's dust path is the same every frame. */
function hash01(col: number, row: number, salt: number): number {
  const h = (col * 374761393 + row * 668265263 + salt * 2246822519) >>> 0;
  return ((h ^ (h >>> 13)) % 1000) / 1000;
}

export function renderPortalEffect(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  spriteData: SpriteData,
  drawX: number,
  drawY: number,
  zoom: number,
): void {
  const progress = Math.min(1, ch.matrixEffectTimer / effectDuration());
  const rows = spriteData.length;
  const cols = spriteData[0]?.length ?? MATRIX_SPRITE_COLS;
  const cx = drawX + (cols / 2) * zoom;
  const cy = drawY + (rows * 0.6) * zoom;

  if (ch.matrixEffect === 'spawn') {
    // The ring opens, the character fills in from its centre outward, the ring closes.
    const open = Math.min(1, progress / 0.3);
    const close = progress > 0.75 ? (progress - 0.75) / 0.25 : 0;
    const radius = PORTAL_MAX_RADIUS_PX * zoom * Math.min(open, 1 - close);
    const reveal = Math.max(0, (progress - 0.15) / 0.6) * rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const pixel = spriteData[row]?.[col];
        if (!pixel) continue;
        const d = Math.hypot(col - cols / 2, (row - rows * 0.6) * 0.8);
        if (d > reveal) continue;
        ctx.fillStyle = pixel;
        ctx.fillRect(drawX + col * zoom, drawY + row * zoom, zoom, zoom);
      }
    }
    if (radius > 0) {
      if (progress < 0.5) {
        ctx.fillStyle = PORTAL_CORE_COLOR;
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fill();
      }
      drawSparks(ctx, ch, cx, cy, radius, zoom);
    }
    return;
  }

  // Despawn: each pixel lets go at its own moment and drifts up and away as dust.
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const pixel = spriteData[row]?.[col];
      if (!pixel) continue;
      // Lower pixels go first, like a figure crumbling from the feet up.
      const start = 0.55 * (1 - row / rows) + 0.3 * hash01(col, row, 1);
      if (progress < start) {
        ctx.fillStyle = pixel;
        ctx.fillRect(drawX + col * zoom, drawY + row * zoom, zoom, zoom);
        continue;
      }
      const t = Math.min(1, (progress - start) / Math.max(0.05, 1 - start));
      const dx = (hash01(col, row, 2) * 2 - 0.5) * DUST_DRIFT_X_PX * t * zoom;
      const dy = -(0.4 + hash01(col, row, 3)) * DUST_DRIFT_Y_PX * t * zoom;
      ctx.save();
      ctx.globalAlpha = ctx.globalAlpha * (1 - t);
      ctx.fillStyle = t < 0.4 ? pixel : DUST_COLOR;
      ctx.fillRect(Math.round(drawX + col * zoom + dx), Math.round(drawY + row * zoom + dy), zoom, zoom);
      ctx.restore();
    }
  }
}

function drawSparks(
  ctx: CanvasRenderingContext2D,
  ch: Character,
  cx: number,
  cy: number,
  radius: number,
  zoom: number,
): void {
  const spin = ch.matrixEffectTimer * PORTAL_SPIN_TURNS_PER_SEC * Math.PI * 2;
  for (let i = 0; i < PORTAL_SPARKS; i++) {
    const seed = ch.matrixEffectSeeds[i % ch.matrixEffectSeeds.length] ?? 0.5;
    const angle = spin + (i / PORTAL_SPARKS) * Math.PI * 2;
    // Sparks sit on the ring, a few fly just outside it.
    const r = radius * (1 + (seed > 0.7 ? (seed - 0.7) * 1.2 : 0));
    const x = Math.round(cx + Math.cos(angle) * r);
    const y = Math.round(cy + Math.sin(angle) * r * 0.9);
    ctx.fillStyle = PORTAL_COLORS[(i + Math.floor(seed * 4)) % PORTAL_COLORS.length];
    ctx.fillRect(x, y, zoom, zoom);
  }
}
