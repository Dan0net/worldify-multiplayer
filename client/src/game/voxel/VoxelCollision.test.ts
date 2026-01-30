import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as THREE from 'three';

// Mock three-mesh-bvh to avoid complex geometry requirements
vi.mock('three-mesh-bvh', () => ({
  MeshBVH: vi.fn(),
  StaticGeometryGenerator: vi.fn(() => ({
    generate: vi.fn(() => new THREE.BufferGeometry()),
  })),
}));

import { VoxelCollision, type CapsuleInfo } from './VoxelCollision.js';

describe('VoxelCollision', () => {
  let collision: VoxelCollision;
  let mockScene: THREE.Scene;

  beforeEach(() => {
    collision = new VoxelCollision();
    mockScene = new THREE.Scene();
    collision.setScene(mockScene);
  });

  it('initializes with no colliders', () => {
    const stats = collision.getStats();
    expect(stats.meshCount).toBe(0);
    expect(stats.needsRebuild).toBe(false);
  });

  it('tracks added colliders', () => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial()
    );
    
    collision.addCollider('chunk_0_0_0', mesh);
    
    const stats = collision.getStats();
    expect(stats.meshCount).toBe(1);
    expect(stats.needsRebuild).toBe(true);
  });

  it('removes colliders by key', () => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial()
    );
    
    collision.addCollider('test_chunk', mesh);
    expect(collision.getStats().meshCount).toBe(1);
    
    collision.removeCollider('test_chunk');
    expect(collision.getStats().meshCount).toBe(0);
  });

  it('handles capsule collision with no geometry', () => {
    const capsule: CapsuleInfo = {
      start: new THREE.Vector3(0, 0, 0),
      end: new THREE.Vector3(0, 1.7, 0),
      radius: 0.3,
    };
    const velocity = new THREE.Vector3(0, -1, 0);
    
    // Should not throw even with no BVH
    const result = collision.resolveCapsuleCollision(capsule, velocity);
    
    expect(result).toHaveProperty('collided');
    expect(result).toHaveProperty('displacement');
    expect(result).toHaveProperty('grounded');
  });

  it('debug mode can be toggled', () => {
    collision.setDebugEnabled(true);
    // No error thrown
    collision.setDebugEnabled(false);
  });

  it('disposes cleanly', () => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial()
    );
    collision.addCollider('chunk', mesh);
    
    collision.dispose();
    
    expect(collision.getStats().meshCount).toBe(0);
  });
});
