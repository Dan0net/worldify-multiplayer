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
import { CHUNK_SIZE, VOXEL_SCALE, VISIBILITY_RADIUS, MAP_TILE_SIZE } from '@worldify/shared';

// Singleton instances managed by this component
let mapTileCache: MapTileCache | null = null;
let mapRenderer: MapRenderer | null = null;

// Map viewport size in pixels
const MAP_VIEWPORT_SIZE = 200;

// Calculate scale to fit all tiles in VISIBILITY_RADIUS
// tiles across = VISIBILITY_RADIUS * 2 + 1 (e.g., 8 * 2 + 1 = 17)
const TILES_ACROSS = VISIBILITY_RADIUS * 2 + 1;
const FIT_ALL_SCALE = MAP_VIEWPORT_SIZE / (TILES_ACROSS * MAP_TILE_SIZE);

// Zoom levels - start with scale that fits all visible tiles
const ZOOM_LEVELS = [FIT_ALL_SCALE, FIT_ALL_SCALE * 2, FIT_ALL_SCALE * 4, FIT_ALL_SCALE * 8];
const DEFAULT_ZOOM_INDEX = 0; // Start at scale that shows all tiles

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
 * Player marker SVG component.
 * Uses a ref for rotation updates to avoid React re-renders.
 */
function PlayerMarker({ markerRef, color = '#4488ff' }: { markerRef: React.RefObject<SVGSVGElement>; color?: string }) {
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
        fill={color}
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
  
  const containerRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<SVGSVGElement>(null);
  const remoteMarkersRef = useRef<HTMLDivElement>(null);
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
      mapRenderer.setViewportSize(MAP_VIEWPORT_SIZE, MAP_VIEWPORT_SIZE);
    }
    
    return () => {
      cancelAnimationFrame(animationRef.current);
      // Dispose renderer so a fresh one is created for the new container div
      // (the container is removed from DOM when the component unmounts)
      if (mapRenderer) {
        mapRenderer.dispose();
        mapRenderer = null;
      }
    };
  }, [showMapOverlay, zoomIndex]);

  // Render loop - reads from storeBridge, updates canvas and marker rotation
  const render = useCallback(() => {
    if (!showMapOverlay || !mapRenderer) return;
    
    const cache = getMapTileCache();
    
    // Read player position from storeBridge (updated by GameCore)
    const { x, z, rotation, color: localColor } = storeBridge.mapPlayerPosition;
    
    // Calculate center tile
    const centerTx = Math.floor(x / (CHUNK_SIZE * VOXEL_SCALE));
    const centerTz = Math.floor(z / (CHUNK_SIZE * VOXEL_SCALE));
    
    // Update renderer and render tiles (tiles arrive passively via VoxelWorld)
    mapRenderer.setPlayerPosition(x, z);
    mapRenderer.render(cache.getAll(), centerTx, centerTz);
    
    // Update marker rotation and color imperatively (no React re-render)
    if (markerRef.current) {
      // Convert from game rotation (radians, 0 = +Z) to SVG rotation (degrees, 0 = up)
      // Negate because game yaw increases counter-clockwise, CSS rotates clockwise
      const rotationDeg = (-rotation * 180) / Math.PI;
      markerRef.current.style.transform = `rotate(${rotationDeg}deg)`;
      // Update color to match player skin
      const path = markerRef.current.querySelector('path');
      if (path) path.setAttribute('fill', localColor);
    }

    // Update remote player markers
    if (remoteMarkersRef.current) {
      const otherPlayers = storeBridge.mapOtherPlayers;
      const container = remoteMarkersRef.current;
      const tileWorldSize = MAP_TILE_SIZE * 0.25; // VOXEL_SCALE
      const scale = ZOOM_LEVELS[zoomIndex];

      // Ensure we have the right number of marker elements
      while (container.children.length < otherPlayers.length) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.style.cssText = 'position:absolute;width:18px;height:18px;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))';
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 2 L5 18 L12 14 L19 18 Z');
        path.setAttribute('fill', '#ff4444');
        path.setAttribute('stroke', '#ffffff');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('stroke-linejoin', 'round');
        svg.appendChild(path);
        container.appendChild(svg);
      }
      while (container.children.length > otherPlayers.length) {
        container.removeChild(container.lastChild!);
      }

      // Position each remote marker relative to local player (map center)
      for (let i = 0; i < otherPlayers.length; i++) {
        const p = otherPlayers[i];
        const dx = (p.x - x) / tileWorldSize * MAP_TILE_SIZE * scale;
        const dz = (p.z - z) / tileWorldSize * MAP_TILE_SIZE * scale;
        const rDeg = (-p.rotation * 180) / Math.PI;
        const el = container.children[i] as SVGSVGElement;
        // Center of map is MAP_VIEWPORT_SIZE/2; offset by -9 (half of 18px icon)
        const half = MAP_VIEWPORT_SIZE / 2;
        el.style.left = `${half + dx - 9}px`;
        el.style.top = `${half + dz - 9}px`;
        el.style.transform = `rotate(${rDeg}deg)`;
        // Update color to match player skin
        const path = el.querySelector('path');
        if (path) path.setAttribute('fill', p.color);
        // Hide if outside viewport
        const visible = Math.abs(dx) < half && Math.abs(dz) < half;
        el.style.display = visible ? '' : 'none';
      }
    }
    
    animationRef.current = requestAnimationFrame(render);
  }, [showMapOverlay, zoomIndex]);

  // Start render loop when visible
  useEffect(() => {
    if (showMapOverlay) {
      animationRef.current = requestAnimationFrame(render);
    }
    return () => cancelAnimationFrame(animationRef.current);
  }, [showMapOverlay, render]);

  if (!showMapOverlay) return null;

  return (
    <div className="fixed top-5 right-5 z-40" style={{ position: 'fixed', filter: 'drop-shadow(0 2px 4px rgba(0, 0, 0, 1.0))' }}>
      <div className="relative">
        <div
          ref={containerRef}
          className="rounded overflow-hidden"
          style={{ width: MAP_VIEWPORT_SIZE, height: MAP_VIEWPORT_SIZE, position: 'relative' }}
        />
        <PlayerMarker markerRef={markerRef} color="#4488ff" />
        {/* Container for remote player markers (imperatively managed) */}
        <div ref={remoteMarkersRef} className="absolute inset-0 pointer-events-none" />
      </div>
    </div>
  );
}
