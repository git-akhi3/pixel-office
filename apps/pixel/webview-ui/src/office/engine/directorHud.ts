/**
 * The director's HUD drawn straight onto the canvas while a recording runs: the name tags, the
 * dialogue bubbles, title cards and letterbox bars that the DOM overlays show in a live session.
 * The recorder reads frames from the canvas (no compositor screenshots), so everything the video
 * needs has to be on it. Mirrors ToolOverlay / DirectorOverlay closely enough to pass for them.
 */

import {
  CHARACTER_SITTING_OFFSET_PX,
  HUD_ACCENT,
  HUD_BLACK,
  HUD_FONT,
  HUD_PANEL_BG,
  HUD_PANEL_BORDER,
  HUD_TEXT,
  TOOL_OVERLAY_VERTICAL_OFFSET,
} from '../../constants.js';
import type { Character } from '../types.js';
import { CharacterState } from '../types.js';
import { DIALOGUE_CHARS_PER_SEC, type Director } from './director.js';

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, k: number): void {
  ctx.fillStyle = HUD_PANEL_BORDER;
  ctx.fillRect(x - 2 * k, y - 2 * k, w + 4 * k, h + 4 * k);
  ctx.fillStyle = HUD_PANEL_BG;
  ctx.fillRect(x, y, w, h);
}

function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function shortName(label: string): string {
  return label.replace(/\s*\(.*\)$/, '');
}

export function renderDirectorHud(
  ctx: CanvasRenderingContext2D,
  director: Director,
  characters: readonly Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
  canvasWidth: number,
  canvasHeight: number,
  dpr: number,
): void {
  const k = Math.max(2, dpr); // CSS px -> device px; at least 2x so a 1080p recording reads like a Retina screen
  const anchor = (ch: Character) => ({
    x: offsetX + ch.x * zoom,
    y:
      offsetY +
      (ch.y + (ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0) - TOOL_OVERLAY_VERTICAL_OFFSET) *
        zoom,
  });
  ctx.save();
  ctx.textBaseline = 'top';

  // Name tags (and the task line) for heroes who are not speaking.
  for (const ch of characters) {
    if (!ch.isResident || ch.matrixEffect || director.dialogues.has(ch.id)) continue;
    const name = ch.label ?? ch.agentName ?? '';
    if (!name) continue;
    const { x, y } = anchor(ch);
    const working = ch.isActive && ch.directedTask ? ch.directedTask : null;
    ctx.font = `${(working ? 9 : 8) * k}px ${HUD_FONT}`;
    const nameW = ctx.measureText(name).width;
    ctx.font = `${11 * k}px ${HUD_FONT}`;
    const taskW = working ? ctx.measureText(working).width : 0;
    const w = Math.max(nameW, taskW) + 10 * k;
    const h = working ? 28 * k : 13 * k;
    const left = Math.round(x - w / 2);
    const top = Math.round(y - h);
    ctx.globalAlpha = working ? 0.95 : 0.6;
    panel(ctx, left, top, w, h, k);
    ctx.globalAlpha = 1;
    ctx.fillStyle = working ? HUD_ACCENT : HUD_TEXT;
    ctx.font = `${(working ? 9 : 8) * k}px ${HUD_FONT}`;
    ctx.fillText(name, left + 5 * k, top + 2 * k);
    if (working) {
      ctx.fillStyle = HUD_TEXT;
      ctx.font = `${11 * k}px ${HUD_FONT}`;
      ctx.fillText(working, left + 5 * k, top + 13 * k);
    }
  }

  // Dialogue bubbles.
  const barPx = director.cinematic ? canvasHeight * 0.09 : 0;
  for (const d of director.dialogues.values()) {
    const ch = characters.find((c) => c.id === d.id);
    if (!ch) continue;
    const { x, y } = anchor(ch);
    const shown = Math.min(d.text.length, Math.floor(d.age * DIALOGUE_CHARS_PER_SEC));
    ctx.font = `${11 * k}px ${HUD_FONT}`;
    const lines = wrap(ctx, d.text, 150 * k);
    const textW = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const w = textW + 10 * k;
    const h = (9 + lines.length * 15 + 4) * k;
    const below = y - 15 * k - h < barPx + 4 * k;
    const left = Math.round(Math.max(4 * k, Math.min(canvasWidth - w - 4 * k, x - w / 2)));
    const top = Math.round(below ? y + 35 * k : y - 15 * k - h);
    ctx.globalAlpha = Math.min(1, (d.duration - d.age) / 0.4);
    panel(ctx, left, top, w, h, k);
    ctx.fillStyle = HUD_ACCENT;
    ctx.font = `${9 * k}px ${HUD_FONT}`;
    ctx.fillText(shortName(ch.label ?? ch.agentName ?? ''), left + 5 * k, top + 3 * k);
    ctx.fillStyle = HUD_TEXT;
    ctx.font = `${11 * k}px ${HUD_FONT}`;
    let remaining = shown;
    lines.forEach((line, i) => {
      const part = line.slice(0, Math.max(0, remaining));
      remaining -= line.length + 1;
      ctx.fillText(part, left + 5 * k, top + (13 + i * 15) * k);
    });
    ctx.globalAlpha = 1;
  }

  // Letterbox bars.
  if (director.cinematic) {
    ctx.fillStyle = HUD_BLACK;
    ctx.fillRect(0, 0, canvasWidth, barPx);
    ctx.fillRect(0, canvasHeight - barPx, canvasWidth, barPx);
  }

  // Title card.
  if (director.title) {
    const t = director.title;
    ctx.globalAlpha = Math.min(1, t.age / 0.5, (t.duration - t.age) / 0.6);
    ctx.font = `${22 * k}px ${HUD_FONT}`;
    const w = ctx.measureText(t.text).width + 24 * k;
    const h = 40 * k;
    const left = Math.round(canvasWidth / 2 - w / 2);
    const top = Math.round(canvasHeight / 2 - h / 2);
    panel(ctx, left, top, w, h, k);
    ctx.fillStyle = HUD_ACCENT;
    ctx.fillText(t.text, left + 12 * k, top + 9 * k);
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
