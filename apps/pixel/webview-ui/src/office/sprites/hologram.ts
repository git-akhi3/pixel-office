/**
 * Hologram rendering for transient sub-agents in the Avengers theme: the parent's sprite tinted cyan
 * by luminance, with darker scanlines every other row. Cached per source sprite, like the outlines.
 */

import { hologramColor } from '../../constants.js';
import type { SpriteData } from '../types.js';

const hologramCache = new WeakMap<SpriteData, SpriteData>();

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

export function getHologramSprite(sprite: SpriteData): SpriteData {
  const cached = hologramCache.get(sprite);
  if (cached) return cached;
  const out = sprite.map((row, y) =>
    row.map((px) => (px && px.length >= 7 ? hologramColor(luminance(px), y % 2 === 1) : px)),
  );
  hologramCache.set(sprite, out);
  return out;
}
