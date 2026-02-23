/**
 * MapRenderer - Renders map tiles using grouped canvases for minimal compositor layers
 * 
 * Architecture:
 * - Tiles are grouped into GROUP_SIZE×GROUP_SIZE (4×4) clusters
 * - Each group is a single <canvas> element (128×128 native pixels)
 * - When a tile updates, only its group canvas is repainted
 * - All groups live inside a container that scrolls via CSS transform
 * - This reduces ~360 compositor layers to ~23
 * 
 * Tile images come from the shared MapTileImageCache (async, staggered).
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

/** Number of tiles per group axis (4×4 = 16 tiles per group canvas) */
const GROUP_SIZE = 4;
/** Native pixel size of a group canvas */
const GROUP_PIXELS = MAP_TILE_SIZE * GROUP_SIZE; // 128

/** Floor-divide that works for negatives: e.g. floorDiv(-1, 4) = -1 */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

/** Positive modulo that works for negatives: e.g. posMod(-1, 4) = 3 */
function posMod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** State for a single group canvas */
interface TileGroup {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** Track which dataHash is painted at each local slot (0..15) */
  paintedHashes: (number | undefined)[];
}

/**
 * Canvas-group-based map renderer.
 * Groups tiles into GROUP_SIZE×GROUP_SIZE clusters to minimise compositor layers.
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

  // Group cache keyed by "gx,gz"
  private groups = new Map<string, TileGroup>();

  constructor(container: HTMLDivElement, config: Partial<MapRendererConfig> = {}) {
    this.container = container;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Clip viewport so groups outside aren't visible
    this.container.style.overflow = 'hidden';
    
    // Create tiles container (this will be transformed for scrolling)
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
    if (scaleChanged) {
      this.repositionAllGroups();
    }
  }

  /**
   * Reposition all group canvases after a scale change.
   */
  private repositionAllGroups(): void {
    const { scale } = this.config;
    const groupScreenSize = GROUP_PIXELS * scale;
    
    for (const [key, group] of this.groups) {
      const [gxStr, gzStr] = key.split(',');
      const gx = parseInt(gxStr, 10);
      const gz = parseInt(gzStr, 10);
      group.canvas.style.left = `${gx * groupScreenSize}px`;
      group.canvas.style.top = `${gz * groupScreenSize}px`;
      group.canvas.style.width = `${groupScreenSize}px`;
      group.canvas.style.height = `${groupScreenSize}px`;
    }
  }

  /**
   * Render visible tiles grouped into cluster canvases.
   */
  render(tiles: Map<string, MapTileData>, _centerTx: number, _centerTz: number): void {
    const { scale } = this.config;
    const tileScreenSize = MAP_TILE_SIZE * scale;
    const groupScreenSize = GROUP_PIXELS * scale;
    
    // Tile world size: MAP_TILE_SIZE * VOXEL_SCALE = 32 * 0.25 = 8m
    const tileWorldSize = MAP_TILE_SIZE * 0.25;
    
    // How many tiles to cover viewport (+ margin)
    const tilesX = Math.ceil(this.viewportWidth / tileScreenSize) + 2;
    const tilesZ = Math.ceil(this.viewportHeight / tileScreenSize) + 2;
    const halfTilesX = Math.floor(tilesX / 2);
    const halfTilesZ = Math.floor(tilesZ / 2);
    
    // Center tile based on player pos
    const centerTx = Math.floor(this.playerX / tileWorldSize);
    const centerTz = Math.floor(this.playerZ / tileWorldSize);
    
    // Determine which groups are needed
    const visibleGroupKeys = new Set<string>();
    
    for (let dz = -halfTilesZ; dz <= halfTilesZ; dz++) {
      for (let dx = -halfTilesX; dx <= halfTilesX; dx++) {
        const tx = centerTx + dx;
        const tz = centerTz + dz;
        const gx = floorDiv(tx, GROUP_SIZE);
        const gz = floorDiv(tz, GROUP_SIZE);
        const groupKey = `${gx},${gz}`;
        visibleGroupKeys.add(groupKey);
        
        // Ensure group exists
        let group = this.groups.get(groupKey);
        if (!group) {
          group = this.createGroup(gx, gz, groupScreenSize);
          this.groups.set(groupKey, group);
        }
        
        // Paint tile into group if data is available and changed
        const tileKey = `${tx},${tz}`;
        const tile = tiles.get(tileKey);
        if (tile) {
          const cached = getTileBitmap(tileKey, tile);
          if (cached) {
            const localX = posMod(tx, GROUP_SIZE);
            const localZ = posMod(tz, GROUP_SIZE);
            const slotIndex = localZ * GROUP_SIZE + localX;
            if (group.paintedHashes[slotIndex] !== cached.dataHash) {
              group.ctx.drawImage(
                cached.bitmap,
                localX * MAP_TILE_SIZE,
                localZ * MAP_TILE_SIZE,
                MAP_TILE_SIZE,
                MAP_TILE_SIZE,
              );
              group.paintedHashes[slotIndex] = cached.dataHash;
            }
          }
        }
      }
    }
    
    // Remove groups no longer visible
    for (const [key, group] of this.groups) {
      if (!visibleGroupKeys.has(key)) {
        group.canvas.remove();
        this.groups.delete(key);
      }
    }
    
    // Scroll container
    this.updateTransform();
  }

  /**
   * Create a new group canvas for the given group coordinate.
   */
  private createGroup(gx: number, gz: number, groupScreenSize: number): TileGroup {
    const canvas = document.createElement('canvas');
    canvas.width = GROUP_PIXELS;
    canvas.height = GROUP_PIXELS;
    canvas.style.cssText = `
      position: absolute;
      pointer-events: none;
      image-rendering: pixelated;
      left: ${gx * groupScreenSize}px;
      top: ${gz * groupScreenSize}px;
      width: ${groupScreenSize}px;
      height: ${groupScreenSize}px;
    `;
    this.tilesContainer.appendChild(canvas);
    
    const ctx = canvas.getContext('2d')!;
    return {
      canvas,
      ctx,
      paintedHashes: new Array(GROUP_SIZE * GROUP_SIZE).fill(undefined),
    };
  }

  /**
   * Update the container transform based on player position.
   */
  private updateTransform(): void {
    const { scale } = this.config;
    const tileWorldSize = MAP_TILE_SIZE * 0.25;
    const tileScreenSize = MAP_TILE_SIZE * scale;
    
    const playerTileX = this.playerX / tileWorldSize;
    const playerTileZ = this.playerZ / tileWorldSize;
    
    const playerScreenX = playerTileX * tileScreenSize;
    const playerScreenZ = playerTileZ * tileScreenSize;
    
    const translateX = this.viewportWidth / 2 - playerScreenX;
    const translateZ = this.viewportHeight / 2 - playerScreenZ;
    
    this.tilesContainer.style.transform = `translate(${translateX}px, ${translateZ}px)`;
  }

  /**
   * Clear all group canvases.
   */
  clearCache(): void {
    for (const group of this.groups.values()) {
      group.canvas.remove();
    }
    this.groups.clear();
  }

  /**
   * Clean up DOM elements.
   */
  dispose(): void {
    this.clearCache();
    this.tilesContainer.remove();
  }
}
