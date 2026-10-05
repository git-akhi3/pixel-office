import { describe, expect, it } from 'vitest';

import { fitView, labelScaleFor, readEmbedMode } from '../src/embed.js';

describe('readEmbedMode', () => {
  it('is off without ?embed and defaults to showing the whole office', () => {
    expect(readEmbedMode('')).toBeNull();
    expect(readEmbedMode('?token=abc')).toBeNull();
    expect(readEmbedMode('?embed')).toEqual({ fit: 'contain' });
    expect(readEmbedMode('?embed=1&fit=cover')).toEqual({ fit: 'cover' });
    expect(readEmbedMode('?embed&fit=bogus')).toEqual({ fit: 'contain' });
  });
});

describe('fitView', () => {
  // A 40x30-tile office (640x480 sprite pixels).
  const W = 640;
  const H = 480;

  it('renders at the largest integer zoom that fits, then scales the rest of the way', () => {
    const v = fitView(W, H, 1000, 800, 2, 'contain');
    expect(v.zoom).toBe(3); // 2000/640 = 3.1, 1600/480 = 3.3
    expect(v.width).toBe(960); // 640 * 3 / 2 CSS px
    expect(v.height).toBe(720);
    expect(v.width * v.scale).toBeCloseTo(1000); // fills the limiting side exactly
    expect(v.height * v.scale).toBeLessThanOrEqual(800);
  });

  it('fills both sides with cover (cropping the overflow)', () => {
    const v = fitView(W, H, 1000, 800, 2, 'cover');
    expect(v.width * v.scale).toBeGreaterThanOrEqual(1000 - 1e-9);
    expect(v.height * v.scale).toBeCloseTo(800);
  });

  it('works on a tall phone and on a tiny frame', () => {
    const phone = fitView(W, H, 375, 700, 3, 'contain');
    expect(Number.isInteger(phone.zoom)).toBe(true);
    expect(phone.width * phone.scale).toBeCloseTo(375);
    const tiny = fitView(W, H, 100, 80, 1, 'contain');
    expect(tiny.zoom).toBe(1); // never below 1; CSS scales it down
    expect(tiny.width * tiny.scale).toBeCloseTo(100);
  });
});

describe('labelScaleFor', () => {
  it('keeps labels normal size on big frames and shrinks them with the scene on phones', () => {
    const desktop = fitView(640, 480, 1200, 900, 2, 'contain');
    expect(labelScaleFor(desktop) * desktop.scale).toBeCloseTo(1);
    const phone = fitView(640, 480, 375, 700, 3, 'contain');
    expect(labelScaleFor(phone) * phone.scale).toBeCloseTo(0.6); // never below 60%, to stay readable
  });
});
