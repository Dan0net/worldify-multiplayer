/**
 * Unit tests for build system Phase 1: shapes, drawing, and buildTypes
 */

import { describe, test, expect } from 'vitest';

import { CHUNK_SIZE, CHUNK_WORLD_SIZE, VOXELS_PER_CHUNK } from './constants.js';
import { packVoxel, unpackVoxel, voxelIndex } from './voxelData.js';
import { ChunkData } from './ChunkData.js';

// buildTypes tests
import {
  BuildMode,
  BuildShape,
  BuildConfig,
  Vec3,
  Quat,
  createDefaultBuildConfig,
  identityQuat,
  applyQuatToVec3,
  invertQuat,
  clamp,
} from './buildTypes.js';

// shapes tests
import {
  sdfSphere,
  sdfBox,
  sdfCylinder,
  hollowSdf,
  sdfFromConfig,
  sdfToWeight,
} from './shapes.js';

// drawing tests
import {
  applyAdd,
  applySubtract,
  applyPaint,
  applyFill,
  calculateBuildBBox,
  getAffectedChunks,
  drawToChunk,
  createBuildOperation,
} from './drawing.js';

describe('buildTypes.ts Tests', () => {
  test('createDefaultBuildConfig returns valid config', () => {
    const config = createDefaultBuildConfig();
    expect(config.shape).toBe(BuildShape.CUBE);
    expect(config.mode).toBe(BuildMode.ADD);
    expect(config.size.x).toBe(2);
    expect(config.size.y).toBe(2);
    expect(config.size.z).toBe(2);
    expect(config.material).toBe(1);
  });

  test('identityQuat returns identity quaternion', () => {
    const q = identityQuat();
    expect(q.x).toBe(0);
    expect(q.y).toBe(0);
    expect(q.z).toBe(0);
    expect(q.w).toBe(1);
  });

  test('applyQuatToVec3 with identity does not change vector', () => {
    const v: Vec3 = { x: 1, y: 2, z: 3 };
    const q = identityQuat();
    const result = applyQuatToVec3(v, q);
    expect(result.x).toBeCloseTo(1);
    expect(result.y).toBeCloseTo(2);
    expect(result.z).toBeCloseTo(3);
  });

  test('applyQuatToVec3 with 90deg Y rotation rotates correctly', () => {
    const v: Vec3 = { x: 1, y: 0, z: 0 };
    // 90 degrees around Y axis: quat = (0, sin(45°), 0, cos(45°))
    const angle = Math.PI / 2;
    const q: Quat = { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
    const result = applyQuatToVec3(v, q);
    // (1,0,0) rotated 90° around Y should be (0,0,-1)
    expect(result.x).toBeCloseTo(0, 3);
    expect(result.y).toBeCloseTo(0, 3);
    expect(result.z).toBeCloseTo(-1, 3);
  });

  test('invertQuat returns conjugate', () => {
    const q: Quat = { x: 0.1, y: 0.2, z: 0.3, w: 0.9 };
    const inv = invertQuat(q);
    expect(inv.x).toBe(-0.1);
    expect(inv.y).toBe(-0.2);
    expect(inv.z).toBe(-0.3);
    expect(inv.w).toBe(0.9);
  });

  test('clamp works correctly', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(15, 0, 10)).toBe(10);
  });
});

