/**
 * MapOverlay - Debug map visualization component
 * 
 * Shows an overhead view of map tiles using the MapRenderer.
 * Can be toggled with 'M' key.
 */

import { useEffect, useRef, useCallback } from 'react';
import { useGameStore } from '../state/store';
import { MapRenderer } from '../game/maptile/MapRenderer';
import { MapTileCache } from '../game/maptile/MapTileCache';
import { CHUNK_SIZE, VOXEL_SCALE, encodeMapTileRequest } from '@worldify/shared';
import { sendBinary } from '../net/netClient';

// Singleton instances managed by this component
let mapTileCache: MapTileCache | null = null;
let mapRenderer: MapRenderer | null = null;

// Track requested tiles to avoid duplicate requests
const requestedTiles = new Set<string>();

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
  const setMapTileCount = useGameStore((s) => s.setMapTileCount);
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const playerPosRef = useRef({ x: 0, z: 0 });

  // Handle keyboard toggle
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'm' || e.key === 'M') {
        // Don't toggle if typing in an input
        if (document.activeElement?.tagName === 'INPUT') return;
        toggleMapOverlay();
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleMapOverlay]);

  // Initialize renderer when overlay is shown
  useEffect(() => {
    if (!showMapOverlay || !canvasRef.current) return;
    
    const canvas = canvasRef.current;
    canvas.width = 400;
    canvas.height = 400;
    
    if (!mapRenderer) {
      mapRenderer = new MapRenderer(canvas, { scale: 4 });
    }
    
    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [showMapOverlay]);

  // Render loop
  const render = useCallback(() => {
    if (!showMapOverlay || !mapRenderer) return;
    
    const cache = getMapTileCache();
    const { x, z } = playerPosRef.current;
    
    // Calculate center tile
    const centerTx = Math.floor(x / (CHUNK_SIZE * VOXEL_SCALE));
    const centerTz = Math.floor(z / (CHUNK_SIZE * VOXEL_SCALE));
    
    // Request tiles if connected
    if (connectionStatus === 'connected') {
      requestTilesAround(x, z, 5);
    }
    
    // Update renderer
    mapRenderer.setPlayerPosition(x, z);
    mapRenderer.render(cache.getAll(), centerTx, centerTz);
    
    // Update store with tile count
    setMapTileCount(cache.size);
    
    animationRef.current = requestAnimationFrame(render);
  }, [showMapOverlay, connectionStatus, setMapTileCount]);

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
    <div className="fixed top-20 right-5 z-40 bg-black/80 rounded-lg p-2 border border-green-500/30">
      <div className="flex justify-between items-center mb-2 px-1">
        <span className="text-green-400 text-sm font-bold">Map</span>
        <button
          onClick={toggleMapOverlay}
          className="text-gray-400 hover:text-white text-sm"
        >
          ✕
        </button>
      </div>
      <canvas
        ref={canvasRef}
        className="rounded"
        style={{ imageRendering: 'pixelated' }}
      />
      <div className="text-green-400/60 text-xs mt-1 text-center">
        Tiles: {useGameStore.getState().mapTileCount} | Press M to toggle
      </div>
    </div>
  );
}
