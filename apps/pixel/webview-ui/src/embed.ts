/**
 * Embedded view (`?embed`), used when another page shows the office in an iframe: no toolbars,
 * and the whole office scaled to the frame instead of manual zoom and pan.
 *
 * The renderer needs an integer zoom (device pixels per sprite pixel) to stay pixel-perfect, so
 * the office renders at the largest integer zoom that fits and the result is scaled the rest of
 * the way with CSS (image-rendering: pixelated). `fit=contain` (default) shows the whole office;
 * `fit=cover` fills the frame and crops the edges.
 */

export type EmbedFit = 'contain' | 'cover';

export interface EmbedMode {
  fit: EmbedFit;
}

export function readEmbedMode(search: string): EmbedMode | null {
  const params = new URLSearchParams(search);
  if (!params.has('embed')) return null;
  return { fit: params.get('fit') === 'cover' ? 'cover' : 'contain' };
}

export interface FitView {
  /** Integer render zoom (device pixels per sprite pixel). */
  zoom: number;
  /** CSS size of the rendered office before scaling. */
  width: number;
  height: number;
  /** CSS scale applied on top, so the office fills the box. */
  scale: number;
}

/**
 * Scale for character labels inside the scaled view, so that on screen they shrink with the scene
 * on small frames (phones), never below 60% so they stay readable, and keep their normal size once
 * the scene is at least 900 px wide.
 */
export function labelScaleFor(view: FitView, fullSizeWidth = 900, minimum = 0.6): number {
  const onScreen = Math.max(minimum, Math.min(1, (view.width * view.scale) / fullSizeWidth));
  return onScreen / view.scale;
}

export function fitView(
  mapWidth: number,
  mapHeight: number,
  boxWidth: number,
  boxHeight: number,
  dpr: number,
  fit: EmbedFit,
): FitView {
  const pick = fit === 'cover' ? Math.max : Math.min;
  const ratio = pick((boxWidth * dpr) / mapWidth, (boxHeight * dpr) / mapHeight);
  const zoom = Math.max(1, Math.floor(ratio));
  const width = (mapWidth * zoom) / dpr;
  const height = (mapHeight * zoom) / dpr;
  const scale = pick(boxWidth / width, boxHeight / height);
  return { zoom, width, height, scale: Number.isFinite(scale) && scale > 0 ? scale : 1 };
}
