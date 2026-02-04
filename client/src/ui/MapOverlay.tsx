/**
 * MapOverlay - Debug map visualization component
 * 
 * Shows an overhead view of map tiles using the MapRenderer.
 * Can be toggled with 'M' key. Z/X to zoom in/out.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { useGameStore } from '../state/store';
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

export function MapOverlay() {
  const showMapOverlay = useGameStore((s) => s.showMapOverlay);
  const toggleMapOverlay = useGameStore((s) => s.toggleMapOverlay);
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const playerPosRef = useRef({ x: 0, z: 0 });
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
    if (!showMapOverlay || !canvasRef.current) return;
    
    const canvas = canvasRef.current;
    canvas.width = 200;
    canvas.height = 200;
    
    if (!mapRenderer) {
      mapRenderer = new MapRenderer(canvas, { scale: ZOOM_LEVELS[zoomIndex] });
    }
    
    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [showMapOverlay, zoomIndex]);

  // Render loop
  const render = useCallback(() => {
    if (!showMapOverlay || !mapRenderer) return;
    
    const cache = getMapTileCache();
    const { x, z } = playerPosRef.current;
    
    // Calculate center tile
    const centerTx = Math.floor(x / (CHUNK_SIZE * VOXEL_SCALE));
    const centerTz = Math.floor(z / (CHUNK_SIZE * VOXEL_SCALE));
    
    // Request tiles if connected - match chunk stream radius
    if (connectionStatus === 'connected') {
      requestTilesAround(x, z, STREAM_RADIUS);
    }
    
    // Update renderer
    mapRenderer.setPlayerPosition(x, z);
    mapRenderer.render(cache.getAll(), centerTx, centerTz);
    
    animationRef.current = requestAnimationFrame(render);
  }, [showMapOverlay, connectionStatus]);

  // Start render loop when visible
  useEffect(() => {
    if (showMapOverlay) {
      animationRef.current = requestAnimationFrame(render);
    }
    return () => cancelAnimationFrame(animationRef.current);
  }, [showMapOverlay, render]);

  // Update player position from window (set by game)
  useEffect(() => {
    const updatePos = () => {
      // Read from global if available (set by GameCore)
      const pos = (window as unknown as { __playerPos?: { x: number; z: number } }).__playerPos;
      if (pos) {
        playerPosRef.current = pos;
      }
    };
    
    const interval = setInterval(updatePos, 100);
    return () => clearInterval(interval);
  }, []);

  if (!showMapOverlay) return null;

  return (
    <div className="fixed top-5 right-5 z-40">
      <canvas
        ref={canvasRef}
        className="rounded border border-green-500/30 bg-black/80"
        style={{ imageRendering: 'pixelated' }}
      />
    </div>
  );
}