describe('shapes.ts Tests', () => {
  test('sdfSphere returns negative inside, positive outside', () => {
    // Center of sphere (radius 2)
    expect(sdfSphere({ x: 0, y: 0, z: 0 }, 2)).toBeLessThan(0);
    // On surface
    expect(sdfSphere({ x: 2, y: 0, z: 0 }, 2)).toBeCloseTo(0, 3);
    // Outside
    expect(sdfSphere({ x: 3, y: 0, z: 0 }, 2)).toBeGreaterThan(0);
  });

  test('sdfBox returns negative inside, positive outside', () => {
    const size = { x: 1, y: 1, z: 1 };
    // Center
    expect(sdfBox({ x: 0, y: 0, z: 0 }, size)).toBeLessThan(0);
    // On face
    expect(sdfBox({ x: 1, y: 0, z: 0 }, size)).toBeCloseTo(0, 3);
    // Outside
    expect(sdfBox({ x: 2, y: 0, z: 0 }, size)).toBeGreaterThan(0);
    // Corner (outside)
    expect(sdfBox({ x: 2, y: 2, z: 2 }, size)).toBeGreaterThan(0);
  });

  test('sdfCylinder returns correct distances', () => {
    // Cylinder with radius 2, half-height 3
    // Center
    expect(sdfCylinder({ x: 0, y: 0, z: 0 }, 2, 3)).toBeLessThan(0);
    // On side wall
    expect(sdfCylinder({ x: 2, y: 0, z: 0 }, 2, 3)).toBeCloseTo(0, 3);
    // On top cap
    expect(sdfCylinder({ x: 0, y: 3, z: 0 }, 2, 3)).toBeCloseTo(0, 3);
    // Outside
    expect(sdfCylinder({ x: 3, y: 0, z: 0 }, 2, 3)).toBeGreaterThan(0);
  });

  test('hollowSdf creates shell', () => {
    const innerDist = -1.5;  // Inside a solid
    const hollowed = hollowSdf(innerDist, 0.5);  // Thickness 0.5
    // Should be |−1.5| − 0.5 = 1.0 (outside the shell)
    expect(hollowed).toBeCloseTo(1.0);
    
    // Near surface
    const nearSurface = hollowSdf(-0.5, 0.5);
    expect(nearSurface).toBeCloseTo(0, 3);
  });

  test('sdfFromConfig with sphere', () => {
    const config: BuildConfig = {
      shape: BuildShape.SPHERE,
      mode: BuildMode.ADD,
      size: { x: 2, y: 2, z: 2 },  // radius = 2
      material: 1,
    };
    // Center should be inside (negative)
    expect(sdfFromConfig({ x: 0, y: 0, z: 0 }, config)).toBeLessThan(0);
    // Outside should be positive
    expect(sdfFromConfig({ x: 3, y: 0, z: 0 }, config)).toBeGreaterThan(0);
  });

  test('sdfToWeight converts correctly', () => {
    // Inside (negative SDF) -> positive weight
    const inside = sdfToWeight(-0.5);
    expect(inside).toBeGreaterThan(0);
    expect(inside).toBeCloseTo(0.5, 3);
    
    // Outside (positive SDF) -> negative weight
    const outside = sdfToWeight(0.5);
    expect(outside).toBeLessThan(0);
    expect(outside).toBeCloseTo(-0.5, 3);
    
    // Surface (zero SDF) -> zero weight
    const surface = sdfToWeight(0);
    expect(surface).toBeCloseTo(0, 3);
  });
});

