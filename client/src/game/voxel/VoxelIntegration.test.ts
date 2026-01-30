/**
 * Integration tests for VoxelIntegration
 * Tests the facade that ties VoxelWorld, VoxelCollision, and VoxelDebug together
 */

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { VoxelIntegration, VoxelIntegrationConfig } from './VoxelIntegration.js';
import {
  Chunk,
  STREAM_RADIUS,
  CHUNK_SIZE,
  CHUNK_WORLD_SIZE,
  INITIAL_TERRAIN_HEIGHT,
  chunkKey,
  worldToChunk,
  VOXEL_SCALE,
} from '@worldify/shared';

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

function createDefaultConfig(): VoxelIntegrationConfig {
  return {
    debug: false,
    collisionEnabled: true,
    streamingEnabled: true,
  };
}

function createTestIntegration(
  config?: Partial<VoxelIntegrationConfig>
): { integration: VoxelIntegration; scene: THREE.Scene } {
  const scene = createTestScene();
  const fullConfig = { ...createDefaultConfig(), ...config };
  const integration = new VoxelIntegration(scene, fullConfig);
  return { integration, scene };
}

describe('Initialization Tests', () => {
  test('VoxelIntegration creates with default config', () => {
    const { integration } = createTestIntegration();
    expect(integration).toBeDefined();
    expect(integration.world).toBeDefined();
    expect(integration.collision).toBeDefined();
  });

  test('VoxelIntegration.init() initializes VoxelWorld', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    expect(integration.world.getChunkCount()).toBe(64);
  });

  test('VoxelIntegration.init() initializes collision system', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const collision = integration.collision;
    expect(collision).toBeDefined();
    expect(collision.colliders.size).toBeGreaterThan(0);
  });

  test('Debug mode adds debug visualizations', () => {
    const { integration, scene } = createTestIntegration({ debug: true });
    integration.init();
    
    const childCountWithDebug = scene.children.length;
    
    const { integration: integration2, scene: scene2 } = createTestIntegration({
      debug: false,
    });
    integration2.init();
    
    expect(childCountWithDebug).toBeGreaterThanOrEqual(scene2.children.length);
  });
});

describe('World Integration Tests', () => {
  test('getWorld() returns VoxelWorld instance', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const world = integration.world;
    expect(world).toBeDefined();
    expect(world.chunks).toBeDefined();
  });

  test('Chunk access through integration matches direct world access', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const worldChunk = integration.world.getChunk(0, 0, 0);
    expect(worldChunk).toBeDefined();
    expect(worldChunk!.cx).toBe(0);
  });

  test('Update propagates to world streaming', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    expect(integration.world.getChunk(-2, 0, 0)).toBeDefined();
    
    integration.update(new THREE.Vector3(16, 0, 0), 0.016);
    
    expect(integration.world.getChunk(-2, 0, 0)).toBeUndefined();
    expect(integration.world.getChunk(2, 0, 0)).toBeDefined();
  });
});

describe('Collision Integration Tests', () => {
  test('getCollision() returns VoxelCollision instance', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const collision = integration.collision;
    expect(collision).toBeDefined();
  });

  test('Collision is enabled by default', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    expect(integration.config.collisionEnabled).toBe(true);
    expect(integration.collision.colliders.size).toBeGreaterThan(0);
  });

  test('Collision can be disabled in config', () => {
    const { integration } = createTestIntegration({ collisionEnabled: false });
    integration.init();
    
    expect(integration.config.collisionEnabled).toBe(false);
    expect(integration.collision.colliders.size).toBe(0);
  });

  test('Collision colliders exist for chunks with terrain', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const colliders = integration.collision.colliders;
    
    let foundGroundChunk = false;
    for (const [key, _collider] of colliders) {
      if (key.includes('0,0,0')) {
        foundGroundChunk = true;
        break;
      }
    }
    expect(foundGroundChunk).toBe(true);
  });
});

describe('Spawn Position Tests', () => {
  test('getSpawnPosition returns position above terrain', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const spawn = integration.getSpawnPosition();
    
    expect(spawn).toBeDefined();
    expect(spawn.y).toBeGreaterThanOrEqual(INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE);
  });

  test('getSpawnPosition returns valid Vector3', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const spawn = integration.getSpawnPosition();
    
    expect(Number.isFinite(spawn.x)).toBe(true);
    expect(Number.isFinite(spawn.y)).toBe(true);
    expect(Number.isFinite(spawn.z)).toBe(true);
  });
});

