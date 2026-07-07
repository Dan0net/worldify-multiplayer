/**
 * MapOverlay - In-game minimap (top-right corner)
 *
 * Toggle with 'M' key. Zoom with Z / X.
 * All map rendering and player markers are handled by MapPanel.
 */

import { useEffect, useState } from 'react';
import { useGameStore } from '../state/store';
import { MapPanel } from './MapPanel';
import { VISIBILITY_RADIUS, MAP_TILE_SIZE } from '@worldify/shared';
import { useIsTouch } from './useDeviceMode';

// Map viewport size in pixels (smaller on mobile)
const MAP_VIEWPORT_SIZE = 200;
const MAP_VIEWPORT_SIZE_MOBILE = 120;

// Calculate scale to fit all tiles within VISIBILITY_RADIUS
const TILES_ACROSS = VISIBILITY_RADIUS * 2 + 1;
const DEFAULT_ZOOM_INDEX = 0;

export function MapOverlay() {
  const showMapOverlay = useGameStore((s) => s.showMapOverlay);
  const toggleMapOverlay = useGameStore((s) => s.toggleMapOverlay);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);
  const isTouch = useIsTouch();

  const size = isTouch ? MAP_VIEWPORT_SIZE_MOBILE : MAP_VIEWPORT_SIZE;
  const fitScale = size / (TILES_ACROSS * MAP_TILE_SIZE);
  const zoomLevels = [fitScale, fitScale * 2, fitScale * 4, fitScale * 8];

  // Keyboard: M toggle, Z/X zoom
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') toggleMapOverlay();
      else if (e.key === 'z' || e.key === 'Z') setZoomIndex((p) => Math.max(0, p - 1));
      else if (e.key === 'x' || e.key === 'X') setZoomIndex((p) => Math.min(3, p + 1));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleMapOverlay]);

  if (!showMapOverlay) return null;

  return (
    <div
      className="absolute top-2 right-2 md:top-5 md:right-5"
    >
      <MapPanel
        width={size}
        height={size}
        scale={zoomLevels[zoomIndex]}
        showMarkers
        className="rounded-full overflow-hidden"
      />
    </div>
  );
}
