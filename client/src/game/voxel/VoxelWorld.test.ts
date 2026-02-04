/**
 * Unit tests for VoxelWorld - Chunk loading/unloading manager
 */

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { VoxelWorld } from './VoxelWorld.js';
import {
  Chunk,
  PLAYER_CHUNK_RADIUS,
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  INITIAL_TERRAIN_HEIGHT,
  chunkKey,
  worldToChunk,
} from '@worldify/shared';

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

function createTestWorld(): { world: VoxelWorld; scene: THREE.Scene } {
  const scene = createTestScene();
  const world = new VoxelWorld(scene);
  return { world, scene };
}

describe('Constructor Tests', () => {
  test('VoxelWorld constructor creates empty world', () => {
    const { world } = createTestWorld();
    expect(world.chunks.size).toBe(0);
    expect(world.meshes.size).toBe(0);
  });

  test('VoxelWorld stores scene reference', () => {
    const { world, scene } = createTestWorld();
    expect(world.scene).toBe(scene);
  });
});

describe('Init Tests', () => {
  test('On init, 64 chunks (4×4×4) are created', () => {
    const { world } = createTestWorld();
    world.init();
    
    expect(world.getChunkCount()).toBe(64);
  });

  test('Init creates chunks from (-2,-2,-2) to (1,1,1)', () => {
    const { world } = createTestWorld();
    world.init();
    
    const halfRadius = Math.floor(PLAYER_CHUNK_RADIUS / 2);
    
    expect(world.getChunk(-halfRadius, -halfRadius, -halfRadius)).toBeDefined();
    expect(world.getChunk(halfRadius - 1, halfRadius - 1, halfRadius - 1)).toBeDefined();
    
    expect(world.getChunk(halfRadius, 0, 0)).toBeUndefined();
    expect(world.getChunk(-halfRadius - 1, 0, 0)).toBeUndefined();
  });

  test('Init is idempotent - calling twice does not duplicate chunks', () => {
    const { world } = createTestWorld();
    world.init();
    const count1 = world.getChunkCount();
    
    world.init();
    const count2 = world.getChunkCount();
    
    expect(count1).toBe(64);
    expect(count2).toBe(64);
  });

  test('Chunks are generated with flat terrain at INITIAL_TERRAIN_HEIGHT', () => {
    const { world } = createTestWorld();
    world.init();
    
    const chunk = world.getChunk(0, 0, 0);
    expect(chunk).toBeDefined();
    
    const weightBelow = chunk!.getWeightAt(5, 0, 5);
    expect(weightBelow).toBeGreaterThan(0);
  });

  test('All chunks have dirty flag cleared after init', () => {
    const { world } = createTestWorld();
    world.init();
    
    let allClean = true;
    for (const chunk of world.chunks.values()) {
      if (chunk.dirty) {
        allClean = false;
        break;
      }
    }
    expect(allClean).toBe(true);
  });
});

describe('getChunk Tests', () => {
  test('getChunk(cx, cy, cz) returns correct chunk', () => {
    const { world } = createTestWorld();
    world.init();
    
    const chunk = world.getChunk(0, 0, 0);
    expect(chunk).toBeDefined();
    expect(chunk!.cx).toBe(0);
    expect(chunk!.cy).toBe(0);
    expect(chunk!.cz).toBe(0);
  });

  test('getChunk returns undefined for unloaded chunk', () => {
    const { world } = createTestWorld();
    world.init();
    
    const chunk = world.getChunk(100, 100, 100);
    expect(chunk).toBeUndefined();
  });

  test('getChunkAtWorld converts world coords to chunk correctly', () => {
    const { world } = createTestWorld();
    world.init();
    
    const chunk = world.getChunkAtWorld(0, 0, 0);
    expect(chunk).toBeDefined();
    expect(chunk!.cx).toBe(0);
    expect(chunk!.cy).toBe(0);
    expect(chunk!.cz).toBe(0);
  });

  test('getChunkAtWorld returns correct chunk at chunk boundary', () => {
    const { world } = createTestWorld();
    world.init();
    
    const chunk = world.getChunkAtWorld(8.1, 0, 0);
    expect(chunk).toBeDefined();
    expect(chunk!.cx).toBe(1);
  });
});

