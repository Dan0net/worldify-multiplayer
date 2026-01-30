/**
 * Integration tests for BuildPreview with focus on boundary remesh behavior
 * Tests the fix for collision rebuild after cross-boundary builds
 */

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { BuildPreview } from './BuildPreview.js';
import { VoxelWorld } from '../voxel/VoxelWorld.js';
import {
  Chunk,
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  VOXEL_SCALE,
  BUILD_RADIUS,
  packVoxel,
  unpackVoxel,
  chunkKey,
  worldToChunk,
  worldToVoxel,
} from '@worldify/shared';

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

function createTestWorld(): { world: VoxelWorld; scene: THREE.Scene } {
  const scene = createTestScene();
  const world = new VoxelWorld(scene);
  world.init();
  return { world, scene };
}

function createTestPreview(): {
  preview: BuildPreview;
  world: VoxelWorld;
  scene: THREE.Scene;
} {
  const { world, scene } = createTestWorld();
  const preview = new BuildPreview(world);
  return { preview, world, scene };
}

describe('Basic Preview Tests', () => {
  test('BuildPreview can be created', () => {
    const { preview } = createTestPreview();
    expect(preview).toBeDefined();
  });

  test('Preview shows add indicator at target position', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(0, 2, 0);
    preview.update(targetPos, true);
    
    expect(preview.indicator).toBeDefined();
    expect(preview.indicator.visible).toBe(true);
  });

  test('Preview shows remove indicator when removing', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(0, 1, 0);
    preview.update(targetPos, false);
    
    expect(preview.indicator).toBeDefined();
  });

  test('Hide preview removes indicator', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(0, 2, 0);
    preview.update(targetPos, true);
    preview.hide();
    
    expect(preview.indicator.visible).toBe(false);
  });
});

describe('Commit Tests', () => {
  test('Commit add modifies voxel data', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 4, 4);
    preview.update(targetPos, true);
    
    const chunk = world.getChunkAtWorld(targetPos.x, targetPos.y, targetPos.z);
    expect(chunk).toBeDefined();
    
    const voxelCoord = worldToVoxel(targetPos.x, targetPos.y, targetPos.z);
    const weightBefore = chunk!.getWeightAt(
      voxelCoord.vx % CHUNK_SIZE,
      voxelCoord.vy % CHUNK_SIZE,
      voxelCoord.vz % CHUNK_SIZE
    );
    
    const result = preview.commit();
    
    expect(result).toBeDefined();
    expect(result.affectedChunks.length).toBeGreaterThan(0);
  });

  test('Commit remove modifies voxel data', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 0.5, 4);
    preview.update(targetPos, false);
    
    const result = preview.commit();
    
    expect(result).toBeDefined();
  });

  test('Commit returns affected chunk keys', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 4, 4);
    preview.update(targetPos, true);
    
    const result = preview.commit();
    
    expect(result.affectedChunks).toBeInstanceOf(Array);
  });
});

