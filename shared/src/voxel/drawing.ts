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
  BuildPart,
  VoxelBBox,
  clamp,
} from './buildTypes.js';
import { Vec3, applyQuatToVec3, invertQuat } from '../util/math.js';
import { sdfFromConfig, sdfToWeight } from './shapes.js';
import {
  unpackVoxel,
  setWeight,
  setMaterial,
  voxelIndex,
  chunkKey,
} from './voxelData.js';
import { ChunkData } from './ChunkData.js';
import { isTransparent } from '../materials/Materials.js';

// ============== Apply Functions ==============
// These modify a single voxel based on the build mode

/**
 * Rewrite a voxel's weight + material while preserving BOTH light channels (sky AND block). Edits
 * change geometry, not light — the lighting pass owns light. packVoxel() would zero the block-light
 * field, which is harmless for a commit (a relight follows and recomputes it) but wrong for an
 * un-relit preview: in the 'off' preview mode nothing relights until commit, so dropping block light
 * would darken any torch-lit voxel the brush touched. Bit-preserving setWeight/setMaterial keep the
 * existing light untouched.
 */
function repackKeepLight(existingPacked: number, weight: number, material: number): number {
  return setMaterial(setWeight(existingPacked, weight), material);
}

/**
 * Apply ADD mode to a voxel.
 * Combines new weight with existing, takes maximum, updates material if weight increases.
 * Solid materials always overwrite transparent materials.
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
  
  // Update material if new weight is >= existing,
  // or if we're overwriting a transparent material with a solid one
  const existingIsTransparent = existing.weight > 0 && isTransparent(existing.material);
  const newIsSolid = !isTransparent(newMaterial);
  const finalMaterial = (newWeight >= existing.weight || (existingIsTransparent && newIsSolid && newWeight > 0))
    ? newMaterial : existing.material;
  
  const newPacked = repackKeepLight(existingPacked, combinedWeight, finalMaterial);
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
    const newPacked = repackKeepLight(existingPacked, newWeight, existing.material);
    return { packed: newPacked, changed: true };
  }
  
  return { packed: existingPacked, changed: false };
}

/**
 * Apply PUNCH mode to a voxel: a material-filtered subtract.
 * Carves (takes minimum weight) exactly like SUBTRACT, but only when the existing voxel's material
 * equals `targetMaterial` — voxels of any other material are left untouched. This lets a left-click
 * "punch" dig a blob of only the hit material (e.g. grass) without disturbing neighbouring stone.
 */
/** Weight removed per punch — incremental so digging is gradual (weight is 4-bit quantized). */
const PUNCH_WEIGHT_STEP = 0.25;

export function applyPunch(
  existingPacked: number,
  newWeight: number,
  targetMaterial: number
): { packed: number; changed: boolean } {
  const existing = unpackVoxel(existingPacked);

  // Only carve voxels of the matched material (material 0 is a real material — moss2 — not air).
  if (existing.material !== targetMaterial) {
    return { packed: existingPacked, changed: false };
  }

  // A voxel the sphere covers has newWeight > 0 (PUNCH keeps the +1 weight multiplier). Carve the
  // whole covered volume uniformly — decrement the stored weight by a fixed step — so the blob is
  // solid (no rim-only shell / centre hole) and incremental.
  if (newWeight <= 0) {
    return { packed: existingPacked, changed: false };
  }
  const carved = Math.max(-0.5, existing.weight - PUNCH_WEIGHT_STEP);
  if (carved >= existing.weight) {
    return { packed: existingPacked, changed: false };
  }
  return { packed: repackKeepLight(existingPacked, carved, existing.material), changed: true };
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
    const newPacked = repackKeepLight(existingPacked, existing.weight, newMaterial);
    return { packed: newPacked, changed: existing.material !== newMaterial };
  }
  
  return { packed: existingPacked, changed: false };
}

/**
 * Apply FILL mode to a voxel.
 * Only fills where existing weight <= 0 (empty areas) OR
 * where existing material is transparent (allows solid to overwrite transparent).
 */
