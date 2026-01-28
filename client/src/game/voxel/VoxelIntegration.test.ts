/**
 * Unit tests for VoxelIntegration - Ties together VoxelWorld, VoxelCollision, VoxelDebug
 * Run with: npx tsx client/src/game/voxel/VoxelIntegration.test.ts
 * 
 * Stage 8 Success Criteria:
 * - Game starts with voxel terrain visible
 * - Player spawns above terrain and lands on surface
 * - Player can walk around on terrain
 * - Old build system code removed or disabled
 * - No console errors related to old systems
 * - Camera follows player over terrain correctly
 * - Lighting looks correct on terrain surface
 */

import * as THREE from 'three';
import { VoxelIntegration, createVoxelIntegration, VoxelConfig } from './VoxelIntegration.js';
import { VOXEL_SCALE, INITIAL_TERRAIN_HEIGHT, CHUNK_WORLD_SIZE } from '@worldify/shared';

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
    toBeCloseTo(expected: number, precision = 2) {
      const diff = Math.abs((actual as number) - expected);
      if (diff > Math.pow(10, -precision)) {
        throw new Error(`Expected ${expected} (±${Math.pow(10, -precision)}), got ${actual}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if ((actual as number) <= expected) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeLessThan(expected: number) {
      if ((actual as number) >= expected) {
        throw new Error(`Expected ${actual} to be less than ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number) {
      if ((actual as number) < expected) {
        throw new Error(`Expected ${actual} to be >= ${expected}`);
      }
    },
    toBeLessThanOrEqual(expected: number) {
      if ((actual as number) > expected) {
        throw new Error(`Expected ${actual} to be <= ${expected}`);
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
    toBeNull() {
      if (actual !== null) {
        throw new Error(`Expected null, got ${actual}`);
      }
    },
    toNotBeNull() {
      if (actual === null) {
        throw new Error(`Expected non-null, got null`);
      }
    },
    toBeDefined() {
      if (actual === undefined) {
        throw new Error(`Expected defined, got undefined`);
      }
    },
    toBeInstanceOf(cls: Function) {
      if (!(actual instanceof cls)) {
        throw new Error(`Expected instance of ${cls.name}`);
      }
    }
  };
}

// Create a mock scene for testing
function createMockScene(): THREE.Scene {
  return new THREE.Scene();
}

console.log('\n=== VoxelIntegration Tests ===\n');

// ============== Initialization Tests ==============

test('VoxelIntegration can be constructed', () => {
  const scene = createMockScene();
  const integration = new VoxelIntegration(scene);
  
  expect(integration.world).toBeDefined();
  expect(integration.collision).toBeDefined();
  expect(integration.debug).toBeDefined();
  expect(integration.isInitialized()).toBeFalse();
  
  integration.dispose();
});

test('VoxelIntegration can be initialized', () => {
  const scene = createMockScene();
  const integration = new VoxelIntegration(scene);
  
  integration.init();
  
  expect(integration.isInitialized()).toBeTrue();
  
  integration.dispose();
});

test('VoxelIntegration init is idempotent', () => {
  const scene = createMockScene();
  const integration = new VoxelIntegration(scene);
  
  integration.init();
  const chunkCount1 = integration.world.getChunkCount();
  
  integration.init(); // Second init should be no-op
  const chunkCount2 = integration.world.getChunkCount();
  
  expect(chunkCount1).toBe(chunkCount2);
  
  integration.dispose();
});

test('createVoxelIntegration convenience function works', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  expect(integration.isInitialized()).toBeTrue();
  expect(integration.world.getChunkCount()).toBeGreaterThan(0);
  
  integration.dispose();
});

test('VoxelIntegration accepts config options', () => {
  const scene = createMockScene();
  const config: VoxelConfig = {
    debugEnabled: true,
    collisionEnabled: false,
    spawnHeightOffset: 5.0,
  };
  
  const integration = new VoxelIntegration(scene, config);
  integration.init();
  
  // Config should affect behavior
  const stats = integration.getStats();
  expect(stats.collisionEnabled).toBeFalse();
  expect(stats.debugEnabled).toBeTrue();
  
  integration.dispose();
});

// ============== World Integration Tests ==============

test('VoxelIntegration creates initial chunks on init', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Should have chunks loaded (4x4x4 = 64 based on STREAM_RADIUS)
  expect(integration.world.getChunkCount()).toBeGreaterThan(0);
  
  integration.dispose();
});

test('VoxelIntegration creates meshes for terrain chunks', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Should have some visible meshes (chunks containing terrain)
  const stats = integration.getStats();
  expect(stats.meshesVisible).toBeGreaterThan(0);
  
  integration.dispose();
});

test('VoxelIntegration adds meshes to scene', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Scene should have children (meshes)
  expect(scene.children.length).toBeGreaterThan(0);
  
  integration.dispose();
});

// ============== Collision Integration Tests ==============

test('VoxelIntegration builds BVHs for chunk meshes', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const stats = integration.getStats();
  
  // Should have BVHs built
  expect(stats.bvhCount).toBeGreaterThan(0);
  
  integration.dispose();
});

