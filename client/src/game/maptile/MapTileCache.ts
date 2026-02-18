/**
 * MapTileCache - Client-side storage for map tiles
 * 
 * Caches map tiles received from the server and provides
 * query methods for height/material lookups.
 */

import {
  MapTileData,
  mapTileKey,
  createMapTile,
  updateTileHash,
  tilePixelIndex,
  MAP_TILE_SIZE,
  CHUNK_SIZE,
  VOXEL_SCALE,
} from '@worldify/shared';

/**
 * Client-side map tile cache with query helpers.
 */
export class MapTileCache {
  private readonly tiles = new Map<string, MapTileData>();

  /**
   * Get a tile from cache.
   */
  get(tx: number, tz: number): MapTileData | undefined {
    return this.tiles.get(mapTileKey(tx, tz));
  }

  /**
   * Store a tile in cache.
   */
  set(tx: number, tz: number, tile: MapTileData): void {
    this.tiles.set(mapTileKey(tx, tz), tile);
  }

  /**
   * Check if a tile is cached.
   */
  has(tx: number, tz: number): boolean {
    return this.tiles.has(mapTileKey(tx, tz));
  }

  /**
   * Get all cached tiles.
   */
  getAll(): Map<string, MapTileData> {
    return this.tiles;
  }

  /**
   * Get number of cached tiles.
   */
  get size(): number {
    return this.tiles.size;
  }

  /**
   * Clear all cached tiles.
   */
  clear(): void {
    this.tiles.clear();
  }

  /**
   * Store tile data from network response.
   */
  receiveTileData(tx: number, tz: number, heights: Int16Array, materials: Uint8Array): void {
    const tile = createMapTile(tx, tz);
    tile.heights.set(heights);
    tile.materials.set(materials);
    updateTileHash(tile);
    this.set(tx, tz, tile);
  }

  /**
   * Get height at a world position (in voxel Y units).
   * Returns null if tile not loaded.
   */
  getHeightAt(worldX: number, worldZ: number): number | null {
    // Convert world position to tile coordinates
    const tx = Math.floor(worldX / (CHUNK_SIZE * VOXEL_SCALE));
    const tz = Math.floor(worldZ / (CHUNK_SIZE * VOXEL_SCALE));
    
    const tile = this.get(tx, tz);
    if (!tile) return null;

    // Convert world position to local pixel coordinates
    const localX = Math.floor((worldX / VOXEL_SCALE) - tx * CHUNK_SIZE);
    const localZ = Math.floor((worldZ / VOXEL_SCALE) - tz * CHUNK_SIZE);
    
    // Clamp to valid range
    const lx = Math.max(0, Math.min(MAP_TILE_SIZE - 1, localX));
    const lz = Math.max(0, Math.min(MAP_TILE_SIZE - 1, localZ));

    return tile.heights[tilePixelIndex(lx, lz)];
  }

  /**
   * Get material at a world position.
   * Returns null if tile not loaded.
   */
  getMaterialAt(worldX: number, worldZ: number): number | null {
    const tx = Math.floor(worldX / (CHUNK_SIZE * VOXEL_SCALE));
    const tz = Math.floor(worldZ / (CHUNK_SIZE * VOXEL_SCALE));
    
    const tile = this.get(tx, tz);
    if (!tile) return null;

    const localX = Math.floor((worldX / VOXEL_SCALE) - tx * CHUNK_SIZE);
    const localZ = Math.floor((worldZ / VOXEL_SCALE) - tz * CHUNK_SIZE);
    
    const lx = Math.max(0, Math.min(MAP_TILE_SIZE - 1, localX));
    const lz = Math.max(0, Math.min(MAP_TILE_SIZE - 1, localZ));

    return tile.materials[tilePixelIndex(lx, lz)];
  }

  /**
   * Get Y range for a tile column (for chunk streaming optimization).
   * Returns min/max voxel Y that contain terrain.
   */
  getYRange(tx: number, tz: number): { minY: number; maxY: number } | null {
    const tile = this.get(tx, tz);
    if (!tile) return null;

    let minY = Infinity;
    let maxY = -Infinity;

    for (let i = 0; i < tile.heights.length; i++) {
      const h = tile.heights[i];
      if (h < minY) minY = h;
      if (h > maxY) maxY = h;
    }

    if (minY === Infinity) return null;

    return { minY, maxY };
  }
}
