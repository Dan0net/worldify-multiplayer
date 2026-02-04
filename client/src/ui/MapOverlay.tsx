/**
 * MapOverlay - Debug map visualization component
 * 
 * Shows an overhead view of map tiles using the MapRenderer.
 * Can be toggled with 'M' key. Z/X to zoom in/out.
 * 
 * Player marker is an SVG element for smooth rotation updates
 * without canvas re-rendering.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useGameStore } from '../state/store';
import { storeBridge } from '../state/bridge';
import { MapRenderer } from '../game/maptile/MapRenderer';
import { MapTileCache } from '../game/maptile/MapTileCache';
import { CHUNK_SIZE, VOXEL_SCALE, STREAM_RADIUS, encodeMapTileRequest } from '@worldify/shared';
import { sendBinary } from '../net/netClient';

// Singleton instances managed by this component
let mapTileCache: MapTileCache | null = null;
let mapRenderer: MapRenderer | null = null;

// Track requested tiles to avoid duplicate requests
const requestedTiles = new Set<string>();

// Zoom levels (scale values)
const ZOOM_LEVELS = [0.5, 1, 2, 4];
const DEFAULT_ZOOM_INDEX = 1; // scale = 1

/**
 * Get the global map tile cache instance.
 */
export function getMapTileCache(): MapTileCache {
  if (!mapTileCache) {
    mapTileCache = new MapTileCache();
  }
  return mapTileCache;
}

/**
 * Request tiles around a position.
 */
function requestTilesAround(worldX: number, worldZ: number, radius: number): void {
  const centerTx = Math.floor(worldX / (CHUNK_SIZE * VOXEL_SCALE));
  const centerTz = Math.floor(worldZ / (CHUNK_SIZE * VOXEL_SCALE));
  
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const tx = centerTx + dx;
      const tz = centerTz + dz;
      const key = `${tx},${tz}`;
      
      // Skip if already requested or cached
      if (requestedTiles.has(key)) continue;
      if (getMapTileCache().has(tx, tz)) continue;
      
      requestedTiles.add(key);
      sendBinary(encodeMapTileRequest({ tx, tz }));
    }
  }
}

/**
 * Player marker SVG component.
 * Uses a ref for rotation updates to avoid React re-renders.
 */
function PlayerMarker({ markerRef }: { markerRef: React.RefObject<SVGSVGElement> }) {
  return (
    <svg
      ref={markerRef as React.LegacyRef<SVGSVGElement>}
      className="absolute pointer-events-none"
      style={{
        top: '50%',
        left: '50%',
        width: 24,
        height: 24,
        marginLeft: -12,
        marginTop: -12,
        filter: 'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.5))',
      }}
      viewBox="0 0 24 24"
    >
      {/* Arrow pointing up (will be rotated) */}
      <path
        d="M12 2 L5 18 L12 14 L19 18 Z"
        fill="#ff4444"
        stroke="#ffffff"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function MapOverlay() {
  const showMapOverlay = useGameStore((s) => s.showMapOverlay);
  const toggleMapOverlay = useGameStore((s) => s.toggleMapOverlay);
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  
  const containerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<SVGSVGElement>(null);
  const animationRef = useRef<number>(0);
  const [zoomIndex, setZoomIndex] = useState(DEFAULT_ZOOM_INDEX);

  // Handle keyboard toggle and zoom
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't handle if typing in an input
      if (document.activeElement?.tagName === 'INPUT') return;
      
      if (e.key === 'm' || e.key === 'M') {
        toggleMapOverlay();
      } else if (e.key === 'z' || e.key === 'Z') {
        // Zoom out (decrease scale)
        setZoomIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === 'x' || e.key === 'X') {
        // Zoom in (increase scale)
        setZoomIndex((prev) => Math.min(ZOOM_LEVELS.length - 1, prev + 1));
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleMapOverlay]);

  // Update renderer scale when zoom changes
  useEffect(() => {
    if (mapRenderer) {
      mapRenderer.setConfig({ scale: ZOOM_LEVELS[zoomIndex] });
    }
  }, [zoomIndex]);

  // Initialize renderer when overlay is shown
  useEffect(() => {
    if (!showMapOverlay || !containerRef.current) return;
    
    const container = containerRef.current;
    
    if (!mapRenderer) {
      mapRenderer = new MapRenderer(container, { scale: ZOOM_LEVELS[zoomIndex] });
      mapRenderer.setViewportSize(200, 200);
    }
    
    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [showMapOverlay, zoomIndex]);

  // Render loop - reads from storeBridge, updates canvas and marker rotation
  const render = useCallback(() => {
    if (!showMapOverlay || !mapRenderer) return;
    
    const cache = getMapTileCache();
    
    // Read player position from storeBridge (updated by GameCore)
    const { x, z, rotation } = storeBridge.mapPlayerPosition;
    
    // Calculate center tile
    const centerTx = Math.floor(x / (CHUNK_SIZE * VOXEL_SCALE));
    const centerTz = Math.floor(z / (CHUNK_SIZE * VOXEL_SCALE));
    
    // Request tiles if connected - match chunk stream radius
    if (connectionStatus === 'connected') {
      requestTilesAround(x, z, STREAM_RADIUS);
    }
    
    // Update renderer and render tiles
    mapRenderer.setPlayerPosition(x, z);
    mapRenderer.render(cache.getAll(), centerTx, centerTz);
    
    // Update marker rotation imperatively (no React re-render)
    if (markerRef.current) {
      // Convert from game rotation (radians, 0 = +Z) to SVG rotation (degrees, 0 = up)
      // Negate because game yaw increases counter-clockwise, CSS rotates clockwise
      const rotationDeg = (-rotation * 180) / Math.PI;
      markerRef.current.style.transform = `rotate(${rotationDeg}deg)`;
    }
    
    animationRef.current = requestAnimationFrame(render);
  }, [showMapOverlay, connectionStatus]);

  // Start render loop when visible
  useEffect(() => {
    if (showMapOverlay) {
      animationRef.current = requestAnimationFrame(render);
    }
    return () => cancelAnimationFrame(animationRef.current);
  }, [showMapOverlay, render]);

  if (!showMapOverlay) return null;

  return (
    <div className="fixed top-5 right-5 z-40" style={{ position: 'fixed' }}>
      <div className="relative">
        <div
          ref={containerRef}
          className="rounded border border-green-500/30 bg-black/80 overflow-hidden"
          style={{ width: 200, height: 200, position: 'relative' }}
        />
        <PlayerMarker markerRef={markerRef} />
      </div>
    </div>
  );
}
