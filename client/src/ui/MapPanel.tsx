/**
 * MapPanel - Reusable map display with player markers
 *
 * Renders map tiles via MapRenderer and overlays arrow markers for the
 * local player and all remote players. Driven by storeBridge data.
 *
 * Used by both MapOverlay (small in-game minimap) and SpectatorOverlay
 * (larger lobby map panel).
 */

import { useEffect, useRef, useCallback } from 'react';
import { storeBridge } from '../state/bridge';
import { MapRenderer } from '../game/maptile/MapRenderer';
import { getMapTileCache } from '../game/maptile/mapTileCacheSingleton';
import { CHUNK_SIZE, VOXEL_SCALE, MAP_TILE_SIZE } from '@worldify/shared';

export interface MapPanelProps {
  /** Width of the map viewport in pixels */
  width: number;
  /** Height of the map viewport in pixels */
  height: number;
  /** Pixels per map-tile pixel (zoom level) */
  scale: number;
  /** Whether to show player arrow markers */
  showMarkers?: boolean;
  /** Extra class names for the outer wrapper */
  className?: string;
}

// ---- SVG arrow path shared by all markers ----
const ARROW_PATH = 'M12 2 L5 18 L12 14 L19 18 Z';

/** Create an arrow SVG element for a player marker */
function createMarkerSvg(size: number): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.style.cssText = `position:absolute;width:${size}px;height:${size}px;pointer-events:none;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.5))`;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ARROW_PATH);
  path.setAttribute('fill', '#ffffff');
  path.setAttribute('stroke', '#ffffff');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
  return svg;
}

/**
 * Reusable map panel component.
 *
 * Encapsulates MapRenderer lifecycle, render loop, and player markers.
 */
export function MapPanel({ width, height, scale, showMarkers = true, className }: MapPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const localMarkerRef = useRef<SVGSVGElement | null>(null);
  const remoteMarkersRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<MapRenderer | null>(null);
  const animRef = useRef<number>(0);

  // Create / dispose renderer when visible or scale changes
  useEffect(() => {
    if (!containerRef.current) return;
    const renderer = new MapRenderer(containerRef.current, { scale });
    renderer.setViewportSize(width, height);
    rendererRef.current = renderer;
    return () => {
      cancelAnimationFrame(animRef.current);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, [width, height, scale]);

  // Render loop
  const render = useCallback(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;

    const cache = getMapTileCache();
    const { x, z, rotation, color: localColor } = storeBridge.mapPlayerPosition;

    // Centre tile
    const centerTx = Math.floor(x / (CHUNK_SIZE * VOXEL_SCALE));
    const centerTz = Math.floor(z / (CHUNK_SIZE * VOXEL_SCALE));

    // Render tiles
    renderer.setPlayerPosition(x, z);
    renderer.render(cache.getAll(), centerTx, centerTz);

    if (showMarkers) {
      const tileWorldSize = MAP_TILE_SIZE * 0.25; // VOXEL_SCALE

      // --- Local player marker ---
      if (localMarkerRef.current) {
        const rotDeg = (-rotation * 180) / Math.PI;
        localMarkerRef.current.style.transform = `rotate(${rotDeg}deg)`;
        const path = localMarkerRef.current.querySelector('path');
        if (path) path.setAttribute('fill', localColor);
      }

      // --- Remote player markers ---
      if (remoteMarkersRef.current) {
        const others = storeBridge.mapOtherPlayers;
        const container = remoteMarkersRef.current;

        // Reconcile marker element count
        while (container.children.length < others.length) {
          container.appendChild(createMarkerSvg(18));
        }
        while (container.children.length > others.length) {
          container.removeChild(container.lastChild!);
        }

        const halfW = width / 2;
        const halfH = height / 2;

        for (let i = 0; i < others.length; i++) {
          const p = others[i];
          const dx = ((p.x - x) / tileWorldSize) * MAP_TILE_SIZE * scale;
          const dz = ((p.z - z) / tileWorldSize) * MAP_TILE_SIZE * scale;
          const rDeg = (-p.rotation * 180) / Math.PI;
          const el = container.children[i] as SVGSVGElement;

          el.style.left = `${halfW + dx - 9}px`;
          el.style.top = `${halfH + dz - 9}px`;
          el.style.transform = `rotate(${rDeg}deg)`;

          // Color
          const path = el.querySelector('path');
          if (path) path.setAttribute('fill', p.color);

          // Clip to viewport
          el.style.display = Math.abs(dx) < halfW && Math.abs(dz) < halfH ? '' : 'none';
        }
      }
    }

    animRef.current = requestAnimationFrame(render);
  }, [width, height, scale, showMarkers]);

  // Start / stop render loop
  useEffect(() => {
    animRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(animRef.current);
  }, [render]);

  return (
    <div className={className} style={{ width, height, position: 'relative' }}>
      {/* Tile canvas container */}
      <div
        ref={containerRef}
        style={{ width, height, position: 'absolute', inset: 0 }}
      />

      {showMarkers && (
        <>
          {/* Local player arrow (centred) */}
          <svg
            ref={(el) => { localMarkerRef.current = el; }}
            className="absolute pointer-events-none"
            style={{
              top: '50%',
              left: '50%',
              width: 24,
              height: 24,
              marginLeft: -12,
              marginTop: -12,
              filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))',
            }}
            viewBox="0 0 24 24"
          >
            <path
              d={ARROW_PATH}
              fill="#ffffff"
              stroke="#ffffff"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>

          {/* Remote player arrows (imperatively managed) */}
          <div
            ref={remoteMarkersRef}
            className="absolute inset-0 pointer-events-none"
          />
        </>
      )}
    </div>
  );
}
