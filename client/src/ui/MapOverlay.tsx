/**
 * MapOverlay — in-game minimap + menu button, as one integrated top-right cluster.
 *
 * The minimap is framed (ring + backdrop) and locked to the *current* render
 * distance: it zooms to `quality.visibilityRadius` so the loaded tiles always fill
 * it. The mobile menu (X) button sits in the top-right corner of the map's bounding
 * square, on top of the circle (the corner is outside the circle, so the map never
 * covers it) — so the cluster is exactly one map tall and no longer overlaps the
 * R-pad in landscape. Toggle the map with 'M'.
 */

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useGameStore } from '../state/store';
import { GameMode, MAP_TILE_SIZE } from '@worldify/shared';
import { MapPanel } from './MapPanel';
import { useIsTouch } from './useDeviceMode';
import { exitFullscreenIfActive } from './fullscreen';

const MAP_SIZE_DESKTOP = 180;
const MAP_SIZE_MOBILE = 92;

export function MapOverlay() {
  const showMapOverlay = useGameStore((s) => s.showMapOverlay);
  const toggleMapOverlay = useGameStore((s) => s.toggleMapOverlay);
  const setGameMode = useGameStore((s) => s.setGameMode);
  // Live view distance — the map zooms so the loaded tiles fill it.
  const visibilityRadius = useGameStore((s) => s.quality.visibilityRadius);
  const isTouch = useIsTouch();

  const size = isTouch ? MAP_SIZE_MOBILE : MAP_SIZE_DESKTOP;
  const tilesAcross = visibilityRadius * 2 + 1;
  const scale = size / (tilesAcross * MAP_TILE_SIZE);

  // Keyboard: M toggles the map (desktop). Zoom is retired (locked to render distance).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') toggleMapOverlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleMapOverlay]);

  const openMenu = () => {
    exitFullscreenIfActive();
    setGameMode(GameMode.Explore);
  };

  return (
    <div
      className="absolute top-2 right-2 md:top-5 md:right-5"
      style={{ width: size, height: size, paddingTop: 'env(safe-area-inset-top)', paddingRight: 'env(safe-area-inset-right)' }}
    >
      <div className="relative" style={{ width: size, height: size }}>
        {/* Framed minimap (base layer). */}
        {showMapOverlay && (
          <div className="absolute inset-0 rounded-full ring-1 ring-white/25 bg-black/40 shadow-lg overflow-hidden">
            <MapPanel width={size} height={size} scale={scale} showMarkers className="rounded-full overflow-hidden" />
          </div>
        )}

        {/* Menu (X) button — touch only; top-right corner of the box, above the map. */}
        {isTouch && (
          <button
            onPointerDown={(e) => { e.preventDefault(); openMenu(); }}
            aria-label="Menu"
            className="pointer-events-auto absolute top-0 right-0 z-10 w-8 h-8 flex items-center justify-center rounded-full
              bg-black/60 ring-1 ring-white/30 text-white shadow-lg active:scale-90 transition-transform"
          >
            <X size={18} strokeWidth={2.6} />
          </button>
        )}
      </div>
    </div>
  );
}
