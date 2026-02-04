/**
 * MapRenderer - Renders map tiles to a canvas using ImageData for performance
 * 
 * Optimizations:
 * - Pre-computed RGB color lookup table
 * - ImageData buffer for batch pixel writes (1 putImageData vs 1000+ fillRect)
 * - Cached tile images that only update when tile data changes
 * - Dirty tracking to skip unchanged tiles
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

/** Cached rendered tile data */
interface CachedTile {
  /** The ImageData for this tile at scale 1 */
  imageData: ImageData;
  /** Hash of tile data for dirty checking */
  dataHash: number;
}

/**
 * Renders map tiles to a 2D canvas using ImageData for performance.
 */
export class MapRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: MapRendererConfig;
  
  // Player position for calculating map scroll offset
  private playerX = 0;
  private playerZ = 0;

  // Tile image cache (keyed by "tx,tz")
  private tileCache = new Map<string, CachedTile>();

  // Offscreen canvas for scaling
  private offscreenCanvas: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement, config: Partial<MapRendererConfig> = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Initialize color cache
    initColorCache();
    
    // Create offscreen canvas for tile rendering
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = MAP_TILE_SIZE;
    this.offscreenCanvas.height = MAP_TILE_SIZE;
    const offCtx = this.offscreenCanvas.getContext('2d');
    if (!offCtx) throw new Error('Failed to get offscreen 2D context');
    this.offscreenCtx = offCtx;
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
    this.config = { ...this.config, ...config };
    // Clear cache if height shading settings changed
    if ('showHeightShading' in config || 'heightRange' in config) {
      this.tileCache.clear();
    }
  }

  /**
   * Render all tiles centered on player position.
   * Uses sub-tile offset for smooth scrolling.
   */
  render(tiles: Map<string, MapTileData>, centerTx: number, centerTz: number): void {
    const { scale } = this.config;
    const tileScreenSize = MAP_TILE_SIZE * scale;
    
    // Calculate player's sub-tile offset (position within current tile)
    // VOXEL_SCALE = 0.25, so tile world size = MAP_TILE_SIZE * 0.25 = 8m
    const tileWorldSize = MAP_TILE_SIZE * 0.25;
    const playerTileX = this.playerX / tileWorldSize;
    const playerTileZ = this.playerZ / tileWorldSize;
    
    // Fractional part = position within tile (0 to 1)
    const fracX = playerTileX - Math.floor(playerTileX);
    const fracZ = playerTileZ - Math.floor(playerTileZ);
    
    // Convert to screen offset (pixels to shift all tiles)
    const offsetX = -fracX * tileScreenSize;
    const offsetZ = -fracZ * tileScreenSize;
    
    // Calculate how many tiles fit on screen (add extra for offset)
    const tilesX = Math.ceil(this.canvas.width / tileScreenSize) + 2;
    const tilesZ = Math.ceil(this.canvas.height / tileScreenSize) + 2;
    
    // Center offset
    const halfTilesX = Math.floor(tilesX / 2);
    const halfTilesZ = Math.floor(tilesZ / 2);
    
    // Clear canvas
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Disable image smoothing for crisp pixels when scaled
    this.ctx.imageSmoothingEnabled = false;

    // Render visible tiles with offset
    for (let dz = -halfTilesZ; dz <= halfTilesZ; dz++) {
      for (let dx = -halfTilesX; dx <= halfTilesX; dx++) {
        const tx = centerTx + dx;
        const tz = centerTz + dz;
        const key = `${tx},${tz}`;
        const tile = tiles.get(key);
        
        // Screen position for this tile (with sub-tile offset for smooth scrolling)
        const screenX = Math.floor(this.canvas.width / 2 + dx * tileScreenSize + offsetX);
        const screenZ = Math.floor(this.canvas.height / 2 + dz * tileScreenSize + offsetZ);
        
        if (tile) {
          this.renderTile(tile, key, screenX, screenZ);
        } else {
          // Render placeholder for missing tiles
          this.ctx.fillStyle = '#2a2a3e';
          this.ctx.fillRect(screenX, screenZ, tileScreenSize, tileScreenSize);
        }
      }
    }
    // Player marker is rendered as SVG overlay by MapOverlay component
  }

  /**
   * Render a single tile using cached ImageData.
   */
  private renderTile(tile: MapTileData, key: string, screenX: number, screenZ: number): void {
    const { scale } = this.config;
    
    // Get or create cached tile image
    const cached = this.getCachedTile(tile, key);
    
    // Draw cached image to offscreen canvas
    this.offscreenCtx.putImageData(cached.imageData, 0, 0);
    
    // Draw scaled to main canvas
    this.ctx.drawImage(
      this.offscreenCanvas,
      0, 0, MAP_TILE_SIZE, MAP_TILE_SIZE,
      screenX, screenZ, MAP_TILE_SIZE * scale, MAP_TILE_SIZE * scale
    );
  }

  /**
   * Get or create cached tile image.
   */
  private getCachedTile(tile: MapTileData, key: string): CachedTile {
    const dataHash = this.computeTileHash(tile);
    
    let cached = this.tileCache.get(key);
    if (cached && cached.dataHash === dataHash) {
      return cached;
    }
    
    // Create new ImageData for this tile
    const imageData = this.renderTileToImageData(tile);
    cached = { imageData, dataHash };
    this.tileCache.set(key, cached);
    
    return cached;
  }

  /**
   * Compute a simple hash of tile data for dirty checking.
   * Uses all pixels for accurate change detection.
   */
  private computeTileHash(tile: MapTileData): number {
    // Hash all pixels for accurate dirty detection
    let hash = 0;
    for (let i = 0; i < tile.heights.length; i++) {
      hash = ((hash << 5) - hash + tile.heights[i]) | 0;
      hash = ((hash << 5) - hash + tile.materials[i]) | 0;
    }
    return hash;
  }

  /**
   * Render tile to ImageData buffer.
   */
  private renderTileToImageData(tile: MapTileData): ImageData {
    const { showHeightShading, heightRange } = this.config;
    const imageData = new ImageData(MAP_TILE_SIZE, MAP_TILE_SIZE);
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
        data[pixelIndex + 3] = 255; // Alpha
      }
    }
    
    return imageData;
  }

  /**
   * Invalidate cached tile (call when tile data changes).
   */
  invalidateTile(tx: number, tz: number): void {
    this.tileCache.delete(`${tx},${tz}`);
  }

  /**
   * Clear all cached tiles.
   */
  clearCache(): void {
    this.tileCache.clear();
  }

  /**
   * Resize canvas to fit container.
   */
  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }
}