describe('drawing.ts Tests', () => {
  test('applyAdd increases weight', () => {
    const existing = packVoxel(-0.5, 0, 16);  // Empty voxel
    const { packed, changed } = applyAdd(existing, 0.5, 5);
    expect(changed).toBe(true);
    const result = unpackVoxel(packed);
    expect(result.weight).toBeGreaterThan(-0.5);
    expect(result.material).toBe(5);
  });

  test('applySubtract decreases weight', () => {
    const existing = packVoxel(0.5, 5, 16);  // Solid voxel
    const { packed, changed } = applySubtract(existing, -0.5, 0);
    expect(changed).toBe(true);
    const result = unpackVoxel(packed);
    expect(result.weight).toBeCloseTo(-0.5, 1);
    expect(result.material).toBe(5);  // Material preserved
  });

  test('applyPaint only paints solid voxels', () => {
    // Solid voxel
    const solid = packVoxel(0.5, 5, 16);
    const { packed: p1, changed: c1 } = applyPaint(solid, 0.3, 10);
    expect(c1).toBe(true);
    expect(unpackVoxel(p1).material).toBe(10);
    
    // Empty voxel
    const empty = packVoxel(-0.5, 5, 16);
    const { changed: c2 } = applyPaint(empty, 0.3, 10);
    expect(c2).toBe(false);
  });

  test('applyFill only fills empty voxels', () => {
    // Empty voxel
    const empty = packVoxel(-0.5, 0, 16);
    const { packed: p1, changed: c1 } = applyFill(empty, 0.5, 7);
    expect(c1).toBe(true);
    const r1 = unpackVoxel(p1);
    expect(r1.weight).toBeCloseTo(0.5, 1);
    expect(r1.material).toBe(7);
    
    // Solid voxel
    const solid = packVoxel(0.5, 5, 16);
    const { changed: c2 } = applyFill(solid, 0.3, 7);
    expect(c2).toBe(false);
  });

  test('calculateBuildBBox returns sensible bounds', () => {
    const operation = createBuildOperation(4, 4, 4, {
      shape: BuildShape.CUBE,
      mode: BuildMode.ADD,
      size: { x: 2, y: 2, z: 2 },
      material: 1,
    });
    const bbox = calculateBuildBBox(operation);
    
    // Center at (4,4,4) with size 2 + margin -> should cover voxels around that
    expect(bbox.minX).toBeLessThan(16);  // 4 / 0.25 = 16 voxels
    expect(bbox.maxX).toBeGreaterThan(16);
    expect(bbox.minY).toBeLessThan(16);
    expect(bbox.maxY).toBeGreaterThan(16);
  });

  test('getAffectedChunks returns at least one chunk', () => {
    const operation = createBuildOperation(4, 4, 4, {
      shape: BuildShape.SPHERE,
      mode: BuildMode.ADD,
      size: { x: 1, y: 1, z: 1 },
      material: 1,
    });
    const chunks = getAffectedChunks(operation);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
  });

  test('drawToChunk modifies chunk data with ADD', () => {
    // Create empty chunk at origin
    const chunk = new ChunkData(0, 0, 0);
    chunk.fill(-0.5, 0, 16);  // All empty
    
    // Build a small sphere at the center of the chunk
    const centerWorld = {
      x: CHUNK_WORLD_SIZE / 2,
      y: CHUNK_WORLD_SIZE / 2,
      z: CHUNK_WORLD_SIZE / 2,
    };
    
    const operation = createBuildOperation(
      centerWorld.x, centerWorld.y, centerWorld.z,
      {
        shape: BuildShape.SPHERE,
        mode: BuildMode.ADD,
        size: { x: 1, y: 1, z: 1 },  // radius = 1 voxel unit
        material: 5,
      }
    );
    
    const changed = drawToChunk(chunk, operation);
    expect(changed).toBe(true);
    
    // Check that the center voxel is now solid
    const centerVoxel = CHUNK_SIZE / 2;
    const centerWeight = chunk.getWeightAt(centerVoxel, centerVoxel, centerVoxel);
    expect(centerWeight).toBeGreaterThan(0);
  });

  test('drawToChunk can write to custom target array', () => {
    const chunk = new ChunkData(0, 0, 0);
    chunk.fill(-0.5, 0, 16);  // All empty
    
    // Create a separate target array (simulating client-side preview)
    const targetData = new Uint16Array(VOXELS_PER_CHUNK);
    targetData.set(chunk.data);
    
    const centerWorld = {
      x: CHUNK_WORLD_SIZE / 2,
      y: CHUNK_WORLD_SIZE / 2,
      z: CHUNK_WORLD_SIZE / 2,
    };
    
    const operation = createBuildOperation(
      centerWorld.x, centerWorld.y, centerWorld.z,
      {
        shape: BuildShape.CUBE,
        mode: BuildMode.ADD,
        size: { x: 1, y: 1, z: 1 },
        material: 3,
      }
    );
    
    // Draw to custom target array
    const changed = drawToChunk(chunk, operation, targetData);
    expect(changed).toBe(true);
    
    // Main data should still be empty
    const centerVoxel = CHUNK_SIZE / 2;
    const mainWeight = chunk.getWeightAt(centerVoxel, centerVoxel, centerVoxel);
    expect(mainWeight).toBeCloseTo(-0.5, 1);
    
    // Target data should have the build
    const targetIdx = voxelIndex(centerVoxel, centerVoxel, centerVoxel);
    const targetVoxel = unpackVoxel(targetData[targetIdx]);
    expect(targetVoxel.weight).toBeGreaterThan(0);
  });
});
