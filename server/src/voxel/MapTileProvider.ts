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
  getWeight,
  getMaterial,
  MAP_TILE_SIZE,
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
   * Scans the chunk to update affected pixels.
   */
  updateFromChunk(chunk: ChunkData): void {
    const tx = chunk.cx;
    const tz = chunk.cz;
    
    // Get or create tile for this column
    let tile = this.store.get(tx, tz);
    if (!tile) {
      tile = this.generateFromTerrain(tx, tz);
    }

    // Scan each XZ column in the chunk
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const pixelIndex = tilePixelIndex(lx, lz);
        const currentHeight = tile.heights[pixelIndex];
        
        // Scan this chunk's Y range for this column
        let maxHeight = currentHeight;
        let surfaceMaterial = tile.materials[pixelIndex];
        
        // Check if this chunk could contain a higher surface
        const chunkMinY = chunk.cy * CHUNK_SIZE;
        const chunkMaxY = chunkMinY + CHUNK_SIZE - 1;
        
        // Scan from top to bottom of this chunk
        for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
          const voxelY = chunkMinY + ly;
          const index = lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE;
          const voxel = chunk.data[index];
          const weight = getWeight(voxel);
          
          // Surface is where weight crosses 0 (we look for solid voxels)
          if (weight > 0) {
            if (voxelY > maxHeight) {
              maxHeight = voxelY;
              surfaceMaterial = getMaterial(voxel);
            }
            break; // Found surface for this column in this chunk
          }
        }
        
        // Also check if the current recorded height was in this chunk and is now air
        if (currentHeight >= chunkMinY && currentHeight <= chunkMaxY) {
          // Need to rescan to find actual surface
          const { height, material } = this.scanColumnForSurface(tx, tz, lx, lz);
          maxHeight = height;
          surfaceMaterial = material;
        }
        
        tile.heights[pixelIndex] = maxHeight;
        tile.materials[pixelIndex] = surfaceMaterial;
      }
    }

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
