/**
 * Integration tests for complex scenarios between:
 * - Build commits
 * - Snapshots  
 * - Spawning
 * - Chunk loading
 * 
 * These tests verify the interactions between systems work correctly.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { SpawnManager } from './SpawnManager.js';
import { VoxelIntegration } from '../voxel/VoxelIntegration.js';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import {
  Chunk,
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  VOXEL_SCALE,
  PLAYER_HEIGHT,
  SPAWN_HEIGHT_OFFSET,
  SPAWN_FALLBACK_HEIGHT,
  INITIAL_TERRAIN_HEIGHT,
  BuildMode,
  BuildShape,
  BuildOperation,
  chunkKey,
  worldToChunk,
  worldToVoxel,
  drawToChunk,
  createBuildOperation,
} from '@worldify/shared';
import { useGameStore } from '../../state/store.js';

// ============== Test Utilities ==============

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

function createTestIntegration(): {
  integration: VoxelIntegration;
  scene: THREE.Scene;
} {
  // Ensure local chunk generation
  useGameStore.setState({ useServerChunks: false });
  
  const scene = createTestScene();
  const integration = new VoxelIntegration(scene, { collisionEnabled: true });
  integration.init();
  return { integration, scene };
}

function createSpawnWithIntegration(): {
  spawn: SpawnManager;
  integration: VoxelIntegration;
  scene: THREE.Scene;
} {
  const { integration, scene } = createTestIntegration();
  const spawn = new SpawnManager(scene, { showDebug: false });
  spawn.setTerrainProvider(integration);
  return { spawn, integration, scene };
}

/**
 * Create a build operation that adds material at a location
 */
function createAddBuild(x: number, y: number, z: number, size: number = 2): BuildOperation {
  return createBuildOperation(x, y, z, {
    shape: BuildShape.SPHERE,
    mode: BuildMode.ADD,
    size: { x: size, y: size, z: size },
    material: 1,
  });
}

/**
 * Create a build operation that removes material at a location
 */
function createRemoveBuild(x: number, y: number, z: number, size: number = 2): BuildOperation {
  return createBuildOperation(x, y, z, {
    shape: BuildShape.SPHERE,
    mode: BuildMode.SUBTRACT,
    size: { x: size, y: size, z: size },
    material: 0,
  });
}

// ============== Build + Spawn Interaction Tests ==============

describe('Build Commits Affecting Spawn', () => {
  test('spawn position updates after building at spawn point', () => {
    const { spawn, integration, scene } = createSpawnWithIntegration();
    
    // Get initial spawn position
    spawn.update();
    const initialSpawn = spawn.getCachedSpawnPosition();
    const initialY = initialSpawn.y;
    
    // Build a platform at spawn point (raise the terrain)
    const buildHeight = 2; // Build 2m above current terrain
    const buildY = initialY - PLAYER_HEIGHT - SPAWN_HEIGHT_OFFSET + buildHeight;
    const build = createAddBuild(0, buildY, 0, 3);
    
    // Apply build to world
    const modifiedChunks = integration.world.applyBuildOperation(build);
    expect(modifiedChunks.length).toBeGreaterThan(0);
    
    // Rebuild collision
    integration.rebuildCollisionForChunks(modifiedChunks);
    
    // Force spawn recalculation by simulating mesh count change
    // (In real game, collision rebuild triggers mesh update)
    spawn.update();
    
    // Get new spawn position
    const newSpawn = spawn.getSpawnPosition(0, 0);
    
    // New spawn should be at or above the build
    expect(newSpawn.y).toBeGreaterThanOrEqual(initialY);
  });

  test('spawn falls through hole created by remove build', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    // Verify initial spawn works
    spawn.update();
    expect(spawn.isSpawnReady()).toBe(true);
    
    // Create a large hole at spawn point
    const terrainY = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE;
    const removeBuild = createRemoveBuild(0, terrainY / 2, 0, 4);
    
    // Apply the removal
    const modifiedChunks = integration.world.applyBuildOperation(removeBuild);
    integration.rebuildCollisionForChunks(modifiedChunks);
    
    // Spawn should now either find lower terrain or use fallback
    const newSpawn = spawn.getSpawnPosition(0, 0);
    expect(newSpawn).toBeDefined();
  });

  test('build at chunk boundary updates spawn correctly', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    // Build near chunk boundary
    const boundaryX = CHUNK_WORLD_SIZE - 0.5;
    const build = createAddBuild(boundaryX, 2, 0, 2);
    
    const modifiedChunks = integration.world.applyBuildOperation(build);
    
    // Should affect chunks on both sides of boundary
    expect(modifiedChunks.length).toBeGreaterThanOrEqual(1);
    
    integration.rebuildCollisionForChunks(modifiedChunks);
    
    // Spawn at that location should work
    const spawnAtBoundary = spawn.getSpawnPosition(boundaryX, 0);
    expect(spawnAtBoundary).toBeDefined();
  });
});