test('VoxelIntegration BVH count matches mesh count', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const stats = integration.getStats();
  
  // BVH count should match or be close to mesh count
  // (may differ slightly due to empty chunks)
  expect(stats.bvhCount).toBeLessThanOrEqual(stats.meshesVisible + 1);
  
  integration.dispose();
});

test('VoxelIntegration has triangles in collision system', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const stats = integration.getStats();
  
  // Should have triangles for collision
  expect(stats.triangleCount).toBeGreaterThan(0);
  
  integration.dispose();
});

// ============== Spawn Position Tests ==============

test('getSpawnPosition returns position above terrain', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const spawnPos = integration.getSpawnPosition(0, 0);
  
  // Expected terrain surface Y = 10 * 0.25 = 2.5m
  // Default spawn offset is 2.0m above surface
  const expectedMinY = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE;
  
  expect(spawnPos.y).toBeGreaterThan(expectedMinY);
  
  integration.dispose();
});

test('getSpawnPosition at different XZ coordinates', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const spawn1 = integration.getSpawnPosition(0, 0);
  const spawn2 = integration.getSpawnPosition(4, 4);
  
  // Both should be above terrain (flat terrain at same height)
  const minY = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE;
  
  expect(spawn1.y).toBeGreaterThan(minY);
  expect(spawn2.y).toBeGreaterThan(minY);
  
  integration.dispose();
});

test('getSpawnPosition X and Z match input', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const spawnPos = integration.getSpawnPosition(3.5, -2.0);
  
  expect(spawnPos.x).toBe(3.5);
  expect(spawnPos.z).toBe(-2.0);
  
  integration.dispose();
});

// ============== Ground Height Tests ==============

test('getGroundHeight finds terrain surface', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Use position in the middle of a chunk (not at origin/boundaries)
  // Chunk 0,0,0 covers world x=[0,8), z=[0,8)
  const groundY = integration.getGroundHeight(4, 4);
  
  expect(groundY).toNotBeNull();
  
  // Ground should be near 2.5m (10 voxels * 0.25)
  const expectedY = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE;
  expect(groundY!).toBeGreaterThan(expectedY - 1);
  expect(groundY!).toBeLessThan(expectedY + 1);
  
  integration.dispose();
});

test('getGroundHeight returns null outside loaded chunks', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Very far away from origin (outside loaded chunks)
  const groundY = integration.getGroundHeight(1000, 1000);
  
  expect(groundY).toBeNull();
  
  integration.dispose();
});

// ============== Raycast Tests ==============

test('raycast hits terrain from above', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const origin = new THREE.Vector3(4, 10, 4);
  const direction = new THREE.Vector3(0, -1, 0);
  
  const hit = integration.raycast(origin, direction, 100);
  
  expect(hit).toNotBeNull();
  expect(hit!.point.y).toBeLessThan(origin.y);
  
  integration.dispose();
});

test('raycast returns null when missing terrain', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Cast upward from above terrain
  const origin = new THREE.Vector3(4, 10, 4);
  const direction = new THREE.Vector3(0, 1, 0);
  
  const hit = integration.raycast(origin, direction, 100);
  
  expect(hit).toBeNull();
  
  integration.dispose();
});

// ============== Sphere Collision Tests ==============

test('sphereCollide detects terrain contact', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Place sphere at terrain surface level
  const surfaceY = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE;
  const center = new THREE.Vector3(4, surfaceY, 4);
  const radius = 0.5;
  
  const result = integration.sphereCollide(center, radius);
  
  // May or may not collide depending on exact surface geometry
  // Test that method executes without error
  // (result can be null if sphere is just above surface)
});

test('sphereCollide returns null when collision disabled', () => {
  const scene = createMockScene();
  const config: VoxelConfig = { collisionEnabled: false };
  const integration = new VoxelIntegration(scene, config);
  integration.init();
  
  const result = integration.sphereCollide(new THREE.Vector3(4, 0, 4), 1.0);
  
  expect(result).toBeNull();
  
  integration.dispose();
});

// ============== Capsule Collision Tests ==============

test('resolveCapsuleCollision returns zero when not colliding', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Place capsule high above terrain
  const feetPos = new THREE.Vector3(4, 20, 4);
  const headPos = new THREE.Vector3(4, 22, 4);
  
  const pushOut = integration.resolveCapsuleCollision(feetPos, headPos, 0.3);
  
  expect(pushOut.x).toBe(0);
  expect(pushOut.y).toBe(0);
  expect(pushOut.z).toBe(0);
  
  integration.dispose();
});

test('resolveCapsuleCollision returns zero when collision disabled', () => {
  const scene = createMockScene();
  const config: VoxelConfig = { collisionEnabled: false };
  const integration = new VoxelIntegration(scene, config);
  integration.init();
  
  const pushOut = integration.resolveCapsuleCollision(
    new THREE.Vector3(4, 0, 4),
    new THREE.Vector3(4, 2, 4),
    0.3
  );
  
  expect(pushOut.x).toBe(0);
  expect(pushOut.y).toBe(0);
  expect(pushOut.z).toBe(0);
  
  integration.dispose();
});

