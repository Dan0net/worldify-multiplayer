/**
 * MapRenderer - Renders map tiles using DOM elements for GPU-accelerated transforms
 * 
 * Architecture:
 * - Each tile is a separate <img> element positioned absolutely
 * - All tiles are inside a container that moves via CSS transform
 * - Player movement only updates the container transform (no re-rendering)
 * - Tile images only update when tile data changes (hash-based dirty check)
 * 
 * This approach uses the browser's compositor for smooth scrolling without
 * any per-frame canvas operations.
 */

import {
  MapTileData,
  MAP_TILE_SIZE,
  tilePixelIndex,
  Materials,
} from '@worldify/shared';

/** Configuration for map renderer */
export interface MapRendererConfig {
  /** Pixels per map tile pixel (zoom level) */
  scale: number;
  /** Show height shading (grayscale overlay) */
  showHeightShading: boolean;
  /** Height range for shading normalization */
  heightRange: { min: number; max: number };
}

const DEFAULT_CONFIG: MapRendererConfig = {
  scale: 1,
  showHeightShading: true,
  heightRange: { min: -32, max: 64 },
};

/** Pre-computed RGB colors for all materials */
const MATERIAL_RGB_CACHE: [number, number, number][] = [];

// Initialize RGB cache on module load
function initColorCache(): void {
  if (MATERIAL_RGB_CACHE.length > 0) return;
  for (let i = 0; i < Materials.count; i++) {
    MATERIAL_RGB_CACHE[i] = Materials.getColorRGB(i);
  }
  // Default fallback
  MATERIAL_RGB_CACHE[255] = [255, 255, 255];
}

/** Cached tile info */
interface CachedTile {
  /** Data URL of the rendered tile image */
  dataUrl: string;
  /** Hash of tile data for dirty checking */
  dataHash: number;
}