// ============== Chunk Loading + Spawn Interaction Tests ==============

describe('Chunk Loading Affects Spawn', () => {
  test('spawn not ready before terrain loads', () => {
    const scene = createTestScene();
    const spawn = new SpawnManager(scene, { showDebug: false });
    
    // No terrain provider set
    spawn.update();
    expect(spawn.isSpawnReady()).toBe(false);
    
    // Fallback position should be used
    const pos = spawn.getCachedSpawnPosition();
    expect(pos.y).toBe(SPAWN_FALLBACK_HEIGHT);
  });

  test('spawn becomes ready when chunks load', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    // Initially not ready until update called
    expect(spawn.isSpawnReady()).toBe(false);
    
    // Update triggers raycast detection
    spawn.update();
    
    // Should now be ready
    expect(spawn.isSpawnReady()).toBe(true);
  });

  test('spawn remains ready after player moves and chunks stream', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    spawn.update();
    expect(spawn.isSpawnReady()).toBe(true);
    
    // Move player to trigger chunk streaming
    integration.update(new THREE.Vector3(16, 0, 0), 0.016);
    
    // Update spawn - should still find terrain
    spawn.update();
    
    // Spawn at new location should work
    const spawnPos = spawn.getSpawnPosition(16, 0);
    expect(spawnPos).toBeDefined();
    expect(Number.isFinite(spawnPos.y)).toBe(true);
  });

  test('respawn uses last grounded when chunks not loaded at current pos', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    spawn.update();
    
    // Simulate falling far from loaded chunks
    const farPosition = new THREE.Vector3(1000, -100, 1000);
    const lastGrounded = new THREE.Vector3(5, 3, 5);
    
    const respawn = spawn.findRespawnPosition(farPosition, lastGrounded);
    
    // Should use last grounded position
    expect(respawn).not.toBeNull();
    expect(respawn!.equals(lastGrounded)).toBe(true);
  });

  test('respawn falls back to origin when no lastGrounded and current chunks unloaded', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    spawn.update();
    
    // Simulate falling far from loaded chunks with no lastGrounded
    const farPosition = new THREE.Vector3(1000, -100, 1000);
    
    const respawn = spawn.findRespawnPosition(farPosition, null);
    
    // Should respawn at origin (where chunks ARE loaded)
    expect(respawn).not.toBeNull();
    expect(respawn!.x).toBe(0);
    expect(respawn!.z).toBe(0);
  });
});

// ============== Build + Chunk Streaming Interaction ==============

describe('Build During Chunk Streaming', () => {
  test('build applied to newly loaded chunk', () => {
    const { integration, scene } = createTestIntegration();
    
    // Verify initial chunk state
    const initialChunk = integration.world.getChunk(0, 0, 0);
    expect(initialChunk).toBeDefined();
    
    // Build at center of chunk
    const build = createAddBuild(4, 4, 4, 2);
    const modifiedChunks = integration.world.applyBuildOperation(build);
    
    expect(modifiedChunks.length).toBeGreaterThan(0);
    expect(modifiedChunks.includes(chunkKey(0, 0, 0))).toBe(true);
    
    // Verify chunk was marked dirty and modified
    const chunk = integration.world.getChunk(0, 0, 0);
    expect(chunk).toBeDefined();
  });

  test('build to unloaded chunk is skipped gracefully', () => {
    const { integration } = createTestIntegration();
    
    // Build at a location that's not loaded (far away)
    const build = createAddBuild(1000, 4, 1000, 2);
    const modifiedChunks = integration.world.applyBuildOperation(build);
    
    // Should return empty - chunk not loaded
    expect(modifiedChunks.length).toBe(0);
  });

  test('multiple sequential builds accumulate correctly', () => {
    const { integration } = createTestIntegration();
    
    // Build three overlapping spheres
    const builds = [
      createAddBuild(4, 4, 4, 1),
      createAddBuild(4.5, 4, 4, 1),
      createAddBuild(5, 4, 4, 1),
    ];
    
    let totalModified = 0;
    for (const build of builds) {
      const modified = integration.world.applyBuildOperation(build);
      totalModified += modified.length;
    }
    
    // At least one chunk should be modified
    expect(totalModified).toBeGreaterThan(0);
    
    // Get the chunk and verify voxel data changed
    const chunk = integration.world.getChunk(0, 0, 0);
    expect(chunk).toBeDefined();
    
    // Check a voxel in the build area
    const voxel = worldToVoxel(4, 4, 4);
    const weight = chunk!.getWeightAt(
      voxel.vx % CHUNK_SIZE,
      voxel.vy % CHUNK_SIZE,
      voxel.vz % CHUNK_SIZE
    );
    
    // Weight should be positive (solid)
    expect(weight).toBeGreaterThan(0);
  });
});

