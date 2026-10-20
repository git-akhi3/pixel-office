import { useEffect, useRef, useState } from 'react';

import { CHARACTER_SITTING_OFFSET_PX, TOOL_OVERLAY_VERTICAL_OFFSET } from '../../constants.js';
import { characterName } from '../../embedRoster.js';
import { playDoneSound, playPermissionSound } from '../../notificationSound.js';
import { DIALOGUE_CHARS_PER_SEC } from '../engine/director.js';
import { setNightSetting } from '../engine/nightMode.js';
import type { OfficeState } from '../engine/officeState.js';
import { overlayProjection } from '../projection.js';
import { CharacterState } from '../types.js';

interface DirectorOverlayProps {
  officeState: OfficeState;
  containerRef: React.RefObject<HTMLDivElement | null>;
  zoom: number;
  panRef: React.RefObject<{ x: number; y: number }>;
  /** Lets the director cut the view's zoom (`camera zoom n`). */
  onZoomChange?: (zoom: number) => void;
}

/** Dialogue bubbles, title cards and letterbox bars for a scenario the director is playing. */
export function DirectorOverlay({
  officeState,
  containerRef,
  zoom,
  panRef,
  onZoomChange,
}: DirectorOverlayProps) {
  const [, setTick] = useState(0);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    officeState.director.onSound = (kind) => {
      void (kind === 'done' ? playDoneSound() : playPermissionSound());
    };
    let rafId = 0;
    const tick = () => {
      const d = officeState.director;
      if (d.nightRequest) {
        setNightSetting(d.nightRequest);
        d.nightRequest = null;
      }
      if (d.cameraZoom !== null && onZoomChange) {
        const device = Math.round(d.cameraZoom * (window.devicePixelRatio || 1));
        if (device !== zoomRef.current) onZoomChange(device);
      }
      setTick((n) => n + 1);
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [officeState, onZoomChange]);

  const director = officeState.director;
  const el = containerRef.current;
  if (!el) return null;
  const hasContent = director.dialogues.size > 0 || director.title || director.cinematic;
  if (!hasContent) return null;

  const project = overlayProjection(
    officeState.getLayout(),
    { width: el.clientWidth, height: el.clientHeight },
    zoom,
    panRef.current,
    window.devicePixelRatio || 1,
  );

  return (
    <>
      {director.cinematic && (
        <>
          <div
            className="absolute left-0 right-0 top-0 bg-black"
            style={{ height: '9%', pointerEvents: 'none', zIndex: 60 }}
            data-testid="letterbox"
          />
          <div
            className="absolute left-0 right-0 bottom-0 bg-black"
            style={{ height: '9%', pointerEvents: 'none', zIndex: 60 }}
          />
        </>
      )}
      {[...director.dialogues.values()].map((d) => {
        const ch = officeState.characters.get(d.id);
        if (!ch) return null;
        const x = project.toScreenX(ch.x);
        const y = project.toScreenY(
          ch.y +
            (ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0) -
            TOOL_OVERLAY_VERTICAL_OFFSET,
        );
        const shown = Math.min(d.text.length, Math.floor(d.age * DIALOGUE_CHARS_PER_SEC));
        const fade = Math.min(1, (d.duration - d.age) / 0.4);
        const name = characterName(d.id, ch, officeState.residentIds).replace(/\s*\(.*\)$/, '');
        return (
          <div
            key={d.id}
            className="absolute flex flex-col pixel-panel border-border px-10 pt-6 pb-8 -translate-x-1/2 -translate-y-full"
            style={{
              left: x,
              top: y - 30,
              width: 'max-content',
              maxWidth: 300,
              opacity: fade,
              pointerEvents: 'none',
              zIndex: 55,
            }}
            data-testid="dialogue"
            data-agent-id={d.id}
          >
            <span className="text-accent-bright leading-none mb-4" style={{ fontSize: 18 }}>
              {name}
            </span>
            <span className="relative leading-[1.35] whitespace-pre-wrap" style={{ fontSize: 22 }}>
              {/* The full text, invisible, holds the bubble's size while the words type in. */}
              <span style={{ visibility: 'hidden' }}>{d.text}</span>
              <span className="absolute left-0 top-0">{d.text.slice(0, shown)}</span>
            </span>
          </div>
        );
      })}
      {director.title && (
        <div
          className="absolute inset-0 flex items-center justify-center"
          style={{
            pointerEvents: 'none',
            zIndex: 61,
            opacity: Math.min(1, director.title.age / 0.5, (director.title.duration - director.title.age) / 0.6),
          }}
          data-testid="title-card"
        >
          <div
            className="pixel-panel border-border px-24 py-12 text-accent-bright text-center"
            style={{ fontSize: 44, letterSpacing: 2 }}
          >
            {director.title.text}
          </div>
        </div>
      )}
    </>
  );
}
