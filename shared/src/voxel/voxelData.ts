/**
 * Voxel data packing/unpacking utilities and coordinate helpers
 */

import {
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  VOXEL_SCALE,
  WEIGHT_MIN,
  WEIGHT_RANGE,
  WEIGHT_MAX_PACKED,
  WEIGHT_SHIFT,
  WEIGHT_MASK,
  MATERIAL_SHIFT,
  MATERIAL_MASK,
  MATERIAL_MAX,
  LIGHT_MASK,
  LIGHT_MAX,
  SURFACE_PACKED_THRESHOLD,
} from './constants.js';
import { MATERIAL_TYPE_LUT } from '../materials/Materials.js';

// ============== Types ==============

export interface UnpackedVoxel {
  weight: number;
  material: number;
  light: number;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
  cz: number;
}

export interface VoxelCoord {
  vx: number;
  vy: number;
  vz: number;
}

export interface WorldCoord {
  x: number;
  y: number;
  z: number;
}

// ============== Voxel Packing/Unpacking ==============

/**
 * Pack weight, material, and light into a 16-bit voxel value.
 * @param weight - Weight value from -0.5 to +0.5 (surface at 0)
 * @param material - Material ID from 0 to 127
 * @param light - Light level from 0 to 31
 * @returns Packed 16-bit voxel value
 */
export function packVoxel(weight: number, material: number, light: number): number {
  // Normalize weight from [-0.5, 0.5] to [0, 15]
  const normalizedWeight = (weight - WEIGHT_MIN) / WEIGHT_RANGE;
  const packedWeight = Math.round(normalizedWeight * WEIGHT_MAX_PACKED);
  
  // Clamp values to valid ranges
  const clampedWeight = Math.max(0, Math.min(WEIGHT_MAX_PACKED, packedWeight));
  const clampedMaterial = Math.max(0, Math.min(MATERIAL_MAX, material | 0));
  const clampedLight = Math.max(0, Math.min(LIGHT_MAX, light | 0));
  
  // Pack: WWWW MMMMMMM LLLLL
  return (clampedWeight << WEIGHT_SHIFT) | (clampedMaterial << MATERIAL_SHIFT) | clampedLight;
}

/**
 * Unpack a 16-bit voxel value into weight, material, and light.
 * @param packed - Packed 16-bit voxel value
 * @returns Object with weight (-0.5 to +0.5), material (0-127), and light (0-31)
 */
export function unpackVoxel(packed: number): UnpackedVoxel {
  return {
    weight: getWeight(packed),
    material: getMaterial(packed),
    light: getLight(packed),
  };
}

/**
 * Extract weight from packed voxel, returning value in range [-0.5, +0.5].
 */
export function getWeight(packed: number): number {
  const packedWeight = (packed >> WEIGHT_SHIFT) & WEIGHT_MASK;
  // Convert from [0, 15] back to [-0.5, 0.5]
  return (packedWeight / WEIGHT_MAX_PACKED) * WEIGHT_RANGE + WEIGHT_MIN;
}

/**
 * Extract material ID from packed voxel (0-127).
 */
export function getMaterial(packed: number): number {
  return (packed >> MATERIAL_SHIFT) & MATERIAL_MASK;
}

/**
 * Extract light level from packed voxel (0-31).
 */
export function getLight(packed: number): number {
  return packed & LIGHT_MASK;
}

/**
 * Check if a packed voxel is solid (weight > 0).
 * Solid voxels are inside terrain/objects.
 */
export function isVoxelSolid(packed: number): boolean {
  // Weight bits > threshold means weight > 0 (solid)
  // This avoids floating point conversion for performance
  const packedWeight = (packed >> WEIGHT_SHIFT) & WEIGHT_MASK;
  return packedWeight > SURFACE_PACKED_THRESHOLD;
}

/**
 * Fast check whether a packed voxel data array contains any surface crossings.
 * A surface exists when:
 *  1. There are both "inside" (solid) and "outside" (air) voxels, OR
 *  2. Solid voxels have mixed material types (solid/transparent/liquid),
 *     because the SurfaceNet's material-type splitting creates surfaces
 *     between different material types (e.g. terrain vs water).
 * 
 * Uses raw bit operations on the packed data — no float conversion.
 * Short-circuits as soon as a crossing is detected.
 * 
 * @param data Flat packed voxel data (Uint16Array)
 * @returns true if a surface crossing exists in the data
 */
export function hasSurfaceCrossing(data: Uint16Array): boolean {
  let hasInside = false;
  let hasOutside = false;
  // Track first material type seen among solid voxels (-1 = none yet)
  let solidMatType = -1;
  const len = data.length;
  for (let i = 0; i < len; ++i) {
    const v = data[i];
    if (((v >> WEIGHT_SHIFT) & WEIGHT_MASK) > SURFACE_PACKED_THRESHOLD) {
      hasInside = true;
      if (hasOutside) return true;
      // Check for mixed material types among solid voxels
      const matId = (v >> MATERIAL_SHIFT) & MATERIAL_MASK;
      const mt = MATERIAL_TYPE_LUT[matId];
      if (solidMatType === -1) {
        solidMatType = mt;
      } else if (mt !== solidMatType) {
        return true; // Mixed material types → surface between them
      }
    } else {
      hasOutside = true;
      if (hasInside) return true;
    }
  }
  return false;
}

/**
 * Check if a packed voxel is empty (weight < 0).
 * Empty voxels are air/outside terrain.
 */
export function isVoxelEmpty(packed: number): boolean {
  const packedWeight = (packed >> WEIGHT_SHIFT) & WEIGHT_MASK;
  return packedWeight < SURFACE_PACKED_THRESHOLD;
}