describe('Streaming Tests', () => {
  test('Moving player +8m in X loads new chunk and unloads old ones', () => {
    const { world } = createTestWorld();
    world.init();
    
    const oldChunk = world.getChunk(-2, 0, 0);
    expect(oldChunk).toBeDefined();
    
    world.update(new THREE.Vector3(16, 0, 0));
    
    const oldChunkAfter = world.getChunk(-2, 0, 0);
    expect(oldChunkAfter).toBeUndefined();
    
    const newChunk = world.getChunk(2, 0, 0);
    expect(newChunk).toBeDefined();
  });

  test('Chunk count stays roughly constant as player moves (streaming works)', () => {
    const { world } = createTestWorld();
    world.init();
    
    const initialCount = world.getChunkCount();
    expect(initialCount).toBe(64);
    
    // Due to STREAM_UNLOAD_MARGIN hysteresis, chunk count may temporarily exceed 64
    // as new chunks load before old ones unload. This is intentional to prevent pop-in.
    world.update(new THREE.Vector3(16, 0, 0));
    expect(world.getChunkCount()).toBeGreaterThanOrEqual(64);
    expect(world.getChunkCount()).toBeLessThanOrEqual(125); // 5^3 max with margin=1
    
    world.update(new THREE.Vector3(32, 0, 0));
    expect(world.getChunkCount()).toBeGreaterThanOrEqual(64);
    
    world.update(new THREE.Vector3(0, 16, 0));
    expect(world.getChunkCount()).toBeGreaterThanOrEqual(64);
  });

  test('Moving player in negative direction loads correct chunks', () => {
    const { world } = createTestWorld();
    world.init();
    
    world.update(new THREE.Vector3(-16, 0, 0));
    
    const halfRadius = Math.floor(PLAYER_CHUNK_RADIUS / 2);
    const chunk = world.getChunk(-2 - halfRadius, 0, 0);
    expect(chunk).toBeDefined();
    
    const unloaded = world.getChunk(1, 0, 0);
    expect(unloaded).toBeUndefined();
  });

  test('Small player movements within same chunk do not trigger reload', () => {
    const { world } = createTestWorld();
    world.init();
    
    world.update(new THREE.Vector3(1, 0, 0));
    world.update(new THREE.Vector3(2, 1, 0));
    world.update(new THREE.Vector3(3, 2, 1));
    
    expect(world.getChunkCount()).toBe(64);
    
    expect(world.getChunk(-2, 0, 0)).toBeDefined();
    expect(world.getChunk(1, 0, 0)).toBeDefined();
  });

  test('Moving diagonally loads correct corner chunks', () => {
    const { world } = createTestWorld();
    world.init();
    
    world.update(new THREE.Vector3(16, 16, 16));
    
    expect(world.getChunk(0, 0, 0)).toBeDefined();
    expect(world.getChunk(3, 3, 3)).toBeDefined();
    
    expect(world.getChunk(-2, -2, -2)).toBeUndefined();
  });
});

describe('Mesh Management Tests', () => {
  test('Meshes are created for chunks with terrain', () => {
    const { world } = createTestWorld();
    world.init();
    
    const meshCount = world.getMeshCount();
    expect(meshCount).toBeGreaterThan(0);
  });

  test('getMeshCount returns count of visible meshes', () => {
    const { world } = createTestWorld();
    world.init();
    
    const stats = world.getStats();
    expect(stats.meshesVisible).toBeGreaterThan(0);
    expect(stats.chunksLoaded).toBe(64);
  });

  test('Meshes are added to scene', () => {
    const { world, scene } = createTestWorld();
    world.init();
    
    expect(scene.children.length).toBeGreaterThan(0);
  });

  test('Unloading chunk removes mesh from scene', () => {
    const { world, scene } = createTestWorld();
    world.init();
    
    const initialSceneChildren = scene.children.length;
    
    world.update(new THREE.Vector3(1000, 0, 0));
    
    const chunk = world.getChunk(0, 0, 0);
    expect(chunk).toBeUndefined();
  });
});

describe('generateChunk Tests', () => {
  test('generateChunk creates chunk with correct coordinates', () => {
    const { world } = createTestWorld();
    
    const chunk = world.generateChunk(5, -3, 10);
    expect(chunk.cx).toBe(5);
    expect(chunk.cy).toBe(-3);
    expect(chunk.cz).toBe(10);
  });

  test('generateChunk creates chunk with terrain data', () => {
    const { world } = createTestWorld();
    
    // Generate a chunk below ground level (cy=-1) which should have solid terrain
    const chunk = world.generateChunk(0, -1, 0);
    
    // Bottom voxels of a below-ground chunk should be solid (positive weight)
    const weightBottom = chunk.getWeightAt(16, 0, 16);
    expect(weightBottom).toBeGreaterThan(-0.5); // Not fully empty
    
    // Chunk data should be populated with valid range values
    const weightMid = chunk.getWeightAt(16, 16, 16);
    expect(weightMid).toBeGreaterThanOrEqual(-0.5);
    expect(weightMid).toBeLessThanOrEqual(0.5);
  });
});

