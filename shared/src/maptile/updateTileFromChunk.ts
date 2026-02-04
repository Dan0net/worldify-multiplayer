/**
 * Update map tile from chunk data - shared between client and server.
 * 
 * Scans a chunk to find the highest solid voxel in each column and
 * updates the map tile with the surface height and material.
 */

import { CHUNK_SIZE } from '../voxel/constants.js';
import { isVoxelSolid, getMaterial, voxelIndex } from '../voxel/voxelData.js';
import { MapTileData, tilePixelIndex } from './MapTileData.js';

/**
 * Chunk-like interface - works with both Chunk and ChunkData classes.
 */
export interface ChunkLike {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly data: Uint16Array;
}

/**
 * Fallback function type for rescanning a column when a dig removes the surface.
 * Returns the new surface height and material for a given local x,z position.
 */
export type ColumnRescanFn = (lx: number, lz: number) => { height: number; material: number };

/**
 * Update a map tile with surface data from a chunk.
 * 
 * Scans each XZ column in the chunk to find the highest solid voxel.
 * If the chunk contains a higher surface than currently recorded, updates the tile.
 * If the current recorded surface was in this chunk and is now air, uses the
 * fallback rescan function (if provided) to find the new surface.
 * 
 * @param tile - The map tile to update
 * @param chunk - The chunk data to scan
 * @param fallbackRescan - Optional function to rescan a column when digging (server-side)
 */
export function updateTileFromChunk(
  tile: MapTileData,
  chunk: ChunkLike,
  fallbackRescan?: ColumnRescanFn
): void {
  const chunkMinY = chunk.cy * CHUNK_SIZE;
  const chunkMaxY = chunkMinY + CHUNK_SIZE - 1;

  // Scan each XZ column in the chunk
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      const pixelIndex = tilePixelIndex(lx, lz);
      const currentHeight = tile.heights[pixelIndex];
      
      let maxHeight = currentHeight;
      let surfaceMaterial = tile.materials[pixelIndex];
      
      // Scan from top to bottom of this chunk to find highest solid voxel
      for (let ly = CHUNK_SIZE - 1; ly >= 0; ly--) {
        const voxelY = chunkMinY + ly;
        const index = voxelIndex(lx, ly, lz);
        const voxel = chunk.data[index];
        
        if (isVoxelSolid(voxel)) {
          if (voxelY > maxHeight) {
            maxHeight = voxelY;
            surfaceMaterial = getMaterial(voxel);
          }
          break; // Found surface for this column in this chunk
        }
      }
      
      // Check if the current recorded height was in this chunk and might now be air
      // (handles dig operations that remove the surface)
      if (currentHeight >= chunkMinY && currentHeight <= chunkMaxY) {
        // Check if the voxel at current height is still solid
        const ly = currentHeight - chunkMinY;
        if (ly >= 0 && ly < CHUNK_SIZE) {
          const index = voxelIndex(lx, ly, lz);
          const voxel = chunk.data[index];
          
          if (!isVoxelSolid(voxel)) {
            // Surface was removed, need to rescan
            if (fallbackRescan) {
              const { height, material } = fallbackRescan(lx, lz);
              maxHeight = height;
              surfaceMaterial = material;
            } else {
              // Client-side: scan this chunk for the new surface
              // (best effort - may miss surfaces in other chunks)
              for (let scanLy = CHUNK_SIZE - 1; scanLy >= 0; scanLy--) {
                const scanIndex = voxelIndex(lx, scanLy, lz);
                const scanVoxel = chunk.data[scanIndex];
                if (isVoxelSolid(scanVoxel)) {
                  maxHeight = chunkMinY + scanLy;
                  surfaceMaterial = getMaterial(scanVoxel);
                  break;
                }
              }
              // If no solid found in this chunk, keep a lower default
              // (will be corrected when lower chunks are loaded/modified)
            }
          }
        }
      }
      
      tile.heights[pixelIndex] = maxHeight;
      tile.materials[pixelIndex] = surfaceMaterial;
    }
  }
}
