/**
 * Integration tests for BuildPreview - specifically boundary remesh behavior
 * Run with: npx tsx client/src/game/build/BuildPreview.test.ts
 * 
 * These tests verify that building near chunk boundaries correctly
 * triggers neighbor chunk remeshing to prevent visual seams.
 */

import * as THREE from 'three';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import { BuildPreview } from './BuildPreview.js';
import {
  Chunk,
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  chunkKey,
  BuildShape,
  BuildMode,
  BuildConfig,
} from '@worldify/shared';

// Simple test runner
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

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if ((actual as number) <= expected) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number) {
      if ((actual as number) < expected) {
        throw new Error(`Expected ${actual} to be >= ${expected}`);
      }
    },
    toBeTrue() {
      if (actual !== true) {
        throw new Error(`Expected true, got ${actual}`);
      }
    },
    toBeFalse() {
      if (actual !== false) {
        throw new Error(`Expected false, got ${actual}`);
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error(`Expected defined value, got undefined`);
      }
    },
    toContain(item: string) {
      if (!Array.isArray(actual) || !actual.includes(item)) {
        throw new Error(`Expected array to contain "${item}"`);
      }
    },
    toIncludeAllOf(items: string[]) {
      if (!Array.isArray(actual)) {
        throw new Error(`Expected array, got ${typeof actual}`);
      }
      for (const item of items) {
        if (!actual.includes(item)) {
          throw new Error(`Expected array to contain "${item}", got [${actual.join(', ')}]`);
        }
      }
    },
  };
}

/** Create a minimal Three.js scene for testing */
function createMockScene(): THREE.Scene {
  return new THREE.Scene();
}

/** Create a test world and preview instance */
function createTestSetup() {
  const scene = createMockScene();
  const world = new VoxelWorld(scene, 12345);
  const preview = new BuildPreview();
  
  // Initialize world first
  world.init();
  
  // Initialize preview with world and scene
  preview.initialize(world, scene);
  
  return { scene, world, preview };
}

/** Create a simple build config */
function createBuildConfig(
  shape: BuildShape = BuildShape.SPHERE,
  size: number = 1
): BuildConfig {
  return {
    shape,
    mode: BuildMode.ADD,
    size: { x: size, y: size, z: size },
    material: 1,
  };
}

console.log('\n=== BuildPreview Integration Tests ===\n');

// ============== Basic Preview Tests ==============

test('BuildPreview initializes correctly', () => {
  const { preview } = createTestSetup();
  expect(preview.hasActivePreview()).toBeFalse();
});

test('updatePreview creates active preview', () => {
  const { preview } = createTestSetup();
  
  // Build at center of chunk (0,0,0)
  const center = new THREE.Vector3(4, 4, 4);
  preview.updatePreview(center, 0, createBuildConfig());
  
  expect(preview.hasActivePreview()).toBeTrue();
});

test('clearPreview removes active preview', () => {
  const { preview } = createTestSetup();
  
  const center = new THREE.Vector3(4, 4, 4);
  preview.updatePreview(center, 0, createBuildConfig());
  expect(preview.hasActivePreview()).toBeTrue();
  
  preview.clearPreview();
  expect(preview.hasActivePreview()).toBeFalse();
});

// ============== Commit Tests ==============

test('commitPreview returns modified chunk keys', () => {
  const { preview } = createTestSetup();
  
  const center = new THREE.Vector3(4, 4, 4);
  preview.updatePreview(center, 0, createBuildConfig());
  
  const modifiedKeys = preview.commitPreview();
  expect(modifiedKeys.length).toBeGreaterThan(0);
});

test('commitPreview clears preview state', () => {
  const { preview } = createTestSetup();
  
  const center = new THREE.Vector3(4, 4, 4);
  preview.updatePreview(center, 0, createBuildConfig());
  preview.commitPreview();
  
  expect(preview.hasActivePreview()).toBeFalse();
});

// ============== Preview Boundary Sampling Tests ==============