/**
 * Check if a packed voxel is near the surface (weight close to 0).
 * Surface voxels are at the boundary between solid and empty.
 */
export function isVoxelSurface(packed: number): boolean {
  const packedWeight = (packed >> WEIGHT_SHIFT) & WEIGHT_MASK;
  const mid = WEIGHT_MAX_PACKED >> 1;
  // Consider surface if within 1 unit of midpoint
  return packedWeight >= mid - 1 && packedWeight <= mid + 1;
}

/**
 * Create a new packed voxel with updated weight, preserving material and light.
 * Uses bit ops — clears weight bits and sets new ones without touching material/light.
 */
export function setWeight(packed: number, weight: number): number {
  const normalizedWeight = (weight - WEIGHT_MIN) / WEIGHT_RANGE;
  const packedWeight = Math.max(0, Math.min(WEIGHT_MAX_PACKED, Math.round(normalizedWeight * WEIGHT_MAX_PACKED)));
  return (packed & ~(WEIGHT_MASK << WEIGHT_SHIFT)) | (packedWeight << WEIGHT_SHIFT);
}

/**
 * Create a new packed voxel with updated material, preserving weight and light.
 * Uses bit ops — clears material bits and sets new ones without touching weight/light.
 */
export function setMaterial(packed: number, material: number): number {
  const clampedMat = Math.max(0, Math.min(MATERIAL_MAX, material | 0));
  return (packed & ~(MATERIAL_MASK << MATERIAL_SHIFT)) | (clampedMat << MATERIAL_SHIFT);
}

/**
 * Create a new packed voxel with updated light, preserving weight and material.
 * Uses bit ops — light occupies the bottom 5 bits so no unpack/repack needed.
 */
export function setLight(packed: number, light: number): number {
  return (packed & ~LIGHT_MASK) | (Math.max(0, Math.min(LIGHT_MAX, light | 0)));
}

// ============== Coordinate Conversions ==============

/**
 * Convert world coordinates to chunk coordinates.
 * Chunks are 8m x 8m x 8m, centered at origin (negative coords allowed).
 */
export function worldToChunk(x: number, y: number, z: number): ChunkCoord {
  return {
    cx: Math.floor(x / CHUNK_WORLD_SIZE),
    cy: Math.floor(y / CHUNK_WORLD_SIZE),
    cz: Math.floor(z / CHUNK_WORLD_SIZE),
  };
}

/**
 * Convert chunk coordinates to world coordinates (returns min corner of chunk).
 */
export function chunkToWorld(cx: number, cy: number, cz: number): WorldCoord {
  return {
    x: cx * CHUNK_WORLD_SIZE,
    y: cy * CHUNK_WORLD_SIZE,
    z: cz * CHUNK_WORLD_SIZE,
  };
}

/**
 * Convert world coordinates to global voxel coordinates.
 */
export function worldToVoxel(x: number, y: number, z: number): VoxelCoord {
  return {
    vx: Math.floor(x / VOXEL_SCALE),
    vy: Math.floor(y / VOXEL_SCALE),
    vz: Math.floor(z / VOXEL_SCALE),
  };
}

/**
 * Convert global voxel coordinates to world coordinates (returns voxel center).
 */
export function voxelToWorld(vx: number, vy: number, vz: number): WorldCoord {
  return {
    x: (vx + 0.5) * VOXEL_SCALE,
    y: (vy + 0.5) * VOXEL_SCALE,
    z: (vz + 0.5) * VOXEL_SCALE,
  };
}

/**
 * Convert local voxel coordinates (within a chunk) to flat array index.
 * Uses Y-up layout: index = x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE
 */
export function voxelIndex(x: number, y: number, z: number): number {
  return x + y * CHUNK_SIZE + z * CHUNK_SIZE * CHUNK_SIZE;
}

/**
 * Convert flat array index back to local voxel coordinates.
 */
export function indexToVoxel(index: number): VoxelCoord {
  const z = Math.floor(index / (CHUNK_SIZE * CHUNK_SIZE));
  const remainder = index % (CHUNK_SIZE * CHUNK_SIZE);
  const y = Math.floor(remainder / CHUNK_SIZE);
  const x = remainder % CHUNK_SIZE;
  return { vx: x, vy: y, vz: z };
}

/**
 * Convert global voxel coordinates to local chunk coordinates.
 * Returns which chunk the voxel is in and the local position within that chunk.
 */
export function globalVoxelToLocal(vx: number, vy: number, vz: number): {
  chunk: ChunkCoord;
  local: VoxelCoord;
} {
  const chunk: ChunkCoord = {
    cx: Math.floor(vx / CHUNK_SIZE),
    cy: Math.floor(vy / CHUNK_SIZE),
    cz: Math.floor(vz / CHUNK_SIZE),
  };
  
  // Handle negative coordinates correctly with modulo
  const local: VoxelCoord = {
    vx: ((vx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
    vy: ((vy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
    vz: ((vz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE,
  };
  
  return { chunk, local };
}

/**
 * Create a unique string key for a chunk coordinate (for use in Maps).
 */
export function chunkKey(cx: number, cy: number, cz: number): string {
  return `${cx},${cy},${cz}`;
}

/**
 * Parse a chunk key back to coordinates.
 */
export function parseChunkKey(key: string): ChunkCoord {
  const [cx, cy, cz] = key.split(',').map(Number);
  return { cx, cy, cz };
}

/**
 * Check if local voxel coordinates are within chunk bounds.
 */
export function isInChunkBounds(x: number, y: number, z: number): boolean {
  return x >= 0 && x < CHUNK_SIZE &&
         y >= 0 && y < CHUNK_SIZE &&
         z >= 0 && z < CHUNK_SIZE;
}