export function applyFill(
  existingPacked: number,
  newWeight: number,
  newMaterial: number
): { packed: number; changed: boolean } {
  const existing = unpackVoxel(existingPacked);
  
  // FILL: fill empty voxels, or overwrite transparent materials with solid ones
  const existingIsTransparent = existing.weight > 0 && isTransparent(existing.material);
  const newIsSolid = !isTransparent(newMaterial);
  
  if (newWeight > 0 && (existing.weight <= 0 || (existingIsTransparent && newIsSolid))) {
    const finalWeight = Math.max(newWeight, existing.weight);
    const newPacked = repackKeepLight(existingPacked, finalWeight, newMaterial);
    return { packed: newPacked, changed: newPacked !== existingPacked };
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
  [BuildMode.PUNCH]: applyPunch,
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
  const { center, parts } = operation;

  // Convert world center to voxel coordinates
  const centerVoxelX = center.x / VOXEL_SCALE;
  const centerVoxelY = center.y / VOXEL_SCALE;
  const centerVoxelZ = center.z / VOXEL_SCALE;

  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

  for (const part of parts) {
    const { size } = part.config;
    // Max radius in any direction (conservative estimate for rotated shapes) + margin
    // for rotation, smooth transitions, and 1 extra voxel so surface nets can read the
    // empty neighbor row beyond the SDF boundary.
    const margin = Math.max(size.x, size.y, size.z) + 3;
    // The part sits `offset` (voxel units) from center in the pre-rotation frame; after
    // rotation it can lie |offset| away in any direction, so add its length to the radius.
    const offLen = Math.sqrt(
      part.offset.x * part.offset.x + part.offset.y * part.offset.y + part.offset.z * part.offset.z
    );
    const r = margin + offLen;
    minX = Math.min(minX, centerVoxelX - r); maxX = Math.max(maxX, centerVoxelX + r);
    minY = Math.min(minY, centerVoxelY - r); maxY = Math.max(maxY, centerVoxelY + r);
    minZ = Math.min(minZ, centerVoxelZ - r); maxZ = Math.max(maxZ, centerVoxelZ + r);
  }

  return {
    minX: Math.floor(minX),
    minY: Math.floor(minY),
    minZ: Math.floor(minZ),
    maxX: Math.ceil(maxX),
    maxY: Math.ceil(maxY),
    maxZ: Math.ceil(maxZ),
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

// ============== Parts → voxel-stamp rasterizer ==============

/** A rasterized voxel: integer offset from origin + material + weight. Structurally a StampVoxel. */
export interface RasterVoxel {
  x: number; y: number; z: number; material: number; weight: number;
}

/**
 * Rasterize a `BuildPart[]` (canonical +Y, voxel-unit sizes/offsets) into voxel stamps at identity
 * rotation, reusing the SAME `sdfFromConfig` + `sdfToWeight` stack as `drawToChunk`. This lets
 * terrain generation place any build preset (e.g. the Torch) as a stamp through one shared code
 * path — no duplicated SDF/weight logic. Emits solid voxels (composite ADD: max weight per voxel,
 * material of the strongest part). Returns integer voxel offsets from the parts' origin.
 */
export function rasterizePartsToStampVoxels(parts: BuildPart[]): RasterVoxel[] {
  const out: RasterVoxel[] = [];
  if (parts.length === 0) return out;

  // Integer-voxel bbox over all parts (size is a voxel half-extent; +2 for the surface band).
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const p of parts) {
    const s = p.config.size, o = p.offset;
    const m = Math.max(s.x, s.y, s.z) + 2;
    minX = Math.min(minX, o.x - s.x - m); maxX = Math.max(maxX, o.x + s.x + m);
    minY = Math.min(minY, o.y - s.y - m); maxY = Math.max(maxY, o.y + s.y + m);
    minZ = Math.min(minZ, o.z - s.z - m); maxZ = Math.max(maxZ, o.z + s.z + m);
  }
  const x0 = Math.floor(minX), x1 = Math.ceil(maxX);
  const y0 = Math.floor(minY), y1 = Math.ceil(maxY);
  const z0 = Math.floor(minZ), z1 = Math.ceil(maxZ);

  const pp: Vec3 = { x: 0, y: 0, z: 0 };
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        let bestWeight = 0;
        let bestMat = 0;
        for (const part of parts) {
          // Part-local position in world metres (sdfFromConfig scales size by VOXEL_SCALE).
          pp.x = (x - part.offset.x) * VOXEL_SCALE;
          pp.y = (y - part.offset.y) * VOXEL_SCALE;
          pp.z = (z - part.offset.z) * VOXEL_SCALE;
          const d = sdfFromConfig(pp, part.config);
          if (d > 1.5) continue;
          const w = sdfToWeight(d);
          if (w > bestWeight) { bestWeight = w; bestMat = part.config.material; }
        }
        if (bestWeight > 0) out.push({ x, y, z, material: bestMat, weight: bestWeight });
      }
    }
  }
  return out;
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
  targetData: Uint32Array = chunk.data
): boolean {
  const { center, rotation } = operation;

  // Get the inverse rotation to transform voxel positions into shape space
  const invRotation = invertQuat(rotation);

  // Get chunk world position
  const chunkWorldPos = chunk.getWorldPosition();

  // Precompute per-part draw state. All parts share `rotation`, so in shape-local space
  // a part is just a translation by its offset (voxel units → world units). One
  // inverse-rotate per voxel is reused across every part.
  const prepared = operation.parts.map((part) => ({
    applyFn: getApplyFunction(part.config.mode),
    weightMult: part.config.mode === BuildMode.SUBTRACT ? -1 : 1,
    material: part.config.material,
    config: part.config,
    ox: part.offset.x * VOXEL_SCALE,
    oy: part.offset.y * VOXEL_SCALE,
    oz: part.offset.z * VOXEL_SCALE,
  }));

  let anyChanged = false;

  // Scratch object reused per part to avoid per-voxel allocation.
  const partPos: Vec3 = { x: 0, y: 0, z: 0 };

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

        // Transform to shape's local space (inverse rotate) — shared across all parts
        const localPos = applyQuatToVec3(relPos, invRotation);

        // Fold every part into this voxel in order (composite atomically).
        const idx = voxelIndex(lx, ly, lz);
        let current = targetData[idx];
        let voxelChanged = false;

        for (const part of prepared) {
          // Part-local position = shape-local position minus the part's offset.
          partPos.x = localPos.x - part.ox;
          partPos.y = localPos.y - part.oy;
          partPos.z = localPos.z - part.oz;

          const sdfDist = sdfFromConfig(partPos, part.config);
          // Only process voxels near this part's surface (within ~1 voxel).
          if (sdfDist > 1.5) continue;

          const weight = sdfToWeight(sdfDist) * part.weightMult;
          const { packed, changed } = part.applyFn(current, weight, part.material);
          if (changed) {
            current = packed;
            voxelChanged = true;
          }
        }

        if (voxelChanged) {
          targetData[idx] = current;
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
    parts: [{ config, offset: { x: 0, y: 0, z: 0 } }],
  };
}
