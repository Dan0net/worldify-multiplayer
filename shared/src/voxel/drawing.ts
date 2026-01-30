/**
 * Core voxel drawing functions - applies build operations to chunk data.
 * 
 * These functions are used by both client (preview + apply) and server (validate + apply).
 */

import { CHUNK_SIZE, VOXEL_SCALE } from './constants.js';
import { 
  BuildConfig, 
  BuildMode, 
  BuildOperation, 
  Vec3, 
  VoxelBBox,
  applyQuatToVec3,
  invertQuat,
  clamp,
} from './buildTypes.js';
import { sdfFromConfig, sdfToWeight } from './shapes.js';
import { 
  packVoxel, 
  unpackVoxel, 
  voxelIndex, 
  chunkKey,
} from './voxelData.js';
import { ChunkData } from './ChunkData.js';

// ============== Apply Functions ==============
// These modify a single voxel based on the build mode

/**
 * Apply ADD mode to a voxel.
 * Combines new weight with existing, takes maximum, updates material if weight increases.
 */
export function applyAdd(
  existingPacked: number,
  newWeight: number,
  newMaterial: number
): { packed: number; changed: boolean } {
  const existing = unpackVoxel(existingPacked);
  
  // ADD: take maximum of (existing, existing + new, new)
  const combinedWeight = clamp(
    Math.max(existing.weight, existing.weight + newWeight, newWeight),
    -0.5, 0.5
  );
  
  // Update material if new weight is >= existing
  const finalMaterial = newWeight >= existing.weight ? newMaterial : existing.material;
  
  const newPacked = packVoxel(combinedWeight, finalMaterial, existing.light);
  return { packed: newPacked, changed: newPacked !== existingPacked };
}

/**
 * Apply SUBTRACT mode to a voxel.
 * Takes minimum weight (carves out material).
 */
export function applySubtract(
  existingPacked: number,
  newWeight: number,
  _newMaterial: number
): { packed: number; changed: boolean } {
  const existing = unpackVoxel(existingPacked);
  
  // SUBTRACT: take minimum (newWeight is negative when inside the shape)
  if (newWeight < existing.weight) {
    const newPacked = packVoxel(newWeight, existing.material, existing.light);
    return { packed: newPacked, changed: true };
  }
  
  return { packed: existingPacked, changed: false };
}

/**
 * Apply PAINT mode to a voxel.
 * Only changes material where weight > 0 (solid areas) and shape overlaps.
 */
export function applyPaint(
  existingPacked: number,
  newWeight: number,
  newMaterial: number
): { packed: number; changed: boolean } {
  const existing = unpackVoxel(existingPacked);
  
  // PAINT: only paint where existing is solid AND new weight would make it solid
  if (newWeight > 0 && existing.weight > 0) {
    const newPacked = packVoxel(existing.weight, newMaterial, existing.light);
    return { packed: newPacked, changed: existing.material !== newMaterial };
  }
  
  return { packed: existingPacked, changed: false };
}

/**
 * Apply FILL mode to a voxel.
 * Only fills where existing weight <= 0 (empty areas).
 */
export function applyFill(
  existingPacked: number,
  newWeight: number,
  newMaterial: number
): { packed: number; changed: boolean } {
  const existing = unpackVoxel(existingPacked);
  
  // FILL: only fill empty voxels
  if (newWeight > existing.weight && existing.weight <= 0) {
    const newPacked = packVoxel(newWeight, newMaterial, existing.light);
    return { packed: newPacked, changed: true };
  }
  
  return { packed: existingPacked, changed: false };
}

/** Type for apply functions */
type ApplyFunction = (
  existingPacked: number,
  newWeight: number,
  newMaterial: number
) => { packed: number; changed: boolean };

/** Registry mapping build modes to their apply functions */
const APPLY_FUNCTIONS: Record<BuildMode, ApplyFunction> = {
  [BuildMode.ADD]: applyAdd,
  [BuildMode.SUBTRACT]: applySubtract,
  [BuildMode.PAINT]: applyPaint,
  [BuildMode.FILL]: applyFill,
};

/**
 * Get the apply function for a build mode.
 */
export function getApplyFunction(mode: BuildMode): ApplyFunction {
  return APPLY_FUNCTIONS[mode] ?? applyAdd;
}

// ============== Bounding Box Calculation ==============

/**
 * Calculate the voxel-space bounding box for a build operation.
 * Returns the range of voxels that could be affected.
 */
export function calculateBuildBBox(operation: BuildOperation): VoxelBBox {
  const { center, config } = operation;
  
  // Calculate max radius in any direction (conservative estimate for rotated shapes)
  const maxSize = Math.max(config.size.x, config.size.y, config.size.z);
  // Add some margin for rotation and smooth transitions
  const margin = maxSize + 2;
  
  // Convert world center to voxel coordinates
  const centerVoxelX = center.x / VOXEL_SCALE;
  const centerVoxelY = center.y / VOXEL_SCALE;
  const centerVoxelZ = center.z / VOXEL_SCALE;
  
  return {
    minX: Math.floor(centerVoxelX - margin),
    minY: Math.floor(centerVoxelY - margin),
    minZ: Math.floor(centerVoxelZ - margin),
    maxX: Math.ceil(centerVoxelX + margin),
    maxY: Math.ceil(centerVoxelY + margin),
    maxZ: Math.ceil(centerVoxelZ + margin),
  };
}

