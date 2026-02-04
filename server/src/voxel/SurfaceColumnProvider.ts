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

/** Buffer chunks below lowest surface (for caves, digging) - 0 for initial load, can request more later */
const CHUNKS_BELOW_SURFACE = 0;

/** Max height of trees/structures in voxels - if surface + this exceeds chunk boundary, include next chunk */
const MAX_STRUCTURE_HEIGHT = 12;

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
   * 1. Generate/load base tile from terrain
   * 2. Determine Y range from tile heights
   * 3. Generate/load all chunks in range
   * 4. Update tile from actual chunk surfaces (captures trees/buildings)
   * 5. Return bundled data
   */
  async getColumn(tx: number, tz: number): Promise<SurfaceColumn> {
    console.log(`[SurfaceColumn] Getting column (${tx}, ${tz})`);
    
    // Step 1: Get initial tile (may be terrain-only)
    let tile = await this.tileProvider.getOrCreateAsync(tx, tz);
    
    // Step 2: Determine Y chunk range from tile heights
    const { minCy, maxCy } = this.computeChunkRange(tile);
    console.log(`[SurfaceColumn] Y range: ${minCy} to ${maxCy} (${maxCy - minCy + 1} chunks)`);
    
    // Step 3: Generate/load all chunks in range
    const chunks: SurfaceColumn['chunks'] = [];
    const chunkDatas: ChunkData[] = [];
    
    for (let cy = minCy; cy <= maxCy; cy++) {
      const chunk = await this.chunkProvider.getOrCreateAsync(tx, cy, tz);
      chunkDatas.push(chunk);
      chunks.push({
        cy,
        lastBuildSeq: chunk.lastBuildSeq,
        data: chunk.data,
      });
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
   * Compute the Y chunk range based on tile heights.
   */
  private computeChunkRange(tile: MapTileData): { minCy: number; maxCy: number } {
    // Find min/max heights in tile
    let minHeight = Infinity;
    let maxHeight = -Infinity;
    
    for (let i = 0; i < tile.heights.length; i++) {
      const h = tile.heights[i];
      if (h < minHeight) minHeight = h;
      if (h > maxHeight) maxHeight = h;
    }
    
    // Convert heights (voxel Y units) to chunk Y indices
    // Height is in voxel units, chunk Y = floor(voxelY / CHUNK_SIZE)
    
    // Chunk containing lowest surface
    const surfaceMinCy = Math.floor(minHeight / CHUNK_SIZE);
    // Chunk containing highest surface
    const surfaceMaxCy = Math.floor(maxHeight / CHUNK_SIZE);
    
    // Only add chunk above if structures could extend into it
    // Check if maxHeight + structure height would exceed the current chunk's top
    const chunkTopY = (surfaceMaxCy + 1) * CHUNK_SIZE;
    const needsAboveChunk = (maxHeight + MAX_STRUCTURE_HEIGHT) >= chunkTopY;
    
    const minCy = surfaceMinCy - CHUNKS_BELOW_SURFACE;
    const maxCy = surfaceMaxCy + (needsAboveChunk ? 1 : 0);
    
    return { minCy, maxCy };
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
    
    // Scan from top down looking for surface
    for (const chunk of sortedChunks) {
      // Scan voxels in this column from top to bottom
      for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
        const index = lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE;
        const voxel = chunk.data[index];
        
        // Check if solid (weight < 0 in packed format)
        // Weight is in bits 12-15 (4 bits), 0-15 maps to -0.5 to 0.5
        const weightBits = (voxel >> 12) & 0xF;
        const weight = (weightBits / 15) - 0.5;
        
        if (weight < 0) {
          // Found surface voxel
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
