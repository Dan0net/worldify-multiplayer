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

// Map viewport size in pixels
const MAP_VIEWPORT_SIZE = 200;

// Calculate scale to fit all tiles within VISIBILITY_RADIUS
const TILES_ACROSS = VISIBILITY_RADIUS * 2 + 1;
const FIT_ALL_SCALE = MAP_VIEWPORT_SIZE / (TILES_ACROSS * MAP_TILE_SIZE);

// Zoom levels
const ZOOM_LEVELS = [FIT_ALL_SCALE, FIT_ALL_SCALE * 2, FIT_ALL_SCALE * 4, FIT_ALL_SCALE * 8];
const DEFAULT_ZOOM_INDEX = 0;

export function MapOverlay() {
  const showMapOverlay = useGameStore((s) => s.showMapOverlay);
  const toggleMapOverlay = useGameStore((s) => s.toggleMapOverlay);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);

  // Keyboard: M toggle, Z/X zoom
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (document.activeElement?.tagName === 'INPUT') return;
      if (e.key === 'm' || e.key === 'M') toggleMapOverlay();
      else if (e.key === 'z' || e.key === 'Z') setZoomIndex((p) => Math.max(0, p - 1));
      else if (e.key === 'x' || e.key === 'X') setZoomIndex((p) => Math.min(ZOOM_LEVELS.length - 1, p + 1));
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleMapOverlay]);

  if (!showMapOverlay) return null;

  return (
    <div
      className="fixed top-5 right-5 z-40"
      style={{ filter: 'drop-shadow(0 2px 4px rgba(0,0,0,1.0))' }}
    >
      <MapPanel
        width={MAP_VIEWPORT_SIZE}
        height={MAP_VIEWPORT_SIZE}
        scale={ZOOM_LEVELS[zoomIndex]}
        showMarkers
        className="rounded overflow-hidden"
      />
    </div>
  );
}