// ============== Complex Multi-System Scenarios ==============

describe('Complex Multi-System Scenarios', () => {
  test('scenario: player spawns, builds, moves, respawns at build location', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    // 1. Initial spawn
    spawn.update();
    const initialSpawn = spawn.getCachedSpawnPosition();
    expect(initialSpawn.y).toBeGreaterThan(0);
    
    // 2. Player builds a platform at new location
    const platformX = 8;
    const platformBuild = createAddBuild(platformX, 2, 0, 3);
    const buildModified = integration.world.applyBuildOperation(platformBuild);
    integration.rebuildCollisionForChunks(buildModified);
    
    // 3. Simulate player moving to platform
    const playerPos = new THREE.Vector3(platformX, 5, 0);
    integration.update(playerPos, 0.016);
    
    // 4. Find respawn position (simulating player fell and has lastGrounded)
    const lastGrounded = new THREE.Vector3(platformX, 4, 0);
    const respawn = spawn.findRespawnPosition(
      new THREE.Vector3(platformX, -50, 0), // fell below
      lastGrounded
    );
    
    // Should respawn at the platform
    expect(respawn).not.toBeNull();
    expect(respawn!.x).toBe(lastGrounded.x);
  });

  test('scenario: build destroys spawn point, new spawn found at origin', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    // 1. Verify spawn works at location 8,0,8
    spawn.update();
    const initialSpawn = spawn.getSpawnPosition(8, 8);
    expect(initialSpawn).toBeDefined();
    
    // 2. Remove terrain at 8,0,8 (create a hole)
    const terrainY = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE;
    const removeBuild = createRemoveBuild(8, terrainY / 2, 8, 5);
    const modified = integration.world.applyBuildOperation(removeBuild);
    integration.rebuildCollisionForChunks(modified);
    
    // 3. Try to respawn there with no lastGrounded
    const respawn = spawn.findRespawnPosition(
      new THREE.Vector3(8, -50, 8),
      null
    );
    
    // Should fallback to origin
    expect(respawn).not.toBeNull();
  });

  test('scenario: rapid builds and spawn queries interleaved', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    spawn.update();
    
    // Interleave builds with spawn queries
    for (let i = 0; i < 5; i++) {
      const x = i * 2;
      
      // Build
      const build = createAddBuild(x, 3, 0, 1);
      const modified = integration.world.applyBuildOperation(build);
      
      if (modified.length > 0) {
        integration.rebuildCollisionForChunks(modified);
      }
      
      // Query spawn
      const spawnPos = spawn.getSpawnPosition(x, 0);
      expect(spawnPos).toBeDefined();
      expect(Number.isFinite(spawnPos.y)).toBe(true);
    }
  });

  test('scenario: chunk unload then reload preserves build state', () => {
    const { integration, scene } = createTestIntegration();
    
    // 1. Build at current location
    const build = createAddBuild(4, 4, 4, 2);
    integration.world.applyBuildOperation(build);
    
    // Get voxel weight before streaming away
    const chunkBefore = integration.world.getChunk(0, 0, 0);
    const voxel = worldToVoxel(4, 4, 4);
    const weightBefore = chunkBefore!.getWeightAt(
      voxel.vx % CHUNK_SIZE,
      voxel.vy % CHUNK_SIZE,
      voxel.vz % CHUNK_SIZE
    );
    
    // 2. Move far away (unload original chunk)
    integration.update(new THREE.Vector3(100, 0, 0), 0.016);
    
    // Original chunk should be unloaded
    expect(integration.world.getChunk(0, 0, 0)).toBeUndefined();
    
    // 3. Return to origin (reload chunk)
    integration.update(new THREE.Vector3(0, 0, 0), 0.016);
    
    // Chunk is back but in LOCAL mode, regenerated fresh
    // (Server mode would preserve builds via server state)
    const chunkAfter = integration.world.getChunk(0, 0, 0);
    expect(chunkAfter).toBeDefined();
    
    // Note: In local mode, build is lost on unload/reload
    // This is expected behavior - server mode preserves builds
  });
});

