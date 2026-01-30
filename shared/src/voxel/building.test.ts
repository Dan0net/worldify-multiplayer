/**
 * Unit tests for build system Phase 1: shapes, drawing, and buildTypes
 * Run with: npx tsx shared/src/voxel/building.test.ts
 */

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

// ============== Test Runner ==============

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${e}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message?: string) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${expected}, got ${actual}`);
  }
}

function assertApproxEqual(actual: number, expected: number, epsilon: number = 0.001, message?: string) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message || 'Assertion failed'}: expected ~${expected}, got ${actual}`);
  }
}

function assertTrue(condition: boolean, message?: string) {
  if (!condition) {
    throw new Error(message || 'Expected true but got false');
  }
}

function assertFalse(condition: boolean, message?: string) {
  if (condition) {
    throw new Error(message || 'Expected false but got true');
  }
}

// ============== buildTypes Tests ==============

console.log('\n=== buildTypes.ts Tests ===\n');

test('createDefaultBuildConfig returns valid config', () => {
  const config = createDefaultBuildConfig();
  assertEqual(config.shape, BuildShape.CUBE);
  assertEqual(config.mode, BuildMode.ADD);
  assertEqual(config.size.x, 2);
  assertEqual(config.size.y, 2);
  assertEqual(config.size.z, 2);
  assertEqual(config.material, 1);
});

test('identityQuat returns identity quaternion', () => {
  const q = identityQuat();
  assertEqual(q.x, 0);
  assertEqual(q.y, 0);
  assertEqual(q.z, 0);
  assertEqual(q.w, 1);
});

test('applyQuatToVec3 with identity does not change vector', () => {
  const v: Vec3 = { x: 1, y: 2, z: 3 };
  const q = identityQuat();
  const result = applyQuatToVec3(v, q);
  assertApproxEqual(result.x, 1);
  assertApproxEqual(result.y, 2);
  assertApproxEqual(result.z, 3);
});

