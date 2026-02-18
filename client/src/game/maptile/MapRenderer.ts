/**
 * MapRenderer - Renders map tiles using DOM elements for GPU-accelerated transforms
 * 
 * Architecture:
 * - Each tile is a separate <canvas> element positioned absolutely
 * - All tiles are inside a container that moves via CSS transform
 * - Player movement only updates the container transform (no re-rendering)
 * - Tile images come from the shared MapTileImageCache (async, staggered)
 * 
 * This approach uses the browser's compositor for smooth scrolling without
 * any per-frame canvas operations.
 */

import {
  MapTileData,
  MAP_TILE_SIZE,
} from '@worldify/shared';

import { getTileBitmap } from './MapTileImageCache';

/** Configuration for map renderer */
export interface MapRendererConfig {
  /** Pixels per map tile pixel (zoom level) */
  scale: number;
}

const DEFAULT_CONFIG: MapRendererConfig = {
  scale: 1,
};

/**
 * DOM-based map renderer using CSS transforms for smooth scrolling.
 * Tile images are produced by the shared MapTileImageCache singleton
 * (async, staggered, and shared across all MapRenderer instances).
 */
export class MapRenderer {
  private container: HTMLDivElement;
  private tilesContainer: HTMLDivElement;
  private config: MapRendererConfig;
  private viewportWidth = 200;
  private viewportHeight = 200;
  
  // Player position for calculating transform
  private playerX = 0;
  private playerZ = 0;

  // DOM element cache (keyed by "tx,tz")
  private tileElements = new Map<string, HTMLCanvasElement>();
  
  // Track which hash is currently painted on each element to avoid redundant draws
  private paintedHashes = new Map<string, number>();

  constructor(container: HTMLDivElement, config: Partial<MapRendererConfig> = {}) {
    this.container = container;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Create tiles container (this will be transformed)
    this.tilesContainer = document.createElement('div');
    this.tilesContainer.style.cssText = `
      position: absolute;
      will-change: transform;
      transform-origin: 0 0;
    `;
    this.container.appendChild(this.tilesContainer);
  }