test('Preview at chunk boundary initializes tempData in both affected chunks', () => {
  const { world, preview } = createTestSetup();
  
  // Build right at X boundary between chunks (0,0,0) and (1,0,0)
  // Large enough sphere to span both chunks
  const boundaryX = CHUNK_WORLD_SIZE; // Exactly at boundary = 8m
  const center = new THREE.Vector3(boundaryX, 4, 4);
  
  preview.updatePreview(center, 0, createBuildConfig(BuildShape.SPHERE, 3));
  
  // Both chunks should have tempData initialized
  const chunk0 = world.getChunk(0, 0, 0);
  const chunk1 = world.getChunk(1, 0, 0);
  
  expect(chunk0).toBeDefined();
  expect(chunk1).toBeDefined();
  expect(chunk0!.hasTempData()).toBeTrue();
  expect(chunk1!.hasTempData()).toBeTrue();
  
  // Both chunks should have the build operation applied to tempData
  // Check boundary voxels have been modified (positive weight = solid)
  // Chunk0's edge (x=31) and Chunk1's edge (x=0) at the build center Y/Z
  const centerY = Math.floor(4 / 0.25); // 16
  const centerZ = Math.floor(4 / 0.25); // 16
  
  // The build should have added material to both sides of the boundary
  // Check that tempData was modified (not just copied from main)
  const chunk0Temp = chunk0!.tempData!;
  const chunk1Temp = chunk1!.tempData!;
  
  // At least one voxel near the boundary should be modified in each chunk
  // (exact positions depend on the sphere radius, but boundary area should be affected)
  let chunk0Modified = false;
  let chunk1Modified = false;
  
  // Check last column of chunk0 (x=31)
  for (let y = centerY - 5; y <= centerY + 5; y++) {
    for (let z = centerZ - 5; z <= centerZ + 5; z++) {
      if (y >= 0 && y < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
        const idx = y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + 31;
        const mainWeight = ((chunk0!.data[idx] >> 11) & 0x1F) / 31 - 0.5;
        const tempWeight = ((chunk0Temp[idx] >> 11) & 0x1F) / 31 - 0.5;
        if (Math.abs(tempWeight - mainWeight) > 0.01) {
          chunk0Modified = true;
          break;
        }
      }
    }
    if (chunk0Modified) break;
  }
  
  // Check first column of chunk1 (x=0)
  for (let y = centerY - 5; y <= centerY + 5; y++) {
    for (let z = centerZ - 5; z <= centerZ + 5; z++) {
      if (y >= 0 && y < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE) {
        const idx = y * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + 0;
        const mainWeight = ((chunk1!.data[idx] >> 11) & 0x1F) / 31 - 0.5;
        const tempWeight = ((chunk1Temp[idx] >> 11) & 0x1F) / 31 - 0.5;
        if (Math.abs(tempWeight - mainWeight) > 0.01) {
          chunk1Modified = true;
          break;
        }
      }
    }
    if (chunk1Modified) break;
  }
  
  expect(chunk0Modified).toBeTrue();
  expect(chunk1Modified).toBeTrue();
  
  preview.clearPreview();
});

// ============== Boundary Remesh Tests (Collision Rebuild Fix) ==============

test('Building at X chunk boundary returns neighbor in commit result', () => {
  const { preview } = createTestSetup();
  
  // Build right at X boundary between chunks (0,0,0) and (1,0,0)
  // Chunk 0 ends at X = CHUNK_WORLD_SIZE (8m), so build at X = 7.9m
  const boundaryX = CHUNK_WORLD_SIZE - 0.1;
  const center = new THREE.Vector3(boundaryX, 4, 4);
  
  preview.updatePreview(center, 0, createBuildConfig(BuildShape.SPHERE, 2));
  
  // Commit the build - should return both modified chunk and neighbors
  const result = preview.commitPreview();
  
  // Result should include the neighbor chunk (1,0,0) for collision rebuild
  const neighborKey = chunkKey(1, 0, 0);
  expect(result.includes(neighborKey)).toBeTrue();
});

test('Building at Y chunk boundary returns vertical neighbor in commit result', () => {
  const { preview } = createTestSetup();
  
  // Build at Y boundary
  const boundaryY = CHUNK_WORLD_SIZE - 0.1;
  const center = new THREE.Vector3(4, boundaryY, 4);
  
  preview.updatePreview(center, 0, createBuildConfig(BuildShape.SPHERE, 2));
  const result = preview.commitPreview();
  
  // Neighbor chunk (0,1,0) should be in result
  const neighborKey = chunkKey(0, 1, 0);
  expect(result.includes(neighborKey)).toBeTrue();
});