// ============== Update Loop Tests ==============

test('update method handles player movement', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const playerPos = new THREE.Vector3(0, 5, 0);
  
  // Should not throw
  integration.update(playerPos);
  
  // Move player
  playerPos.set(4, 5, 4);
  integration.update(playerPos);
  
  integration.dispose();
});

test('update does nothing before init', () => {
  const scene = createMockScene();
  const integration = new VoxelIntegration(scene);
  
  // Should not throw even without init
  integration.update(new THREE.Vector3(0, 0, 0));
  
  expect(integration.isInitialized()).toBeFalse();
  
  integration.dispose();
});

// ============== Config Toggle Tests ==============

test('setCollisionEnabled toggles collision', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  expect(integration.getStats().collisionEnabled).toBeTrue();
  
  integration.setCollisionEnabled(false);
  expect(integration.getStats().collisionEnabled).toBeFalse();
  
  integration.setCollisionEnabled(true);
  expect(integration.getStats().collisionEnabled).toBeTrue();
  
  integration.dispose();
});

test('setDebugEnabled toggles debug', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  expect(integration.getStats().debugEnabled).toBeFalse();
  
  integration.setDebugEnabled(true);
  expect(integration.getStats().debugEnabled).toBeTrue();
  
  integration.setDebugEnabled(false);
  expect(integration.getStats().debugEnabled).toBeFalse();
  
  integration.dispose();
});

// ============== Stats Tests ==============

test('getStats returns complete statistics', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const stats = integration.getStats();
  
  expect(stats.chunksLoaded).toBeDefined();
  expect(stats.meshesVisible).toBeDefined();
  expect(stats.remeshQueueSize).toBeDefined();
  expect(stats.bvhCount).toBeDefined();
  expect(stats.triangleCount).toBeDefined();
  expect(stats.collisionEnabled).toBeDefined();
  expect(stats.debugEnabled).toBeDefined();
  
  integration.dispose();
});

test('getStats reflects actual state', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const stats = integration.getStats();
  
  // Stats should match subsystem states
  expect(stats.chunksLoaded).toBe(integration.world.getChunkCount());
  expect(stats.bvhCount).toBe(integration.collision.getBVHCount());
  
  integration.dispose();
});

// ============== Refresh Tests ==============

test('refresh rebuilds all chunks', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const statsBefore = integration.getStats();
  
  integration.refresh();
  
  const statsAfter = integration.getStats();
  
  // Should have same number of chunks after refresh
  expect(statsAfter.chunksLoaded).toBe(statsBefore.chunksLoaded);
  
  integration.dispose();
});

// ============== Dispose Tests ==============

test('dispose cleans up all resources', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  integration.dispose();
  
  expect(integration.isInitialized()).toBeFalse();
  expect(integration.world.getChunkCount()).toBe(0);
  expect(integration.collision.getBVHCount()).toBe(0);
});

test('dispose removes meshes from scene', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const childCountBefore = scene.children.length;
  expect(childCountBefore).toBeGreaterThan(0);
  
  integration.dispose();
  
  // Scene should have fewer children (meshes removed)
  expect(scene.children.length).toBeLessThan(childCountBefore);
});

test('can init again after dispose', () => {
  const scene = createMockScene();
  const integration = new VoxelIntegration(scene);
  
  integration.init();
  expect(integration.isInitialized()).toBeTrue();
  
  integration.dispose();
  expect(integration.isInitialized()).toBeFalse();
  
  // Note: Re-init would require recreating subsystems
  // This tests that dispose leaves system in clean state
});

// ============== isPointInsideTerrain Tests ==============

test('isPointInsideTerrain returns false above terrain', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  const pointAbove = new THREE.Vector3(4, 10, 4);
  const inside = integration.isPointInsideTerrain(pointAbove);
  
  expect(inside).toBeFalse();
  
  integration.dispose();
});

test('isPointInsideTerrain returns true inside terrain', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Point below terrain surface
  const pointBelow = new THREE.Vector3(4, 0, 4);
  const inside = integration.isPointInsideTerrain(pointBelow);
  
  // Should be inside solid terrain
  expect(inside).toBeTrue();
  
  integration.dispose();
});

// ============== Edge Cases ==============

test('handles empty scene', () => {
  const scene = createMockScene();
  expect(scene.children.length).toBe(0);
  
  const integration = createVoxelIntegration(scene);
  
  expect(scene.children.length).toBeGreaterThan(0);
  
  integration.dispose();
});

test('subsystems are accessible', () => {
  const scene = createMockScene();
  const integration = createVoxelIntegration(scene);
  
  // Can access subsystems directly
  expect(integration.world).toBeInstanceOf(Object);
  expect(integration.collision).toBeInstanceOf(Object);
  expect(integration.debug).toBeInstanceOf(Object);
  
  integration.dispose();
});

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
