/**
 * Debug test to check collision mesh availability
 */

import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { VoxelIntegration } from '../voxel/VoxelIntegration.js';
import { SpawnManager } from './SpawnManager.js';
import { useGameStore } from '../../state/store.js';

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

describe('SpawnManager with Local Chunks (useServerChunks=false)', () => {
  test('finds spawn when useServerChunks=false', () => {
    // Force local chunk generation
    useGameStore.setState({ useServerChunks: false });
    
    const scene = createTestScene();
    const integration = new VoxelIntegration(scene, { collisionEnabled: true });
    integration.init();
    
    // Check meshes exist
    const meshCount = integration.world.meshes.size;
    console.log('Total ChunkMesh objects:', meshCount);
    
    // Check how many have geometry
    let withGeometry = 0;
    for (const [key, chunkMesh] of integration.world.meshes) {
      if (chunkMesh.hasGeometry()) {
        withGeometry++;
      }
    }
    console.log('ChunkMeshes with geometry:', withGeometry);
    
    // Get collision meshes
    const collisionMeshes = integration.getCollisionMeshes();
    console.log('Collision meshes available:', collisionMeshes.length);
    
    // Create spawn manager and connect
    const spawnManager = new SpawnManager(scene);
    spawnManager.setTerrainProvider(integration);
    
    // Update to trigger spawn detection
    spawnManager.update();
    
    console.log('Spawn ready:', spawnManager.isSpawnReady());
    
    if (spawnManager.isSpawnReady()) {
      const pos = spawnManager.getCachedSpawnPosition();
      console.log('Spawn position:', pos.x, pos.y, pos.z);
    }
    
    expect(collisionMeshes.length).toBeGreaterThan(0);
    expect(spawnManager.isSpawnReady()).toBe(true);
  });
});
