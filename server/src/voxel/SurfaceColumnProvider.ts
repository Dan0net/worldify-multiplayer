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
  MapTileData,
  updateTileFromChunk,
  chunkHasContent,
  scanMultiChunkColumn,
  getChunkRangeFromHeights,
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
    
    // Step 2: Get terrain chunk range from tile heights
    const { minCy: terrainMinCy, maxCy: terrainMaxCy } = getChunkRangeFromHeights(tile.heights);
    const minCy = terrainMinCy - CHUNKS_BELOW_SURFACE;
    
    // Step 3: Generate chunks upward, stop when we hit empty sky above terrain
    const chunks: SurfaceColumn['chunks'] = [];
    const chunkDatas: ChunkData[] = [];
    
    for (let cy = minCy; cy <= terrainMaxCy + MAX_CHUNKS_ABOVE; cy++) {
      const chunk = await this.chunkProvider.getOrCreateAsync(tx, cy, tz);
      const hasContent = chunkHasContent(chunk.data);
      
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
        scanMultiChunkColumn(chunkDatas, lx, lz)
      );
    }
    
    console.log(`[SurfaceColumn] Returning ${chunks.length} chunks for (${tx}, ${tz})`);
    
    return { tile, chunks };
  }
}