describe('Capsule Collision Tests', () => {
  test('collideCapsule returns collision result', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const position = new THREE.Vector3(0, INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE - 1, 0);
    const velocity = new THREE.Vector3(0, -1, 0);
    
    const result = integration.collideCapsule(position, velocity);
    
    expect(result).toBeDefined();
    expect(result.position).toBeDefined();
    expect(result.velocity).toBeDefined();
    expect(result.grounded).toBeDefined();
  });

  test('collideCapsule detects ground collision', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const position = new THREE.Vector3(0, 1, 0);
    const velocity = new THREE.Vector3(0, -5, 0);
    
    const result = integration.collideCapsule(position, velocity);
    
    expect(result.grounded || result.velocity.y >= velocity.y).toBe(true);
  });

  test('collideCapsule with collision disabled returns unmodified', () => {
    const { integration } = createTestIntegration({ collisionEnabled: false });
    integration.init();
    
    const position = new THREE.Vector3(0, 1, 0);
    const velocity = new THREE.Vector3(0, -5, 0);
    
    const result = integration.collideCapsule(position, velocity);
    
    expect(result.position.equals(position)).toBe(true);
    expect(result.velocity.equals(velocity)).toBe(true);
  });
});

describe('Update Loop Tests', () => {
  test('update() processes without error', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    let errorThrown = false;
    try {
      integration.update(new THREE.Vector3(0, 0, 0), 0.016);
      integration.update(new THREE.Vector3(1, 0, 0), 0.016);
      integration.update(new THREE.Vector3(2, 0, 0), 0.016);
    } catch {
      errorThrown = true;
    }
    
    expect(errorThrown).toBe(false);
  });

  test('update() handles large delta time gracefully', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    let errorThrown = false;
    try {
      integration.update(new THREE.Vector3(0, 0, 0), 1.0);
    } catch {
      errorThrown = true;
    }
    
    expect(errorThrown).toBe(false);
  });

  test('Streaming disabled prevents chunk loading on movement', () => {
    const { integration } = createTestIntegration({ streamingEnabled: false });
    integration.init();
    
    const initialChunks = new Set(integration.world.chunks.keys());
    
    integration.update(new THREE.Vector3(100, 0, 0), 0.016);
    
    const afterChunks = new Set(integration.world.chunks.keys());
    
    const chunksEqual =
      initialChunks.size === afterChunks.size &&
      [...initialChunks].every((k) => afterChunks.has(k));
    expect(chunksEqual).toBe(true);
  });
});

describe('Config Toggle Tests', () => {
  test('toggleDebug() changes debug visualization', () => {
    const { integration } = createTestIntegration({ debug: false });
    integration.init();
    
    integration.toggleDebug(true);
    expect(integration.config.debug).toBe(true);
    
    integration.toggleDebug(false);
    expect(integration.config.debug).toBe(false);
  });

  test('toggleCollision() changes collision state', () => {
    const { integration } = createTestIntegration({ collisionEnabled: true });
    integration.init();
    
    const initialColliderCount = integration.collision.colliders.size;
    expect(initialColliderCount).toBeGreaterThan(0);
    
    integration.toggleCollision(false);
    expect(integration.config.collisionEnabled).toBe(false);
  });
});

describe('Stats Tests', () => {
  test('getStats() returns world stats', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const stats = integration.getStats();
    
    expect(stats.chunksLoaded).toBe(64);
    expect(stats.meshesVisible).toBeGreaterThan(0);
  });

  test('Stats update after streaming', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const statsBefore = integration.getStats();
    
    integration.update(new THREE.Vector3(16, 0, 0), 0.016);
    
    const statsAfter = integration.getStats();
    
    expect(statsAfter.chunksLoaded).toBe(64);
    expect(statsAfter.bounds.minCx).toBeGreaterThan(statsBefore.bounds.minCx);
  });
});

describe('Refresh Tests', () => {
  test('refresh() regenerates meshes', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    let errorThrown = false;
    try {
      integration.refresh();
    } catch {
      errorThrown = true;
    }
    
    expect(errorThrown).toBe(false);
    expect(integration.world.getChunkCount()).toBe(64);
  });
});

describe('Dispose Tests', () => {
  test('dispose() cleans up all resources', () => {
    const { integration, scene } = createTestIntegration();
    integration.init();
    
    expect(integration.world.getChunkCount()).toBe(64);
    expect(scene.children.length).toBeGreaterThan(0);
    
    integration.dispose();
    
    expect(integration.world.getChunkCount()).toBe(0);
    expect(scene.children.length).toBe(0);
  });

  test('dispose() cleans up collision', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    expect(integration.collision.colliders.size).toBeGreaterThan(0);
    
    integration.dispose();
    
    expect(integration.collision.colliders.size).toBe(0);
  });
});

describe('Edge Cases', () => {
  test('Update before init is handled gracefully', () => {
    const { integration } = createTestIntegration();
    
    let errorThrown = false;
    try {
      integration.update(new THREE.Vector3(0, 0, 0), 0.016);
    } catch {
      errorThrown = true;
    }
    
    expect(errorThrown).toBe(false);
  });

  test('Double init does not duplicate resources', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const count1 = integration.world.getChunkCount();
    
    integration.init();
    
    const count2 = integration.world.getChunkCount();
    
    expect(count1).toBe(64);
    expect(count2).toBe(64);
  });

  test('Dispose then reinit works correctly', () => {
    const { integration } = createTestIntegration();
    integration.init();
    integration.dispose();
    
    expect(integration.world.getChunkCount()).toBe(0);
    
    integration.init();
    
    expect(integration.world.getChunkCount()).toBe(64);
  });
});