  /**
   * Set the viewport size (for centering calculations).
   */
  setViewportSize(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  /**
   * Set the player position (for map scrolling).
   */
  setPlayerPosition(worldX: number, worldZ: number): void {
    this.playerX = worldX;
    this.playerZ = worldZ;
  }

  /**
   * Update configuration.
   */
  setConfig(config: Partial<MapRendererConfig>): void {
    const scaleChanged = 'scale' in config && config.scale !== this.config.scale;
    
    this.config = { ...this.config, ...config };
    
    // Update all tile sizes if scale changed
    if (scaleChanged) {
      this.updateAllTileSizes();
    }
  }

  /**
   * Update sizes of all tile elements after scale change.
   */
  private updateAllTileSizes(): void {
    const { scale } = this.config;
    const tileScreenSize = MAP_TILE_SIZE * scale;
    
    for (const [key, canvas] of this.tileElements) {
      const [txStr, tzStr] = key.split(',');
      const tx = parseInt(txStr, 10);
      const tz = parseInt(tzStr, 10);
      
      canvas.style.left = `${tx * tileScreenSize}px`;
      canvas.style.top = `${tz * tileScreenSize}px`;
      canvas.style.width = `${tileScreenSize}px`;
      canvas.style.height = `${tileScreenSize}px`;
    }
  }

  /**
   * Render visible tiles. Only updates DOM when tiles change.
   */
  render(tiles: Map<string, MapTileData>, _centerTx: number, _centerTz: number): void {
    const { scale } = this.config;
    const tileScreenSize = MAP_TILE_SIZE * scale;
    
    // Calculate tile world size (MAP_TILE_SIZE * VOXEL_SCALE = 32 * 0.25 = 8m)
    const tileWorldSize = MAP_TILE_SIZE * 0.25;
    
    // Calculate how many tiles we need to cover the viewport
    const tilesX = Math.ceil(this.viewportWidth / tileScreenSize) + 2;
    const tilesZ = Math.ceil(this.viewportHeight / tileScreenSize) + 2;
    const halfTilesX = Math.floor(tilesX / 2);
    const halfTilesZ = Math.floor(tilesZ / 2);
    
    // Calculate center tile based on player position
    const centerTx = Math.floor(this.playerX / tileWorldSize);
    const centerTz = Math.floor(this.playerZ / tileWorldSize);
    
    // Track which tiles should be visible
    const visibleKeys = new Set<string>();
    
    // Update/create tile elements for visible area
    for (let dz = -halfTilesZ; dz <= halfTilesZ; dz++) {
      for (let dx = -halfTilesX; dx <= halfTilesX; dx++) {
        const tx = centerTx + dx;
        const tz = centerTz + dz;
        const key = `${tx},${tz}`;
        visibleKeys.add(key);
        
        const tile = tiles.get(key);
        this.updateTileElement(tx, tz, key, tile, tileScreenSize);
      }
    }
    
    // Remove tile elements that are no longer visible
    for (const [key, canvas] of this.tileElements) {
      if (!visibleKeys.has(key)) {
        canvas.remove();
        this.tileElements.delete(key);
        this.paintedHashes.delete(key);
      }
    }
    
    // Update container transform for smooth scrolling
    this.updateTransform();
  }

  /**
   * Update the container transform based on player position.
   */
  private updateTransform(): void {
    const { scale } = this.config;
    const tileWorldSize = MAP_TILE_SIZE * 0.25;
    const tileScreenSize = MAP_TILE_SIZE * scale;
    
    // Player position in tile coordinates
    const playerTileX = this.playerX / tileWorldSize;
    const playerTileZ = this.playerZ / tileWorldSize;
    
    // Player's position in screen coordinates (relative to tiles container origin)
    const playerScreenX = playerTileX * tileScreenSize;
    const playerScreenZ = playerTileZ * tileScreenSize;
    
    // Translate so player position appears at viewport center
    const translateX = this.viewportWidth / 2 - playerScreenX;
    const translateZ = this.viewportHeight / 2 - playerScreenZ;
    
    this.tilesContainer.style.transform = `translate(${translateX}px, ${translateZ}px)`;
  }

  /**
   * Update or create a tile element.
   */
  private updateTileElement(
    tx: number,
    tz: number,
    key: string,
    tile: MapTileData | undefined,
    tileScreenSize: number,
  ): void {
    let canvas = this.tileElements.get(key);
    
    if (tile) {
      // Ask the shared image cache for a bitmap
      const cached = getTileBitmap(key, tile);
      
      if (!canvas) {
        // Create a small canvas element sized to MAP_TILE_SIZE (32×32)
        canvas = document.createElement('canvas');
        canvas.width = MAP_TILE_SIZE;
        canvas.height = MAP_TILE_SIZE;
        canvas.style.cssText = `
          position: absolute;
          pointer-events: none;
          image-rendering: pixelated;
          left: ${tx * tileScreenSize}px;
          top: ${tz * tileScreenSize}px;
          width: ${tileScreenSize}px;
          height: ${tileScreenSize}px;
        `;
        this.tilesContainer.appendChild(canvas);
        this.tileElements.set(key, canvas);
      }
      
      // Paint bitmap if available and hash changed
      if (cached && this.paintedHashes.get(key) !== cached.dataHash) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(cached.bitmap, 0, 0);
          this.paintedHashes.set(key, cached.dataHash);
        }
      }
      
      // Ensure position is up-to-date
      canvas.style.left = `${tx * tileScreenSize}px`;
      canvas.style.top = `${tz * tileScreenSize}px`;
      canvas.style.width = `${tileScreenSize}px`;
      canvas.style.height = `${tileScreenSize}px`;
    } else {
      // No tile data — remove element if it exists
      if (canvas) {
        canvas.remove();
        this.tileElements.delete(key);
        this.paintedHashes.delete(key);
      }
    }
  }

  /**
   * Clear all DOM elements.
   */
  clearCache(): void {
    for (const canvas of this.tileElements.values()) {
      canvas.remove();
    }
    this.tileElements.clear();
    this.paintedHashes.clear();
  }

  /**
   * Clean up DOM elements.
   */
  dispose(): void {
    this.clearCache();
    this.tilesContainer.remove();
  }
}