/**
 * DOM-based map renderer using CSS transforms for smooth scrolling.
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

  // Tile data cache (keyed by "tx,tz")
  private tileDataCache = new Map<string, CachedTile>();
  
  // DOM element cache (keyed by "tx,tz")
  private tileElements = new Map<string, HTMLDivElement>();

  // Offscreen canvas for tile rendering
  private offscreenCanvas: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D;

  constructor(container: HTMLDivElement, config: Partial<MapRendererConfig> = {}) {
    this.container = container;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize color cache
    initColorCache();
    
    // Create tiles container (this will be transformed)
    this.tilesContainer = document.createElement('div');
    this.tilesContainer.style.cssText = `
      position: absolute;
      will-change: transform;
      transform-origin: 0 0;
    `;
    this.container.appendChild(this.tilesContainer);
    
    // Create offscreen canvas for tile rendering
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = MAP_TILE_SIZE;
    this.offscreenCanvas.height = MAP_TILE_SIZE;
    const offCtx = this.offscreenCanvas.getContext('2d');
    if (!offCtx) throw new Error('Failed to get offscreen 2D context');
    this.offscreenCtx = offCtx;
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
    const shadingChanged = 'showHeightShading' in config || 'heightRange' in config;
    
    this.config = { ...this.config, ...config };
    
    // Clear data cache if shading settings changed (need to re-render tiles)
    if (shadingChanged) {
      this.tileDataCache.clear();
    }
    
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
    
    for (const [key, element] of this.tileElements) {
      const [txStr, tzStr] = key.split(',');
      const tx = parseInt(txStr, 10);
      const tz = parseInt(tzStr, 10);
      
      const left = tx * tileScreenSize;
      const top = tz * tileScreenSize;
      // Preserve the background-image when updating size
      const bgImage = element.style.backgroundImage;
      element.style.cssText = `
        position: absolute;
        image-rendering: pixelated;
        pointer-events: none;
        background-size: 100% 100%;
        background-image: ${bgImage};
        left: ${left}px;
        top: ${top}px;
        width: ${tileScreenSize}px;
        height: ${tileScreenSize}px;
      `;
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
        this.updateTileElement(tx, tz, key, tile);
      }
    }
    
    // Remove tile elements that are no longer visible
    for (const [key, element] of this.tileElements) {
      if (!visibleKeys.has(key)) {
        element.remove();
        this.tileElements.delete(key);
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
    
    // Center tile
    const centerTx = Math.floor(playerTileX);
    const centerTz = Math.floor(playerTileZ);
    
    // Fractional offset within tile (0 to 1)
    const fracX = playerTileX - centerTx;
    const fracZ = playerTileZ - centerTz;
    
    // Calculate transform offset:
    // - Center the (0,0) tile at viewport center
    // - Then offset by fractional position for smooth scrolling
    const baseOffsetX = this.viewportWidth / 2 - tileScreenSize / 2;
    const baseOffsetZ = this.viewportHeight / 2 - tileScreenSize / 2;
    
    // Shift by center tile position (tiles are positioned relative to 0,0)
    // and subtract fractional offset for smooth scrolling
    const translateX = baseOffsetX - (centerTx + fracX) * tileScreenSize;
    const translateZ = baseOffsetZ - (centerTz + fracZ) * tileScreenSize;
    
    this.tilesContainer.style.transform = `translate(${translateX}px, ${translateZ}px)`;
  }

  /**
   * Update or create a tile element.
   */
  private updateTileElement(tx: number, tz: number, key: string, tile: MapTileData | undefined): void {
    const { scale } = this.config;
    const tileScreenSize = MAP_TILE_SIZE * scale;
    
    let element = this.tileElements.get(key);
    
    if (tile) {
      // Get or create cached tile data
      const cached = this.getCachedTile(tile, key);
      
      if (!element) {
        // Create new tile element (use div with background-image for reliable sizing)
        element = document.createElement('div');
        this.tilesContainer.appendChild(element);
        this.tileElements.set(key, element);
      }
      
      // Update image if data changed
      if (element.dataset.hash !== String(cached.dataHash)) {
        element.style.backgroundImage = `url(${cached.dataUrl})`;
        element.dataset.hash = String(cached.dataHash);
      }
      
      // Update all styles together to avoid partial updates
      const left = tx * tileScreenSize;
      const top = tz * tileScreenSize;
      element.style.cssText = `
        position: absolute;
        image-rendering: pixelated;
        pointer-events: none;
        background-size: 100% 100%;
        background-image: url(${cached.dataUrl});
        left: ${left}px;
        top: ${top}px;
        width: ${tileScreenSize}px;
        height: ${tileScreenSize}px;
      `;
    } else {
      // No tile data - show placeholder or remove
      if (element) {
        element.remove();
        this.tileElements.delete(key);
      }
    }
  }

  /**
   * Get or create cached tile data.
   */
  private getCachedTile(tile: MapTileData, key: string): CachedTile {
    const dataHash = this.computeTileHash(tile);
    
    let cached = this.tileDataCache.get(key);
    if (cached && cached.dataHash === dataHash) {
      return cached;
    }
    
    // Render tile to canvas and get data URL
    this.renderTileToCanvas(tile);
    const dataUrl = this.offscreenCanvas.toDataURL();
    
    cached = { dataUrl, dataHash };
    this.tileDataCache.set(key, cached);
    
    return cached;
  }

  /**
   * Compute a simple hash of tile data for dirty checking.
   */
  private computeTileHash(tile: MapTileData): number {
    let hash = 0;
    for (let i = 0; i < tile.heights.length; i++) {
      hash = ((hash << 5) - hash + tile.heights[i]) | 0;
      hash = ((hash << 5) - hash + tile.materials[i]) | 0;
    }
    return hash;
  }

  /**
   * Render tile to offscreen canvas.
   */
  private renderTileToCanvas(tile: MapTileData): void {
    const { showHeightShading, heightRange } = this.config;
    const imageData = this.offscreenCtx.createImageData(MAP_TILE_SIZE, MAP_TILE_SIZE);
    const data = imageData.data;
    
    for (let lz = 0; lz < MAP_TILE_SIZE; lz++) {
      for (let lx = 0; lx < MAP_TILE_SIZE; lx++) {
        const tileIndex = tilePixelIndex(lx, lz);
        const height = tile.heights[tileIndex];
        const material = tile.materials[tileIndex];
        
        // Get base RGB color from cache
        const rgb = MATERIAL_RGB_CACHE[material] ?? MATERIAL_RGB_CACHE[255];
        let r = rgb[0];
        let g = rgb[1];
        let b = rgb[2];
        
        // Apply height shading if enabled
        if (showHeightShading) {
          const heightNorm = (height - heightRange.min) / (heightRange.max - heightRange.min);
          const brightness = Math.max(0.3, Math.min(1.0, 0.5 + heightNorm * 0.5));
          r = Math.round(r * brightness);
          g = Math.round(g * brightness);
          b = Math.round(b * brightness);
        }
        
        // Write to ImageData (RGBA)
        const pixelIndex = (lz * MAP_TILE_SIZE + lx) * 4;
        data[pixelIndex] = r;
        data[pixelIndex + 1] = g;
        data[pixelIndex + 2] = b;
        data[pixelIndex + 3] = 255;
      }
    }
    
    this.offscreenCtx.putImageData(imageData, 0, 0);
  }

  /**
   * Invalidate cached tile (call when tile data changes).
   */
  invalidateTile(tx: number, tz: number): void {
    this.tileDataCache.delete(`${tx},${tz}`);
  }

  /**
   * Clear all cached tiles and DOM elements.
   */
  clearCache(): void {
    this.tileDataCache.clear();
    for (const element of this.tileElements.values()) {
      element.remove();
    }
    this.tileElements.clear();
  }

  /**
   * Clean up DOM elements.
   */
  dispose(): void {
    this.clearCache();
    this.tilesContainer.remove();
  }
}
