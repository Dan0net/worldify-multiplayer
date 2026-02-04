/**
 * MapRenderer - Renders map tiles to a canvas
 * 
 * Debug visualization for map tile data.
 * Shows terrain height and materials as a colored overhead view.
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
  scale: 4,
  showHeightShading: true,
  heightRange: { min: -32, max: 64 },
};

/**
 * Renders map tiles to a 2D canvas.
 */
export class MapRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private config: MapRendererConfig;
  
  // Player marker
  private playerX = 0;
  private playerZ = 0;

  constructor(canvas: HTMLCanvasElement, config: Partial<MapRendererConfig> = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to get 2D context');
    this.ctx = ctx;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the player position (for marker rendering).
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
  }

  /**
   * Render all tiles centered on player position.
   */
  render(tiles: Map<string, MapTileData>, centerTx: number, centerTz: number): void {
    const { scale } = this.config;
    const tilePixelSize = MAP_TILE_SIZE * scale;
    
    // Calculate how many tiles fit on screen
    const tilesX = Math.ceil(this.canvas.width / tilePixelSize) + 1;
    const tilesZ = Math.ceil(this.canvas.height / tilePixelSize) + 1;
    
    // Center offset
    const halfTilesX = Math.floor(tilesX / 2);
    const halfTilesZ = Math.floor(tilesZ / 2);
    
    // Clear canvas
    this.ctx.fillStyle = '#1a1a2e';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Render visible tiles
    for (let dz = -halfTilesZ; dz <= halfTilesZ; dz++) {
      for (let dx = -halfTilesX; dx <= halfTilesX; dx++) {
        const tx = centerTx + dx;
        const tz = centerTz + dz;
        const key = `${tx},${tz}`;
        const tile = tiles.get(key);
        
        // Screen position for this tile
        const screenX = this.canvas.width / 2 + dx * tilePixelSize;
        const screenZ = this.canvas.height / 2 + dz * tilePixelSize;
        
        if (tile) {
          this.renderTile(tile, screenX, screenZ);
        } else {
          // Render placeholder for missing tiles
          this.ctx.fillStyle = '#2a2a3e';
          this.ctx.fillRect(screenX, screenZ, tilePixelSize, tilePixelSize);
        }
      }
    }

    // Render player marker
    this.renderPlayerMarker(centerTx, centerTz);
    
    // Render grid lines (debug)
    this.renderGrid(centerTx, centerTz, halfTilesX, halfTilesZ);
  }

  /**
   * Render a single tile.
   */
  private renderTile(tile: MapTileData, screenX: number, screenZ: number): void {
    const { scale, showHeightShading, heightRange } = this.config;
    
    for (let lz = 0; lz < MAP_TILE_SIZE; lz++) {
      for (let lx = 0; lx < MAP_TILE_SIZE; lx++) {
        const index = tilePixelIndex(lx, lz);
        const height = tile.heights[index];
        const material = tile.materials[index];
        
        // Get base color from material
        const baseColor = Materials.getColor(material);
        
        // Apply height shading if enabled
        let finalColor = baseColor;
        if (showHeightShading) {
          const heightNorm = (height - heightRange.min) / (heightRange.max - heightRange.min);
          const brightness = Math.max(0.3, Math.min(1.0, 0.5 + heightNorm * 0.5));
          finalColor = this.adjustBrightness(baseColor, brightness);
        }
        
        this.ctx.fillStyle = finalColor;
        this.ctx.fillRect(
          screenX + lx * scale,
          screenZ + lz * scale,
          scale,
          scale
        );
      }
    }
  }

  /**
   * Render player position marker.
   */
  private renderPlayerMarker(centerTx: number, centerTz: number): void {
    const { scale } = this.config;
    
    // Calculate player position relative to center tile
    const playerTileX = this.playerX / (MAP_TILE_SIZE * 0.25); // VOXEL_SCALE = 0.25
    const playerTileZ = this.playerZ / (MAP_TILE_SIZE * 0.25);
    
    const relX = playerTileX - centerTx * MAP_TILE_SIZE;
    const relZ = playerTileZ - centerTz * MAP_TILE_SIZE;
    
    const screenX = this.canvas.width / 2 + relX * scale;
    const screenZ = this.canvas.height / 2 + relZ * scale;
    
    // Draw player marker (triangle pointing up)
    this.ctx.fillStyle = '#ff4444';
    this.ctx.beginPath();
    this.ctx.moveTo(screenX, screenZ - 8);
    this.ctx.lineTo(screenX - 6, screenZ + 6);
    this.ctx.lineTo(screenX + 6, screenZ + 6);
    this.ctx.closePath();
    this.ctx.fill();
    
    // Outline
    this.ctx.strokeStyle = '#ffffff';
    this.ctx.lineWidth = 2;
    this.ctx.stroke();
  }

  /**
   * Render tile grid lines.
   */
  private renderGrid(_centerTx: number, _centerTz: number, halfX: number, halfZ: number): void {
    const { scale } = this.config;
    const tilePixelSize = MAP_TILE_SIZE * scale;
    
    this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    this.ctx.lineWidth = 1;
    
    // Vertical lines
    for (let dx = -halfX; dx <= halfX + 1; dx++) {
      const x = this.canvas.width / 2 + dx * tilePixelSize;
      this.ctx.beginPath();
      this.ctx.moveTo(x, 0);
      this.ctx.lineTo(x, this.canvas.height);
      this.ctx.stroke();
    }
    
    // Horizontal lines
    for (let dz = -halfZ; dz <= halfZ + 1; dz++) {
      const z = this.canvas.height / 2 + dz * tilePixelSize;
      this.ctx.beginPath();
      this.ctx.moveTo(0, z);
      this.ctx.lineTo(this.canvas.width, z);
      this.ctx.stroke();
    }
  }

  /**
   * Adjust hex color brightness.
   */
  private adjustBrightness(hex: string, factor: number): string {
    // Parse hex color
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    
    // Apply brightness
    const nr = Math.round(Math.min(255, r * factor));
    const ng = Math.round(Math.min(255, g * factor));
    const nb = Math.round(Math.min(255, b * factor));
    
    return `rgb(${nr}, ${ng}, ${nb})`;
  }

  /**
   * Resize canvas to fit container.
   */
  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }
}
