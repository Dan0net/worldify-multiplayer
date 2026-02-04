/**
 * MapTileProvider - Generates and updates map tiles
 * 
 * Responsibilities:
 * - Generate tiles from terrain when first requested
 * - Update tiles when chunks are modified by builds
 * - Scan chunk columns to find highest solid voxels
 */

import {
  MapTileData,
  createMapTile,
  tilePixelIndex,
  TerrainGenerator,
  ChunkData,
  CHUNK_SIZE,
  VOXEL_SCALE,
  MAP_TILE_SIZE,
  updateTileFromChunk,
} from '@worldify/shared';
import { MapTileStore } from '../storage/MapTileStore.js';

/**
 * Provides map tiles, generating from terrain or scanning chunks.
 */
export class MapTileProvider {
  private readonly store: MapTileStore;
  private readonly terrainGenerator: TerrainGenerator;

  constructor(
    store: MapTileStore,
    terrainGenerator: TerrainGenerator
  ) {
    this.store = store;
    this.terrainGenerator = terrainGenerator;
  }

  /**
   * Get a tile, generating if needed.
   */
  getOrCreate(tx: number, tz: number): MapTileData {
    // Check cache
    let tile = this.store.get(tx, tz);
    if (tile) return tile;

    // Generate from terrain (fast path when no chunks exist yet)
    tile = this.generateFromTerrain(tx, tz);
    this.store.set(tx, tz, tile);
    return tile;
  }

  /**
   * Get a tile asynchronously, loading from disk if available.
   */
  async getOrCreateAsync(tx: number, tz: number): Promise<MapTileData> {
    // Try cache/disk
    let tile = await this.store.getAsync(tx, tz);
    if (tile) return tile;

    // Generate from terrain
    tile = this.generateFromTerrain(tx, tz);
    this.store.set(tx, tz, tile);
    return tile;
  }

  /**
   * Update tile when a chunk is modified (after build).
   * Uses shared updateTileFromChunk function.
   */
  updateFromChunk(chunk: ChunkData): void {
    const tx = chunk.cx;
    const tz = chunk.cz;
    
    // Get or create tile for this column
    let tile = this.store.get(tx, tz);
    if (!tile) {
      tile = this.generateFromTerrain(tx, tz);
    }

    // Use shared function with fallback for dig rescanning
    updateTileFromChunk(tile, chunk, (lx, lz) => 
      this.scanColumnForSurface(tx, tz, lx, lz)
    );

    this.store.set(tx, tz, tile);
  }

  /**
   * Scan all loaded chunks in a column to find the surface.
   * Used when we need to recalculate after a dig operation.
   * TODO: Add chunk store scanning when we have a proper chunk registry.
   * For now, just returns terrain baseline.
   */
  private scanColumnForSurface(
    tx: number,
    tz: number,
    lx: number,
    lz: number
  ): { height: number; material: number } {
    // Get terrain baseline
    const worldX = tx * CHUNK_SIZE * VOXEL_SCALE + lx * VOXEL_SCALE;
    const worldZ = tz * CHUNK_SIZE * VOXEL_SCALE + lz * VOXEL_SCALE;
    return this.terrainGenerator.sampleSurface(worldX, worldZ);
  }

  /**
   * Generate a tile from terrain without loading chunks.
   * Fast path for map browsing.
   */
  private generateFromTerrain(tx: number, tz: number): MapTileData {
    const tile = createMapTile(tx, tz);
    
    const chunkWorldX = tx * CHUNK_SIZE * VOXEL_SCALE;
    const chunkWorldZ = tz * CHUNK_SIZE * VOXEL_SCALE;

    for (let lz = 0; lz < MAP_TILE_SIZE; lz++) {
      for (let lx = 0; lx < MAP_TILE_SIZE; lx++) {
        const worldX = chunkWorldX + lx * VOXEL_SCALE;
        const worldZ = chunkWorldZ + lz * VOXEL_SCALE;
        
        const { height, material } = this.terrainGenerator.sampleSurface(worldX, worldZ);
        
        const index = tilePixelIndex(lx, lz);
        tile.heights[index] = height;
        tile.materials[index] = material;
      }
    }

    return tile;
  }

  /**
   * Mark a tile as dirty for persistence.
   */
  markDirty(tx: number, tz: number): void {
    this.store.markDirty(tx, tz);
  }

  /**
   * Flush dirty tiles to disk.
   */
  async flush(): Promise<void> {
    await this.store.flush();
  }
}
