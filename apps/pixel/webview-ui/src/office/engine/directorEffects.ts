/**
 * The director's effects, drawn over the scene: a brief flying from one hero to another, a dust
 * burst, a white flash, a lightning bolt and confetti. Pure drawing from plain effect data.
 */

import {
  DIRECTOR_BRIEF_FILL,
  DIRECTOR_BRIEF_INK,
  DIRECTOR_CONFETTI,
  directorBolt,
  directorBriefGlow,
  directorDust,
  directorFlash,
} from '../../constants.js';
import type { DirectorEffect } from './director.js';

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** Deterministic pseudo-random in 0..1 for particle i of an effect. */
function hash(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export function renderDirectorEffects(
  ctx: CanvasRenderingContext2D,
  effects: readonly DirectorEffect[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  canvasWidth: number,
  canvasHeight: number,
): void {
  for (const e of effects) {
    const t = Math.min(1, e.age / e.duration);
    ctx.save();
    switch (e.kind) {
      case 'brief': {
        const k = easeInOut(t);
        const x = offsetX + (e.x0 + (e.x1 - e.x0) * k) * zoom;
        const arc = Math.sin(Math.PI * k) * 10; // it is tossed in a little arc
        const y = offsetY + (e.y0 + (e.y1 - e.y0) * k - arc) * zoom;
        const r = 9 * zoom;
        const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
        glow.addColorStop(0, directorBriefGlow(0.55));
        glow.addColorStop(1, directorBriefGlow(0));
        ctx.fillStyle = glow;
        ctx.fillRect(x - r, y - r, r * 2, r * 2);
        const w = 6 * zoom;
        const h = 8 * zoom;
        ctx.fillStyle = DIRECTOR_BRIEF_FILL;
        ctx.fillRect(Math.round(x - w / 2), Math.round(y - h / 2), w, h);
        ctx.fillStyle = DIRECTOR_BRIEF_INK;
        for (let i = 0; i < 3; i++) {
          ctx.fillRect(Math.round(x - w / 2 + zoom), Math.round(y - h / 2 + (2 + i * 2) * zoom), w - 2 * zoom, zoom);
        }
        break;
      }
      case 'dust': {
        const cx = offsetX + e.x * zoom;
        const cy = offsetY + e.y * zoom;
        ctx.fillStyle = directorDust(0.8 * (1 - t));
        for (let i = 0; i < 14; i++) {
          const a = (i / 14) * Math.PI * 2 + hash(i, 1) * 0.4;
          const d = (6 + 16 * hash(i, 2)) * zoom * easeInOut(t) * 1.6;
          const size = (1 + hash(i, 3) * 2) * zoom;
          ctx.fillRect(Math.round(cx + Math.cos(a) * d), Math.round(cy + Math.sin(a) * d * 0.5 - t * 6 * zoom), size, size);
        }
        break;
      }
      case 'flash': {
        ctx.fillStyle = directorFlash(0.85 * (1 - t) * (1 - t));
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        break;
      }
      case 'bolt': {
        if (t > 0.6) break;
        const x1 = offsetX + e.x * zoom;
        const y1 = offsetY + e.y * zoom;
        const flicker = 0.5 + 0.5 * Math.abs(Math.sin(e.age * 90));
        ctx.strokeStyle = directorBolt(0.95 * flicker * (1 - t / 0.6));
        ctx.lineWidth = Math.max(2, 2.5 * zoom);
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(x1 + 60 * zoom * (hash(0, 7) - 0.5), 0);
        const steps = 9;
        for (let i = 1; i <= steps; i++) {
          const k = i / steps;
          const jitter = (hash(i, 11) - 0.5) * 40 * zoom * (1 - k);
          ctx.lineTo(x1 + jitter, y1 * k);
        }
        ctx.stroke();
        const r = 22 * zoom;
        const glow = ctx.createRadialGradient(x1, y1, 0, x1, y1, r);
        glow.addColorStop(0, directorBolt(0.6 * flicker));
        glow.addColorStop(1, directorBolt(0));
        ctx.fillStyle = glow;
        ctx.fillRect(x1 - r, y1 - r, r * 2, r * 2);
        break;
      }
      case 'confetti': {
        const cx = offsetX + e.x * zoom;
        const cy = offsetY + e.y * zoom;
        for (let i = 0; i < 40; i++) {
          const vx = (hash(i, 21) - 0.5) * 120;
          const vy = -60 - hash(i, 22) * 70;
          const age = e.age;
          const px = cx + vx * age * zoom;
          const py = cy + (vy * age + 110 * age * age) * zoom;
          const size = (1.5 + hash(i, 23) * 1.5) * zoom;
          ctx.globalAlpha = Math.min(1, (e.duration - age) / 0.6);
          ctx.fillStyle = DIRECTOR_CONFETTI[i % DIRECTOR_CONFETTI.length];
          ctx.fillRect(Math.round(px), Math.round(py), size, size * (0.6 + Math.abs(Math.sin(age * 9 + i))));
        }
        break;
      }
    }
    ctx.restore();
  }
}
