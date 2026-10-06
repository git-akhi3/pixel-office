/**
 * The active theme pack, read from the layout (`layout.theme`). A theme swaps presentation only:
 * spawn/despawn effects, speech bubbles and how transient sub-agents are drawn. Everything else
 * (rooms, residents, palettes) is ordinary layout data. Module state, like the sprite caches, so the
 * renderer — a pure function of the scene — does not need the layout threaded through it.
 */

export const THEME_AVENGERS = 'avengers';

let activeTheme: string | undefined;

export function setActiveTheme(theme: string | undefined): void {
  activeTheme = theme;
}

export function getActiveTheme(): string | undefined {
  return activeTheme;
}

export function isAvengersTheme(): boolean {
  return activeTheme === THEME_AVENGERS;
}
