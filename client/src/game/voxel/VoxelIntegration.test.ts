/**
 * Integration tests for VoxelIntegration
 * Tests the facade that ties VoxelWorld, VoxelCollision, and VoxelDebug together
 */

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { VoxelIntegration, VoxelConfig } from './VoxelIntegration.js';
import {
  PLAYER_CHUNK_RADIUS,
  CHUNK_WORLD_SIZE,
  INITIAL_TERRAIN_HEIGHT,
  VOXEL_SCALE,
} from '@worldify/shared';

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

function createDefaultConfig(): VoxelConfig {
  return {
    debugEnabled: false,
    collisionEnabled: true,
  };
}

function createTestIntegration(
  config?: Partial<VoxelConfig>
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

  test('Debug mode can be enabled', () => {
    const { integration, scene } = createTestIntegration({ debugEnabled: true });
    integration.init();
    
    // Just verify it doesn't throw
    expect(integration).toBeDefined();
  });

  test('isInitialized returns correct state', () => {
    const { integration } = createTestIntegration();
    
    expect(integration.isInitialized()).toBe(false);
    integration.init();
    expect(integration.isInitialized()).toBe(true);
  });
});

describe('World Integration Tests', () => {
  test('world property returns VoxelWorld instance', () => {
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
    
    // Move far enough to trigger unload of old chunks
    integration.update(new THREE.Vector3(32, 0, 0));
    
    expect(integration.world.getChunk(-2, 0, 0)).toBeUndefined();
    expect(integration.world.getChunk(2, 0, 0)).toBeDefined();
  });
});

describe('Collision Integration Tests', () => {
  test('collision property returns VoxelCollision instance', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const collision = integration.collision;
    expect(collision).toBeDefined();
  });

  test('Collision is enabled by default', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    // Collision should be enabled and have built colliders
    expect(integration.getStats().collisionEnabled).toBe(true);
    expect(integration.getStats().colliderCount).toBeGreaterThan(0);
  });

  test('Collision can be disabled in config', () => {
    const { integration } = createTestIntegration({ collisionEnabled: false });
    integration.init();
    
    expect(integration.getStats().collisionEnabled).toBe(false);
  });

  test('setCollisionEnabled toggles collision state', () => {
    const { integration } = createTestIntegration({ collisionEnabled: true });
    integration.init();
    
    expect(integration.getStats().collisionEnabled).toBe(true);
    
    integration.setCollisionEnabled(false);
    expect(integration.getStats().collisionEnabled).toBe(false);
    
    integration.setCollisionEnabled(true);
    expect(integration.getStats().collisionEnabled).toBe(true);
  });
});

describe('Capsule Collision Tests', () => {
  test('resolveCapsuleCollision returns collision result', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const capsuleInfo = {
      radius: 0.3,
      segment: new THREE.Line3(
        new THREE.Vector3(0, 0.3, 0),
        new THREE.Vector3(0, 1.5, 0)
      ),
    };
    const position = new THREE.Vector3(0, INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE - 1, 0);
    const velocity = new THREE.Vector3(0, -1, 0);
    
    const result = integration.resolveCapsuleCollision(capsuleInfo, position, velocity, 0.016);
    
    expect(result).toBeDefined();
    expect(result.deltaVector).toBeDefined();
    expect(typeof result.isOnGround).toBe('boolean');
    expect(typeof result.collided).toBe('boolean');
  });

  test('resolveCapsuleCollision with collision disabled returns no collision', () => {
    const { integration } = createTestIntegration({ collisionEnabled: false });
    integration.init();
    
    const capsuleInfo = {
      radius: 0.3,
      segment: new THREE.Line3(
        new THREE.Vector3(0, 0.3, 0),
        new THREE.Vector3(0, 1.5, 0)
      ),
    };
    const position = new THREE.Vector3(0, 1, 0);
    const velocity = new THREE.Vector3(0, -5, 0);
    
    const result = integration.resolveCapsuleCollision(capsuleInfo, position, velocity, 0.016);
    
    expect(result.collided).toBe(false);
    expect(result.deltaVector.length()).toBe(0);
  });
});

describe('Update Loop Tests', () => {
  test('update() processes without error', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    expect(() => {
      integration.update(new THREE.Vector3(0, 0, 0));
      integration.update(new THREE.Vector3(1, 0, 0));
      integration.update(new THREE.Vector3(2, 0, 0));
    }).not.toThrow();
  });

  test('update() before init does not throw', () => {
    const { integration } = createTestIntegration();
    
    expect(() => {
      integration.update(new THREE.Vector3(0, 0, 0));
    }).not.toThrow();
  });
});

describe('Debug Toggle Tests', () => {
  test('setDebugEnabled changes debug state', () => {
    const { integration } = createTestIntegration({ debugEnabled: false });
    integration.init();
    
    expect(integration.getStats().debugEnabled).toBe(false);
    
    integration.setDebugEnabled(true);
    expect(integration.getStats().debugEnabled).toBe(true);
    
    integration.setDebugEnabled(false);
    expect(integration.getStats().debugEnabled).toBe(false);
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

  test('getStats includes collision info', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const stats = integration.getStats();
    
    expect(typeof stats.colliderCount).toBe('number');
    expect(typeof stats.triangleCount).toBe('number');
    expect(typeof stats.collisionEnabled).toBe('boolean');
    expect(typeof stats.debugEnabled).toBe('boolean');
  });

  test('Stats update after streaming', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const statsBefore = integration.getStats();
    
    // Move far enough to trigger chunk loading/unloading
    integration.update(new THREE.Vector3(32, 0, 0));
    
    const statsAfter = integration.getStats();
    
    // Bounds should have shifted
    expect(statsAfter.bounds.minCx).toBeGreaterThan(statsBefore.bounds.minCx);
  });
});

describe('Collision Mesh Access Tests', () => {
  test('getCollisionMeshes returns array of meshes', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    const meshes = integration.getCollisionMeshes();
    
    expect(Array.isArray(meshes)).toBe(true);
    expect(meshes.length).toBeGreaterThan(0);
  });
});

describe('Refresh Tests', () => {
  test('refresh() regenerates world without error', () => {
    const { integration } = createTestIntegration();
    integration.init();
    
    expect(() => {
      integration.refresh();
    }).not.toThrow();
    
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
    
    expect(integration.getStats().colliderCount).toBeGreaterThan(0);
    
    integration.dispose();
    
    expect(integration.getStats().colliderCount).toBe(0);
  });
});

describe('Edge Cases', () => {
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