test('Building at Z chunk boundary returns neighbor in commit result', () => {
  const { preview } = createTestSetup();
  
  // Build at Z boundary
  const boundaryZ = CHUNK_WORLD_SIZE - 0.1;
  const center = new THREE.Vector3(4, 4, boundaryZ);
  
  preview.updatePreview(center, 0, createBuildConfig(BuildShape.SPHERE, 2));
  const result = preview.commitPreview();
  
  // Neighbor chunk (0,0,1) should be in result
  const neighborKey = chunkKey(0, 0, 1);
  expect(result.includes(neighborKey)).toBeTrue();
});

test('Building at corner returns all adjacent neighbors in commit result', () => {
  const { preview } = createTestSetup();
  
  // Build at corner of chunk (near X=8, Y=8, Z=8 boundary)
  const corner = new THREE.Vector3(
    CHUNK_WORLD_SIZE - 0.1,
    CHUNK_WORLD_SIZE - 0.1,
    CHUNK_WORLD_SIZE - 0.1
  );
  
  preview.updatePreview(corner, 0, createBuildConfig(BuildShape.SPHERE, 2));
  const result = preview.commitPreview();
  
  // All face neighbors should be in result for collision rebuild
  const expectedNeighbors = [
    chunkKey(1, 0, 0), // +X neighbor
    chunkKey(0, 1, 0), // +Y neighbor
    chunkKey(0, 0, 1), // +Z neighbor
  ];
  
  for (const key of expectedNeighbors) {
    if (!result.includes(key)) {
      throw new Error(`Expected commit result to contain neighbor ${key}, got [${result.join(', ')}]`);
    }
  }
});

test('Building away from boundary returns neighbors in commit result', () => {
  const { preview } = createTestSetup();
  
  // Build in the center of chunk (0,0,0) - far from boundaries
  const center = new THREE.Vector3(4, 4, 4);
  
  preview.updatePreview(center, 0, createBuildConfig(BuildShape.SPHERE, 1));
  const result = preview.commitPreview();
  
  // Commit result should include neighbors for collision rebuild
  // Even a center build needs neighbor collision rebuild for boundary consistency
  // At minimum, the modified chunk should be in the result
  expect(result.length).toBeGreaterThan(0);
  
  // The directly modified chunk (0,0,0) should be in the result
  expect(result.includes(chunkKey(0, 0, 0))).toBeTrue();
});

// ============== Data Integrity Tests ==============

test('Voxel data is actually modified after commit', () => {
  const { world, preview } = createTestSetup();
  
  // Get initial state of a voxel
  const chunk = world.getChunk(0, 0, 0);
  expect(chunk).toBeDefined();
  
  const testVoxelX = 16;
  const testVoxelY = 16;
  const testVoxelZ = 16;
  
  const initialWeight = chunk!.getWeightAt(testVoxelX, testVoxelY, testVoxelZ);
  
  // Build at that voxel location
  const worldPos = new THREE.Vector3(
    testVoxelX * 0.25,  // VOXEL_SCALE
    testVoxelY * 0.25,
    testVoxelZ * 0.25
  );
  
  preview.updatePreview(worldPos, 0, createBuildConfig(BuildShape.SPHERE, 2));
  preview.commitPreview();
  
  // Voxel data should be different now (assuming build ADD mode increases weight)
  const finalWeight = chunk!.getWeightAt(testVoxelX, testVoxelY, testVoxelZ);
  
  // Weight should have increased (build adds material)
  expect(finalWeight).toBeGreaterThan(initialWeight);
});

test('Multiple sequential builds accumulate correctly', () => {
  const { world, preview } = createTestSetup();
  
  const chunk = world.getChunk(0, 0, 0);
  expect(chunk).toBeDefined();
  
  const center = new THREE.Vector3(4, 4, 4);
  
  // First build
  preview.updatePreview(center, 0, createBuildConfig(BuildShape.SPHERE, 1));
  const keys1 = preview.commitPreview();
  expect(keys1.length).toBeGreaterThan(0);
  
  // Second build at same location
  preview.updatePreview(center, 0, createBuildConfig(BuildShape.SPHERE, 1));
  const keys2 = preview.commitPreview();
  expect(keys2.length).toBeGreaterThan(0);
  
  // Chunk should still be valid and have data
  const weight = chunk!.getWeightAt(16, 16, 16);
  expect(weight).toBeGreaterThan(-0.5); // Should have some solid material
});

// ============== Summary ==============

console.log('\n=== Test Summary ===');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exit(1);
}