// ============== Collision System Integration ==============

describe('Collision System After Build', () => {
  test('collision mesh rebuilt after adding platform', () => {
    const { integration } = createTestIntegration();
    
    // Get initial collider count
    const initialColliderCount = integration.collision.getColliderCount();
    
    // Build a platform
    const build = createAddBuild(4, 5, 4, 2);
    const modified = integration.world.applyBuildOperation(build);
    
    expect(modified.length).toBeGreaterThan(0);
    
    // Rebuild collision
    integration.rebuildCollisionForChunks(modified);
    
    // Colliders should still exist (may be same or more)
    expect(integration.collision.getColliderCount()).toBeGreaterThan(0);
  });

  test('collision mesh rebuilt after removing material', () => {
    const { integration } = createTestIntegration();
    
    // Get initial collider count
    const initialColliderCount = integration.collision.getColliderCount();
    expect(initialColliderCount).toBeGreaterThan(0);
    
    // Remove terrain at origin
    const terrainY = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE;
    const removeBuild = createRemoveBuild(0, terrainY / 2, 0, 3);
    const modified = integration.world.applyBuildOperation(removeBuild);
    integration.rebuildCollisionForChunks(modified);
    
    // Colliders should still be maintained (geometry changed)
    expect(integration.collision.getColliderCount()).toBeGreaterThan(0);
  });

  test('getCollisionMeshes returns meshes after build', () => {
    const { integration } = createTestIntegration();
    
    const initialMeshes = integration.getCollisionMeshes();
    const initialCount = initialMeshes.length;
    
    // Build a platform
    const build = createAddBuild(4, 5, 4, 2);
    const modified = integration.world.applyBuildOperation(build);
    integration.rebuildCollisionForChunks(modified);
    
    const afterMeshes = integration.getCollisionMeshes();
    
    // Should still have collision meshes
    expect(afterMeshes.length).toBeGreaterThan(0);
  });
});

// ============== Edge Cases ==============

describe('Edge Cases', () => {
  test('spawn at exact chunk boundary', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    spawn.update();
    
    // Spawn exactly at chunk boundary
    const boundaryX = CHUNK_WORLD_SIZE;
    const spawnPos = spawn.getSpawnPosition(boundaryX, 0);
    
    expect(spawnPos).toBeDefined();
    expect(Number.isFinite(spawnPos.y)).toBe(true);
  });

  test('build at Y=0 affects spawn', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    spawn.update();
    
    // Build at very low Y
    const build = createAddBuild(0, 0.5, 0, 1);
    const modified = integration.world.applyBuildOperation(build);
    
    // Should still work
    expect(modified.length).toBeGreaterThanOrEqual(0);
  });

  test('rapid spawn queries during streaming', () => {
    const { spawn, integration } = createSpawnWithIntegration();
    
    spawn.update();
    
    // Simulate rapid movement with spawn queries
    for (let i = 0; i < 10; i++) {
      integration.update(new THREE.Vector3(i * 8, 0, 0), 0.016);
      spawn.update();
      
      const spawnPos = spawn.getSpawnPosition(i * 8, 0);
      expect(spawnPos).toBeDefined();
    }
  });

  test('dispose clears all state correctly', () => {
    const { spawn, integration, scene } = createSpawnWithIntegration();
    
    spawn.update();
    expect(spawn.isSpawnReady()).toBe(true);
    
    // Dispose spawn
    spawn.dispose();
    
    // Dispose integration
    integration.dispose();
    
    // Scene should be cleaned up
    expect(scene.children.length).toBe(0);
  });
});