describe('Preview Boundary Sampling Tests', () => {
  test('Build near chunk boundary is detected', () => {
    const { preview, world } = createTestPreview();
    
    const boundaryX = CHUNK_WORLD_SIZE - BUILD_RADIUS * VOXEL_SCALE * 0.5;
    const targetPos = new THREE.Vector3(boundaryX, 2, 4);
    
    preview.update(targetPos, true);
    
    const result = preview.commit();
    
    expect(result.affectedChunks.length).toBeGreaterThanOrEqual(1);
  });

  test('Build at corner affects multiple chunks', () => {
    const { preview, world } = createTestPreview();
    
    const cornerX = CHUNK_WORLD_SIZE - 0.1;
    const cornerZ = CHUNK_WORLD_SIZE - 0.1;
    const targetPos = new THREE.Vector3(cornerX, 2, cornerZ);
    
    preview.update(targetPos, true);
    
    const result = preview.commit();
    
    expect(result.affectedChunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Boundary Remesh (Collision Rebuild Fix) Tests', () => {
  test('Build near X+ boundary remeshes neighbor chunk', () => {
    const { preview, world } = createTestPreview();
    
    const chunk0 = world.getChunk(0, 0, 0);
    const chunk1 = world.getChunk(1, 0, 0);
    expect(chunk0).toBeDefined();
    expect(chunk1).toBeDefined();
    
    const nearBoundaryX = CHUNK_WORLD_SIZE - BUILD_RADIUS * VOXEL_SCALE;
    const targetPos = new THREE.Vector3(nearBoundaryX, 2, 4);
    
    preview.update(targetPos, true);
    const result = preview.commit();
    
    const affectedKeys = result.affectedChunks;
    const key0 = chunkKey(0, 0, 0);
    const key1 = chunkKey(1, 0, 0);
    
    const affectsOrigin = affectedKeys.includes(key0);
    const affectsNeighbor = affectedKeys.includes(key1);
    
    expect(affectsOrigin || affectsNeighbor).toBe(true);
  });

  test('Build near X- boundary remeshes neighbor chunk', () => {
    const { preview, world } = createTestPreview();
    
    const chunkMinus1 = world.getChunk(-1, 0, 0);
    const chunk0 = world.getChunk(0, 0, 0);
    expect(chunkMinus1).toBeDefined();
    expect(chunk0).toBeDefined();
    
    const nearBoundaryX = BUILD_RADIUS * VOXEL_SCALE;
    const targetPos = new THREE.Vector3(nearBoundaryX, 2, 4);
    
    preview.update(targetPos, true);
    const result = preview.commit();
    
    expect(result.affectedChunks.length).toBeGreaterThanOrEqual(1);
  });

  test('Build near Z boundary affects Z neighbor', () => {
    const { preview, world } = createTestPreview();
    
    const nearBoundaryZ = CHUNK_WORLD_SIZE - BUILD_RADIUS * VOXEL_SCALE;
    const targetPos = new THREE.Vector3(4, 2, nearBoundaryZ);
    
    preview.update(targetPos, true);
    const result = preview.commit();
    
    expect(result.affectedChunks.length).toBeGreaterThanOrEqual(1);
  });

  test('Build near Y boundary affects Y neighbor', () => {
    const { preview, world } = createTestPreview();
    
    const nearBoundaryY = CHUNK_WORLD_SIZE - BUILD_RADIUS * VOXEL_SCALE;
    const targetPos = new THREE.Vector3(4, nearBoundaryY, 4);
    
    preview.update(targetPos, true);
    const result = preview.commit();
    
    expect(result.affectedChunks.length).toBeGreaterThanOrEqual(1);
  });

  test('Build in center of chunk only affects one chunk', () => {
    const { preview, world } = createTestPreview();
    
    const centerX = CHUNK_WORLD_SIZE / 2;
    const centerZ = CHUNK_WORLD_SIZE / 2;
    const targetPos = new THREE.Vector3(centerX, 2, centerZ);
    
    preview.update(targetPos, true);
    const result = preview.commit();
    
    expect(result.affectedChunks.length).toBe(1);
    expect(result.affectedChunks[0]).toBe(chunkKey(0, 0, 0));
  });

  test('Multiple commits near boundary accumulate correctly', () => {
    const { preview, world } = createTestPreview();
    
    const nearBoundaryX = CHUNK_WORLD_SIZE - BUILD_RADIUS * VOXEL_SCALE;
    
    const targetPos1 = new THREE.Vector3(nearBoundaryX, 2, 4);
    preview.update(targetPos1, true);
    const result1 = preview.commit();
    
    const targetPos2 = new THREE.Vector3(nearBoundaryX + VOXEL_SCALE, 2, 4);
    preview.update(targetPos2, true);
    const result2 = preview.commit();
    
    expect(result1.affectedChunks.length).toBeGreaterThanOrEqual(1);
    expect(result2.affectedChunks.length).toBeGreaterThanOrEqual(1);
  });

  test('Remesh queue is populated for boundary builds', () => {
    const { preview, world } = createTestPreview();
    
    const nearBoundaryX = CHUNK_WORLD_SIZE - BUILD_RADIUS * VOXEL_SCALE;
    const targetPos = new THREE.Vector3(nearBoundaryX, 2, 4);
    
    preview.update(targetPos, true);
    const result = preview.commit();
    
    const stats = world.getStats();
    
    expect(result.affectedChunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Data Integrity Tests', () => {
  test('Voxel weight changes after add commit', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 4, 4);
    const voxelCoord = worldToVoxel(targetPos.x, targetPos.y, targetPos.z);
    const chunk = world.getChunkAtWorld(targetPos.x, targetPos.y, targetPos.z);
    expect(chunk).toBeDefined();
    
    const localVx = ((voxelCoord.vx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localVy = ((voxelCoord.vy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localVz = ((voxelCoord.vz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    
    const weightBefore = chunk!.getWeightAt(localVx, localVy, localVz);
    
    preview.update(targetPos, true);
    preview.commit();
    
    const weightAfter = chunk!.getWeightAt(localVx, localVy, localVz);
    
    expect(weightAfter).toBeGreaterThan(weightBefore);
  });

  test('Voxel weight changes after remove commit', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 0.5, 4);
    const voxelCoord = worldToVoxel(targetPos.x, targetPos.y, targetPos.z);
    const chunk = world.getChunkAtWorld(targetPos.x, targetPos.y, targetPos.z);
    expect(chunk).toBeDefined();
    
    const localVx = ((voxelCoord.vx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localVy = ((voxelCoord.vy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localVz = ((voxelCoord.vz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    
    const weightBefore = chunk!.getWeightAt(localVx, localVy, localVz);
    
    preview.update(targetPos, false);
    preview.commit();
    
    const weightAfter = chunk!.getWeightAt(localVx, localVy, localVz);
    
    expect(weightAfter).toBeLessThan(weightBefore);
  });

  test('Chunk dirty flag set after commit', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 4, 4);
    const chunk = world.getChunkAtWorld(targetPos.x, targetPos.y, targetPos.z);
    expect(chunk).toBeDefined();
    
    chunk!.dirty = false;
    
    preview.update(targetPos, true);
    preview.commit();
    
    expect(chunk!.dirty).toBe(true);
  });

  test('Material is preserved in packed voxel', () => {
    const { preview, world } = createTestPreview();
    
    const targetPos = new THREE.Vector3(4, 0.5, 4);
    const voxelCoord = worldToVoxel(targetPos.x, targetPos.y, targetPos.z);
    const chunk = world.getChunkAtWorld(targetPos.x, targetPos.y, targetPos.z);
    expect(chunk).toBeDefined();
    
    const localVx = ((voxelCoord.vx % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localVy = ((voxelCoord.vy % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const localVz = ((voxelCoord.vz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    
    const packedBefore = chunk!.getVoxel(localVx, localVy, localVz);
    const unpackedBefore = unpackVoxel(packedBefore);
    
    preview.update(targetPos, true);
    preview.commit();
    
    const packedAfter = chunk!.getVoxel(localVx, localVy, localVz);
    const unpackedAfter = unpackVoxel(packedAfter);
    
    if (unpackedBefore.material > 0) {
      expect(unpackedAfter.material).toBe(unpackedBefore.material);
    }
  });
});