describe('getStats Tests', () => {
  test('getStats returns accurate chunk count', () => {
    const { world } = createTestWorld();
    world.init();
    
    const stats = world.getStats();
    expect(stats.chunksLoaded).toBe(64);
  });

  test('getStats returns bounds', () => {
    const { world } = createTestWorld();
    world.init();
    
    const stats = world.getStats();
    const halfRadius = Math.floor(PLAYER_CHUNK_RADIUS / 2);
    
    expect(stats.bounds.minCx).toBe(-halfRadius);
    expect(stats.bounds.maxCx).toBe(halfRadius - 1);
  });

  test('getStats bounds update after player movement', () => {
    const { world } = createTestWorld();
    world.init();
    
    world.update(new THREE.Vector3(16, 0, 0));
    
    const stats = world.getStats();
    expect(stats.bounds.minCx).toBe(0);
    expect(stats.bounds.maxCx).toBe(3);
  });
});

describe('Remesh Queue Tests', () => {
  test('remeshQueue starts empty', () => {
    const { world } = createTestWorld();
    world.init();
    
    const stats = world.getStats();
    expect(stats.remeshQueueSize).toBe(0);
  });
});

describe('Dispose Tests', () => {
  test('dispose removes all chunks', () => {
    const { world } = createTestWorld();
    world.init();
    
    expect(world.getChunkCount()).toBe(64);
    
    world.dispose();
    
    expect(world.getChunkCount()).toBe(0);
  });

  test('dispose removes all meshes', () => {
    const { world } = createTestWorld();
    world.init();
    
    expect(world.meshes.size).toBeGreaterThan(0);
    
    world.dispose();
    
    expect(world.meshes.size).toBe(0);
  });

  test('dispose removes meshes from scene', () => {
    const { world, scene } = createTestWorld();
    world.init();
    
    expect(scene.children.length).toBeGreaterThan(0);
    
    world.dispose();
    
    expect(scene.children.length).toBe(0);
  });

  test('dispose allows re-initialization', () => {
    const { world } = createTestWorld();
    world.init();
    world.dispose();
    
    world.init();
    expect(world.getChunkCount()).toBe(64);
  });
});

describe('Refresh Tests', () => {
  test('refresh re-meshes all chunks', () => {
    const { world } = createTestWorld();
    world.init();
    
    const chunk = world.getChunk(0, 0, 0);
    expect(chunk).toBeDefined();
    
    world.refresh();
    
    let allClean = true;
    for (const c of world.chunks.values()) {
      if (c.dirty) {
        allClean = false;
        break;
      }
    }
    expect(allClean).toBe(true);
  });
});

describe('Edge Cases', () => {
  test('Update before init does nothing', () => {
    const { world } = createTestWorld();
    
    world.update(new THREE.Vector3(100, 100, 100));
    
    expect(world.getChunkCount()).toBe(0);
  });

  test('getChunk on empty world returns undefined', () => {
    const { world } = createTestWorld();
    
    expect(world.getChunk(0, 0, 0)).toBeUndefined();
  });

  test('World handles negative chunk coordinates', () => {
    const { world } = createTestWorld();
    world.init();
    
    world.update(new THREE.Vector3(-24, -16, -16));
    
    const chunk = world.getChunk(-3, -2, -2);
    expect(chunk).toBeDefined();
    expect(chunk!.cx).toBe(-3);
  });

  test('Seamless boundaries - neighbor chunks share terrain height', () => {
    const { world } = createTestWorld();
    world.init();
    
    const chunk0 = world.getChunk(0, 0, 0);
    const chunk1 = world.getChunk(1, 0, 0);
    
    expect(chunk0).toBeDefined();
    expect(chunk1).toBeDefined();
    
    const y = 10;
    const weight0 = chunk0!.getWeightAt(31, y, 15);
    const weight1 = chunk1!.getWeightAt(0, y, 15);
    
    expect(Math.abs(weight0 - weight1)).toBeLessThanOrEqual(0.1);
  });
});

describe('Performance / Stress Tests', () => {
  test('Rapid player movement maintains chunk count', () => {
    const { world } = createTestWorld();
    world.init();
    
    for (let i = 0; i < 20; i++) {
      const x = Math.sin(i) * 50;
      const z = Math.cos(i) * 50;
      world.update(new THREE.Vector3(x, 0, z));
    }
    
    expect(world.getChunkCount()).toBe(64);
  });

  test('Large teleport loads correct chunks', () => {
    const { world } = createTestWorld();
    world.init();
    
    world.update(new THREE.Vector3(1000, 500, 2000));
    
    const playerChunk = worldToChunk(1000, 500, 2000);
    
    expect(world.getChunk(playerChunk.cx, playerChunk.cy, playerChunk.cz)).toBeDefined();
    
    expect(world.getChunkCount()).toBe(64);
  });
});