/**
 * Get all chunk keys that could be affected by a build operation.
 */
export function getAffectedChunks(operation: BuildOperation): string[] {
  const bbox = calculateBuildBBox(operation);
  const chunks = new Set<string>();
  
  // Convert voxel bounds to chunk bounds
  const minCx = Math.floor(bbox.minX / CHUNK_SIZE);
  const minCy = Math.floor(bbox.minY / CHUNK_SIZE);
  const minCz = Math.floor(bbox.minZ / CHUNK_SIZE);
  const maxCx = Math.floor(bbox.maxX / CHUNK_SIZE);
  const maxCy = Math.floor(bbox.maxY / CHUNK_SIZE);
  const maxCz = Math.floor(bbox.maxZ / CHUNK_SIZE);
  
  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cy = minCy; cy <= maxCy; cy++) {
      for (let cx = minCx; cx <= maxCx; cx++) {
        chunks.add(chunkKey(cx, cy, cz));
      }
    }
  }
  
  return Array.from(chunks);
}

// ============== Core Drawing Function ==============

/**
 * Draw a build operation to a single chunk's data array.
 * 
 * @param chunk The chunk to modify
 * @param operation The build operation
 * @param targetData Optional data array to write to (defaults to chunk.data)
 * @returns True if any voxels were changed
 */
export function drawToChunk(
  chunk: ChunkData,
  operation: BuildOperation,
  targetData: Uint16Array = chunk.data
): boolean {
  const { center, rotation, config } = operation;
  
  // Get the inverse rotation to transform voxel positions into shape space
  const invRotation = invertQuat(rotation);
  
  // Get chunk world position
  const chunkWorldPos = chunk.getWorldPosition();
  
  // Get the apply function for this mode
  const applyFn = getApplyFunction(config.mode);
  
  // Weight multiplier for subtract mode
  const weightMult = config.mode === BuildMode.SUBTRACT ? -1 : 1;
  
  let anyChanged = false;
  
  // Calculate local bounding box within this chunk
  // (Could optimize this further by intersecting with operation bbox)
  for (let lz = 0; lz < CHUNK_SIZE; lz++) {
    for (let ly = 0; ly < CHUNK_SIZE; ly++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        // Convert local voxel coords to world position (center of voxel)
        const worldX = chunkWorldPos.x + (lx) * VOXEL_SCALE;
        const worldY = chunkWorldPos.y + (ly) * VOXEL_SCALE;
        const worldZ = chunkWorldPos.z + (lz) * VOXEL_SCALE;
        
        // Position relative to build center
        const relPos: Vec3 = {
          x: worldX - center.x,
          y: worldY - center.y,
          z: worldZ - center.z,
        };
        
        // Transform to shape's local space (inverse rotate)
        const localPos = applyQuatToVec3(relPos, invRotation);
        
        // Calculate SDF distance
        const sdfDist = sdfFromConfig(localPos, config);
        
        // Only process voxels that are near the shape (within ~1 voxel of surface)
        if (sdfDist > 1.5) continue;
        
        // Convert SDF to weight
        const weight = sdfToWeight(sdfDist) * weightMult;
        
        // Apply the build mode
        const idx = voxelIndex(lx, ly, lz);
        const existingPacked = targetData[idx];
        const { packed, changed } = applyFn(existingPacked, weight, config.material);
        
        if (changed) {
          targetData[idx] = packed;
          anyChanged = true;
        }
      }
    }
  }
  
  return anyChanged;
}

/**
 * Draw a build operation to multiple chunks.
 * 
 * @param chunks Map of chunk key to ChunkData
 * @param operation The build operation
 * @returns Array of chunk keys that were modified
 */
export function drawToChunks(
  chunks: Map<string, ChunkData>,
  operation: BuildOperation
): string[] {
  const affectedKeys = getAffectedChunks(operation);
  const modifiedKeys: string[] = [];
  
  for (const key of affectedKeys) {
    const chunk = chunks.get(key);
    if (chunk) {
      const changed = drawToChunk(chunk, operation);
      if (changed) {
        modifiedKeys.push(key);
      }
    }
  }
  
  return modifiedKeys;
}

/**
 * Create a simple build operation from position and config.
 * Uses identity rotation (no rotation).
 */
export function createBuildOperation(
  centerX: number,
  centerY: number,
  centerZ: number,
  config: BuildConfig
): BuildOperation {
  return {
    center: { x: centerX, y: centerY, z: centerZ },
    rotation: { x: 0, y: 0, z: 0, w: 1 },  // Identity quaternion
    config,
  };
}
