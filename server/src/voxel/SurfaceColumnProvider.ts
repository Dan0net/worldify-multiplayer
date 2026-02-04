/**
 * SurfaceColumnProvider - Bundles tile + surface chunks for efficient streaming
 * 
 * This provider coordinates:
 * 1. ChunkProvider - for generating/loading chunks
 * 2. MapTileProvider - for generating/loading tiles
 * 
 * The key optimization is determining which Y chunks actually intersect
 * the surface (terrain + structures) instead of loading a full 3D volume.
 */

import {
  ChunkData,
  CHUNK_SIZE,
  MapTileData,
  updateTileFromChunk,
} from '@worldify/shared';
import { ChunkProvider } from './ChunkProvider.js';
import { MapTileProvider } from './MapTileProvider.js';

/** Buffer chunks below lowest surface (for caves, digging) - 0 for initial load */
const CHUNKS_BELOW_SURFACE = 0;

/** Max chunks to check above terrain when looking for empty sky */
const MAX_CHUNKS_ABOVE = 4;

export interface SurfaceColumn {
  tile: MapTileData;
  chunks: Array<{
    cy: number;
    lastBuildSeq: number;
    data: Uint16Array;
  }>;
}

/**
 * Provides bundled surface column data (tile + relevant chunks).
 */
export class SurfaceColumnProvider {
  private readonly chunkProvider: ChunkProvider;
  private readonly tileProvider: MapTileProvider;

  constructor(chunkProvider: ChunkProvider, tileProvider: MapTileProvider) {
    this.chunkProvider = chunkProvider;
    this.tileProvider = tileProvider;
  }

  /**
   * Get a surface column asynchronously.
   * 
   * Process:
   * 1. Get base tile to find terrain surface range
   * 2. Generate chunks from bottom up, stop when we hit empty sky
   * 3. Update tile from actual chunk surfaces (captures trees/buildings)
   * 4. Return bundled data
   */
  async getColumn(tx: number, tz: number): Promise<SurfaceColumn> {
    console.log(`[SurfaceColumn] Getting column (${tx}, ${tz})`);
    
    // Step 1: Get initial tile (terrain-only heights)
    let tile = await this.tileProvider.getOrCreateAsync(tx, tz);
    
    // Step 2: Get terrain chunk range
    const { terrainMinCy, terrainMaxCy } = this.getTerrainChunkRange(tile);
    const minCy = terrainMinCy - CHUNKS_BELOW_SURFACE;
    
    // Step 3: Generate chunks upward, stop when we hit empty sky above terrain
    const chunks: SurfaceColumn['chunks'] = [];
    const chunkDatas: ChunkData[] = [];
    
    for (let cy = minCy; cy <= terrainMaxCy + MAX_CHUNKS_ABOVE; cy++) {
      const chunk = await this.chunkProvider.getOrCreateAsync(tx, cy, tz);
      const hasContent = this.chunkHasContent(chunk);
      
      // Always include terrain chunks. Above terrain, stop at first empty chunk.
      if (cy <= terrainMaxCy || hasContent) {
        chunkDatas.push(chunk);
        chunks.push({
          cy,
          lastBuildSeq: chunk.lastBuildSeq,
          data: chunk.data,
        });
      }
      
      // Stop if we're above terrain and hit an empty chunk
      if (cy > terrainMaxCy && !hasContent) {
        break;
      }
    }
    
    // Step 4: Update tile from actual chunk surfaces
    // This captures trees/buildings that were generated with chunks
    for (const chunk of chunkDatas) {
      updateTileFromChunk(tile, chunk, (lx, lz) => 
        this.scanColumnForSurface(tx, tz, lx, lz, chunkDatas)
      );
    }
    
    console.log(`[SurfaceColumn] Returning ${chunks.length} chunks for (${tx}, ${tz})`);
    
    return { tile, chunks };
  }

  /**
   * Get the terrain chunk Y range (before stamps).
   */
  private getTerrainChunkRange(tile: MapTileData): { terrainMinCy: number; terrainMaxCy: number } {
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    
    for (let i = 0; i < tile.heights.length; i++) {
      const h = tile.heights[i];
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
    
    return {
      terrainMinCy: Math.floor(minHeight / CHUNK_SIZE),
      terrainMaxCy: Math.floor(maxHeight / CHUNK_SIZE),
    };
  }

  /**
   * Check if a chunk has any solid content.
   */
  private chunkHasContent(chunk: ChunkData): boolean {
    // Quick scan - check if any voxel has positive weight (solid)
    // Weight is in bits 12-15: 0 = -0.5 (empty), 15 = +0.5 (solid)
    // Values > 7 (weight > 0) mean solid
    for (let i = 0; i < chunk.data.length; i++) {
      const weightBits = (chunk.data[i] >> 12) & 0xF;
      if (weightBits > 7) {
        return true; // Found a solid voxel
      }
    }
    return false;
  }

  /**
   * Scan loaded chunks to find the surface at a specific XZ position.
   * Used for tile updates after all chunks are loaded.
   */
  private scanColumnForSurface(
    _tx: number,
    _tz: number,
    lx: number,
    lz: number,
    chunks: ChunkData[]
  ): { height: number; material: number } {
    // Sort chunks from highest to lowest
    const sortedChunks = [...chunks].sort((a, b) => b.cy - a.cy);
    
    // Scan from top down looking for surface (first solid voxel from above)
    for (const chunk of sortedChunks) {
      // Scan voxels in this column from top to bottom
      for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
        const index = lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE;
        const voxel = chunk.data[index];
        
        // Check if solid (weight > 0)
        // Weight is in bits 12-15: 0 = -0.5 (empty), 15 = +0.5 (solid)
        const weightBits = (voxel >> 12) & 0xF;
        
        if (weightBits > 7) {
          // Found surface voxel (solid)
          const material = (voxel >> 5) & 0x7F;
          const height = chunk.cy * CHUNK_SIZE + ly;
          return { height, material };
        }
      }
    }
    
    // No surface found - return sea level with default material
    return { height: 0, material: 0 };
  }
}
