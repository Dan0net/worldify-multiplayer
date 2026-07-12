/**
 * MapOverlay — in-game minimap + menu button, as one integrated top-right cluster.
 *
 * The minimap is framed (ring + backdrop) so it reads as a deliberate element, and
 * the mobile menu (X) button sits directly above it in the same cluster so the two
 * no longer overlap. The map is locked to the render distance: it always frames
 * exactly the visibility radius (fully populated as chunks stream in), so there's
 * no zoom drift or blank edges. Toggle the map with 'M'.
 */

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useGameStore } from '../state/store';
import { GameMode, VISIBILITY_RADIUS, MAP_TILE_SIZE } from '@worldify/shared';
import { MapPanel } from './MapPanel';
import { useIsTouch } from './useDeviceMode';
import { exitFullscreenIfActive } from './fullscreen';

const MAP_VIEWPORT_SIZE = 200;
const MAP_VIEWPORT_SIZE_MOBILE = 120;

// Scale so the full render distance (visibility diameter) fills the viewport.
const TILES_ACROSS = VISIBILITY_RADIUS * 2 + 1;

export function MapOverlay() {
  const showMapOverlay = useGameStore((s) => s.showMapOverlay);
  const setGameMode = useGameStore((s) => s.setGameMode);
  const isTouch = useIsTouch();

  const size = isTouch ? MAP_VIEWPORT_SIZE_MOBILE : MAP_VIEWPORT_SIZE;
  // Locked to render distance — no zoom levels.
  const scale = size / (TILES_ACROSS * MAP_TILE_SIZE);

  const toggleMapOverlay = useGameStore((s) => s.toggleMapOverlay);

  // Keyboard: M toggles the map (desktop). Zoom is retired — the map is locked
  // to the render distance.
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
      className="absolute top-2 right-2 md:top-5 md:right-5 flex flex-col items-end gap-2"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingRight: 'env(safe-area-inset-right)' }}
    >
      {/* Menu (X) button — touch only; matches the map's framing. */}
      {isTouch && (
        <button
          onPointerDown={(e) => { e.preventDefault(); openMenu(); }}
          aria-label="Menu"
          className="pointer-events-auto w-11 h-11 flex items-center justify-center rounded-full
            bg-black/55 ring-1 ring-white/25 text-white shadow-lg active:scale-90 transition-transform"
        >
          <X size={22} strokeWidth={2.4} />
        </button>
      )}

      {/* Framed minimap. */}
      {showMapOverlay && (
        <div className="rounded-full ring-1 ring-white/25 bg-black/40 shadow-lg overflow-hidden">
          <MapPanel width={size} height={size} scale={scale} showMarkers className="rounded-full overflow-hidden" />
        </div>
      )}
    </div>
  );
}