test('applyQuatToVec3 with 90deg Y rotation rotates correctly', () => {
  const v: Vec3 = { x: 1, y: 0, z: 0 };
  // 90 degrees around Y axis: quat = (0, sin(45°), 0, cos(45°))
  const angle = Math.PI / 2;
  const q: Quat = { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
  const result = applyQuatToVec3(v, q);
  // (1,0,0) rotated 90° around Y should be (0,0,-1)
  assertApproxEqual(result.x, 0, 0.001, 'x');
  assertApproxEqual(result.y, 0, 0.001, 'y');
  assertApproxEqual(result.z, -1, 0.001, 'z');
});

test('invertQuat returns conjugate', () => {
  const q: Quat = { x: 0.1, y: 0.2, z: 0.3, w: 0.9 };
  const inv = invertQuat(q);
  assertEqual(inv.x, -0.1);
  assertEqual(inv.y, -0.2);
  assertEqual(inv.z, -0.3);
  assertEqual(inv.w, 0.9);
});

test('clamp works correctly', () => {
  assertEqual(clamp(5, 0, 10), 5);
  assertEqual(clamp(-5, 0, 10), 0);
  assertEqual(clamp(15, 0, 10), 10);
});

// ============== shapes Tests ==============

console.log('\n=== shapes.ts Tests ===\n');

test('sdfSphere returns negative inside, positive outside', () => {
  // Center of sphere (radius 2)
  assertTrue(sdfSphere({ x: 0, y: 0, z: 0 }, 2) < 0, 'center should be inside');
  // On surface
  assertApproxEqual(sdfSphere({ x: 2, y: 0, z: 0 }, 2), 0, 0.001, 'surface');
  // Outside
  assertTrue(sdfSphere({ x: 3, y: 0, z: 0 }, 2) > 0, 'outside should be positive');
});

test('sdfBox returns negative inside, positive outside', () => {
  const size = { x: 1, y: 1, z: 1 };
  // Center
  assertTrue(sdfBox({ x: 0, y: 0, z: 0 }, size) < 0, 'center');
  // On face
  assertApproxEqual(sdfBox({ x: 1, y: 0, z: 0 }, size), 0, 0.001, 'on face');
  // Outside
  assertTrue(sdfBox({ x: 2, y: 0, z: 0 }, size) > 0, 'outside');
  // Corner (outside)
  assertTrue(sdfBox({ x: 2, y: 2, z: 2 }, size) > 0, 'corner outside');
});

test('sdfCylinder returns correct distances', () => {
  // Cylinder with radius 2, half-height 3
  // Center
  assertTrue(sdfCylinder({ x: 0, y: 0, z: 0 }, 2, 3) < 0, 'center');
  // On side wall
  assertApproxEqual(sdfCylinder({ x: 2, y: 0, z: 0 }, 2, 3), 0, 0.001, 'side wall');
  // On top cap
  assertApproxEqual(sdfCylinder({ x: 0, y: 3, z: 0 }, 2, 3), 0, 0.001, 'top cap');
  // Outside
  assertTrue(sdfCylinder({ x: 3, y: 0, z: 0 }, 2, 3) > 0, 'outside radially');
});

test('hollowSdf creates shell', () => {
  const innerDist = -1.5;  // Inside a solid
  const hollowed = hollowSdf(innerDist, 0.5);  // Thickness 0.5
  // Should be |−1.5| − 0.5 = 1.0 (outside the shell)
  assertApproxEqual(hollowed, 1.0);
  
  // Near surface
  const nearSurface = hollowSdf(-0.5, 0.5);
  assertApproxEqual(nearSurface, 0, 0.001);
});

test('sdfFromConfig with sphere', () => {
  const config: BuildConfig = {
    shape: BuildShape.SPHERE,
    mode: BuildMode.ADD,
    size: { x: 2, y: 2, z: 2 },  // radius = 2
    material: 1,
  };
  // Center should be inside (negative)
  assertTrue(sdfFromConfig({ x: 0, y: 0, z: 0 }, config) < 0);
  // Outside should be positive
  assertTrue(sdfFromConfig({ x: 3, y: 0, z: 0 }, config) > 0);
});

test('sdfToWeight converts correctly', () => {
  // Inside (negative SDF) -> positive weight
  const inside = sdfToWeight(-0.5);
  assertTrue(inside > 0, 'inside should have positive weight');
  assertApproxEqual(inside, 0.5, 0.001);
  
  // Outside (positive SDF) -> negative weight
  const outside = sdfToWeight(0.5);
  assertTrue(outside < 0, 'outside should have negative weight');
  assertApproxEqual(outside, -0.5, 0.001);
  
  // Surface (zero SDF) -> zero weight
  const surface = sdfToWeight(0);
  assertApproxEqual(surface, 0, 0.001);
});

// ============== drawing Tests ==============

console.log('\n=== drawing.ts Tests ===\n');

test('applyAdd increases weight', () => {
  const existing = packVoxel(-0.5, 0, 16);  // Empty voxel
  const { packed, changed } = applyAdd(existing, 0.5, 5);
  assertTrue(changed, 'should change');
  const result = unpackVoxel(packed);
  assertTrue(result.weight > -0.5, 'weight should increase');
  assertEqual(result.material, 5);
});

test('applySubtract decreases weight', () => {
  const existing = packVoxel(0.5, 5, 16);  // Solid voxel
  const { packed, changed } = applySubtract(existing, -0.5, 0);
  assertTrue(changed, 'should change');
  const result = unpackVoxel(packed);
  assertApproxEqual(result.weight, -0.5, 0.1);
  assertEqual(result.material, 5);  // Material preserved
});

test('applyPaint only paints solid voxels', () => {
  // Solid voxel
  const solid = packVoxel(0.5, 5, 16);
  const { packed: p1, changed: c1 } = applyPaint(solid, 0.3, 10);
  assertTrue(c1, 'solid should be painted');
  assertEqual(unpackVoxel(p1).material, 10);
  
  // Empty voxel
  const empty = packVoxel(-0.5, 5, 16);
  const { changed: c2 } = applyPaint(empty, 0.3, 10);
  assertFalse(c2, 'empty should not be painted');
});

test('applyFill only fills empty voxels', () => {
  // Empty voxel
  const empty = packVoxel(-0.5, 0, 16);
  const { packed: p1, changed: c1 } = applyFill(empty, 0.5, 7);
  assertTrue(c1, 'empty should be filled');
  const r1 = unpackVoxel(p1);
  assertApproxEqual(r1.weight, 0.5, 0.1);
  assertEqual(r1.material, 7);
  
  // Solid voxel
  const solid = packVoxel(0.5, 5, 16);
  const { changed: c2 } = applyFill(solid, 0.3, 7);
  assertFalse(c2, 'solid should not be filled');
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
  assertTrue(bbox.minX < 16, 'minX');  // 4 / 0.25 = 16 voxels
  assertTrue(bbox.maxX > 16, 'maxX');
  assertTrue(bbox.minY < 16, 'minY');
  assertTrue(bbox.maxY > 16, 'maxY');
});

test('getAffectedChunks returns at least one chunk', () => {
  const operation = createBuildOperation(4, 4, 4, {
    shape: BuildShape.SPHERE,
    mode: BuildMode.ADD,
    size: { x: 1, y: 1, z: 1 },
    material: 1,
  });
  const chunks = getAffectedChunks(operation);
  assertTrue(chunks.length >= 1, 'should affect at least one chunk');
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
  assertTrue(changed, 'chunk should be modified');
  
  // Check that the center voxel is now solid
  const centerVoxel = CHUNK_SIZE / 2;
  const centerWeight = chunk.getWeightAt(centerVoxel, centerVoxel, centerVoxel);
  assertTrue(centerWeight > 0, `center voxel should be solid, got ${centerWeight}`);
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
  assertTrue(changed, 'should modify target data');
  
  // Main data should still be empty
  const centerVoxel = CHUNK_SIZE / 2;
  const mainWeight = chunk.getWeightAt(centerVoxel, centerVoxel, centerVoxel);
  assertApproxEqual(mainWeight, -0.5, 0.1, 'main data unchanged');
  
  // Target data should have the build
  const targetIdx = voxelIndex(centerVoxel, centerVoxel, centerVoxel);
  const targetVoxel = unpackVoxel(targetData[targetIdx]);
  assertTrue(targetVoxel.weight > 0, 'target voxel should be solid');
});

// ============== Summary ==============

console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
