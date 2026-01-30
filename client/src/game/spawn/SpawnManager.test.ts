/**
 * Tests for SpawnManager
 * 
 * Covers:
 * - Spawn position finding via raycast
 * - Fallback behavior when terrain not loaded
 * - Respawn position priority (lastGrounded > currentXZ > origin)
 * - Spawn ready state detection
 * - Debug visualization lifecycle
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import * as THREE from 'three';
import { SpawnManager } from './SpawnManager.js';
import type { TerrainRaycaster } from './TerrainRaycaster.js';
import { 
  PLAYER_HEIGHT, 
  SPAWN_HEIGHT_OFFSET, 
  SPAWN_FALLBACK_HEIGHT,
  SPAWN_RAYCAST_HEIGHT 
} from '@worldify/shared';

// ============== Mocks ==============

/**
 * Mock terrain provider that can be configured for different test scenarios
 */
class MockTerrainProvider implements TerrainRaycaster {
  private meshes: THREE.Object3D[] = [];
  private terrainHeights: Map<string, number> = new Map();

  /**
   * Add a mesh to the collision list
   */
  addMesh(mesh: THREE.Object3D): void {
    this.meshes.push(mesh);
  }

  /**
   * Set terrain height at a specific XZ coordinate
   */
  setTerrainHeight(x: number, z: number, height: number): void {
    this.terrainHeights.set(`${x},${z}`, height);
  }

  /**
   * Get terrain height at a specific XZ (for test verification)
   */
  getTerrainHeight(x: number, z: number): number | undefined {
    return this.terrainHeights.get(`${x},${z}`);
  }

  /**
   * Clear all meshes
   */
  clearMeshes(): void {
    this.meshes = [];
  }

  getCollisionMeshes(): THREE.Object3D[] {
    return this.meshes;
  }

  /**
   * Create a simple plane mesh at a given Y height for raycasting
   */
  static createTerrainPlane(y: number, size: number = 100): THREE.Mesh {
    const geometry = new THREE.PlaneGeometry(size, size);
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2; // Rotate to be horizontal
    mesh.position.y = y;
    mesh.updateMatrixWorld();
    return mesh;
  }
}

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

function createSpawnManager(scene?: THREE.Scene): SpawnManager {
  return new SpawnManager(scene ?? createTestScene(), { showDebug: false });
}

// ============== Basic Initialization Tests ==============

describe('SpawnManager Initialization', () => {
  test('creates with default config', () => {
    const manager = createSpawnManager();
    expect(manager).toBeDefined();
    expect(manager.isSpawnReady()).toBe(false);
  });

  test('starts with no cached spawn position', () => {
    const manager = createSpawnManager();
    // Should return fallback position when no terrain provider
    const pos = manager.getCachedSpawnPosition();
    expect(pos.y).toBe(SPAWN_FALLBACK_HEIGHT);
  });
});

// ============== Terrain Provider Tests ==============

describe('TerrainProvider Integration', () => {
  let manager: SpawnManager;
  let terrain: MockTerrainProvider;

  beforeEach(() => {
    manager = createSpawnManager();
    terrain = new MockTerrainProvider();
    manager.setTerrainProvider(terrain);
  });

  test('reports spawn not ready when no meshes', () => {
    manager.update();
    expect(manager.isSpawnReady()).toBe(false);
  });

  test('detects spawn ready when terrain mesh exists at origin', () => {
    const plane = MockTerrainProvider.createTerrainPlane(10);
    terrain.addMesh(plane);
    
    manager.update();
    
    expect(manager.isSpawnReady()).toBe(true);
  });

  test('updates spawn position when new meshes are added', () => {
    // No meshes initially
    manager.update();
    expect(manager.isSpawnReady()).toBe(false);

    // Add terrain
    const plane = MockTerrainProvider.createTerrainPlane(5);
    terrain.addMesh(plane);
    manager.update();

    expect(manager.isSpawnReady()).toBe(true);
    const pos = manager.getCachedSpawnPosition();
    // Spawn Y = terrain height + player height + offset
    expect(pos.y).toBeCloseTo(5 + PLAYER_HEIGHT + SPAWN_HEIGHT_OFFSET, 1);
  });
});

// ============== Spawn Position Finding Tests ==============

describe('getSpawnPosition', () => {
  let manager: SpawnManager;
  let terrain: MockTerrainProvider;

  beforeEach(() => {
    manager = createSpawnManager();
    terrain = new MockTerrainProvider();
    manager.setTerrainProvider(terrain);
  });

  test('returns fallback height when no terrain provider', () => {
    const managerNoTerrain = createSpawnManager();
    const pos = managerNoTerrain.getSpawnPosition(0, 0);
    
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(SPAWN_FALLBACK_HEIGHT);
    expect(pos.z).toBe(0);
  });

  test('returns fallback height when no collision meshes', () => {
    const pos = manager.getSpawnPosition(0, 0);
    
    expect(pos.y).toBe(SPAWN_FALLBACK_HEIGHT);
  });

  test('returns correct height when terrain exists', () => {
    const terrainY = 15;
    const plane = MockTerrainProvider.createTerrainPlane(terrainY);
    terrain.addMesh(plane);

    const pos = manager.getSpawnPosition(0, 0);

    const expectedY = terrainY + PLAYER_HEIGHT + SPAWN_HEIGHT_OFFSET;
    expect(pos.y).toBeCloseTo(expectedY, 1);
  });

  test('finds spawn at specific XZ coordinates', () => {
    const terrainY = 20;
    const plane = MockTerrainProvider.createTerrainPlane(terrainY, 200);
    terrain.addMesh(plane);

    const pos = manager.getSpawnPosition(50, -30);

    expect(pos.x).toBe(50);
    expect(pos.z).toBe(-30);
    expect(pos.y).toBeCloseTo(terrainY + PLAYER_HEIGHT + SPAWN_HEIGHT_OFFSET, 1);
  });
});

// ============== Respawn Position Finding Tests ==============

describe('findRespawnPosition', () => {
  let manager: SpawnManager;
  let terrain: MockTerrainProvider;

  beforeEach(() => {
    manager = createSpawnManager();
    terrain = new MockTerrainProvider();
    manager.setTerrainProvider(terrain);
  });

  test('priority 1: returns last grounded position when available', () => {
    const lastGrounded = new THREE.Vector3(10, 25, -5);
    const currentPos = new THREE.Vector3(100, -500, 100);

    const respawn = manager.findRespawnPosition(currentPos, lastGrounded);

    expect(respawn).not.toBeNull();
    expect(respawn!.x).toBe(10);
    expect(respawn!.y).toBe(25);
    expect(respawn!.z).toBe(-5);
  });

  test('priority 2: raycasts at current XZ when no lastGrounded', () => {
    const terrainY = 12;
    const plane = MockTerrainProvider.createTerrainPlane(terrainY, 200);
    terrain.addMesh(plane);

    const currentPos = new THREE.Vector3(30, -100, 40);

    const respawn = manager.findRespawnPosition(currentPos, null);

    expect(respawn).not.toBeNull();
    expect(respawn!.x).toBe(30);
    expect(respawn!.z).toBe(40);
    expect(respawn!.y).toBeCloseTo(terrainY + PLAYER_HEIGHT + SPAWN_HEIGHT_OFFSET, 1);
  });

  test('priority 3: raycasts at origin when current XZ fails', () => {
    // Create a small terrain plane only at origin
    const terrainY = 8;
    const smallPlane = MockTerrainProvider.createTerrainPlane(terrainY, 10);
    terrain.addMesh(smallPlane);

    // Current position is far from origin where no terrain exists
    const currentPos = new THREE.Vector3(500, -100, 500);

    const respawn = manager.findRespawnPosition(currentPos, null);

    expect(respawn).not.toBeNull();
    expect(respawn!.x).toBe(0);
    expect(respawn!.z).toBe(0);
    expect(respawn!.y).toBeCloseTo(terrainY + PLAYER_HEIGHT + SPAWN_HEIGHT_OFFSET, 1);
  });

  test('returns null when all methods fail (no terrain)', () => {
    const currentPos = new THREE.Vector3(0, -100, 0);

    const respawn = manager.findRespawnPosition(currentPos, null);

    expect(respawn).toBeNull();
  });

  test('clones lastGrounded position (does not return same reference)', () => {
    const lastGrounded = new THREE.Vector3(10, 25, -5);
    const currentPos = new THREE.Vector3(0, 0, 0);

    const respawn = manager.findRespawnPosition(currentPos, lastGrounded);

    expect(respawn).not.toBe(lastGrounded);
    expect(respawn!.equals(lastGrounded)).toBe(true);
  });
});

// ============== Spawn Ready State Tests ==============

describe('Spawn Ready Detection', () => {
  let manager: SpawnManager;
  let terrain: MockTerrainProvider;

  beforeEach(() => {
    manager = createSpawnManager();
    terrain = new MockTerrainProvider();
    manager.setTerrainProvider(terrain);
  });

  test('becomes ready when terrain loads', () => {
    expect(manager.isSpawnReady()).toBe(false);

    const plane = MockTerrainProvider.createTerrainPlane(10);
    terrain.addMesh(plane);
    manager.update();

    expect(manager.isSpawnReady()).toBe(true);
  });

  test('only re-raycasts when mesh count changes', () => {
    const plane1 = MockTerrainProvider.createTerrainPlane(10);
    terrain.addMesh(plane1);
    manager.update();

    const pos1 = manager.getCachedSpawnPosition();

    // Update again without mesh count change - should not change
    manager.update();
    const pos2 = manager.getCachedSpawnPosition();

    expect(pos1.y).toBe(pos2.y);
  });

  test('updates spawn position when more meshes are added', () => {
    // First mesh at Y=10
    const plane1 = MockTerrainProvider.createTerrainPlane(10);
    terrain.addMesh(plane1);
    manager.update();
    const pos1 = manager.getCachedSpawnPosition();

    // Add second mesh at Y=5 (closer to origin raycast)
    // The raycast should hit the higher mesh first
    const plane2 = MockTerrainProvider.createTerrainPlane(20);
    terrain.addMesh(plane2);
    manager.update();
    const pos2 = manager.getCachedSpawnPosition();

    // Mesh count changed, so raycast should have been re-run
    // The raycast hits the highest surface first (plane2 at Y=20)
    expect(pos2.y).toBeGreaterThan(pos1.y);
  });
});

// ============== Debug Visualization Tests ==============

describe('Debug Visualization', () => {
  test('creates debug objects when showDebug is true', () => {
    const scene = createTestScene();
    const manager = new SpawnManager(scene, { showDebug: true });
    const terrain = new MockTerrainProvider();
    terrain.addMesh(MockTerrainProvider.createTerrainPlane(10));
    manager.setTerrainProvider(terrain);

    const initialChildren = scene.children.length;
    
    // Trigger spawn detection which creates debug viz
    manager.getSpawnPosition(0, 0);

    // Debug objects should have been added
    expect(scene.children.length).toBeGreaterThan(initialChildren);
  });

  test('clearDebugVisualization removes all debug objects', () => {
    const scene = createTestScene();
    const manager = new SpawnManager(scene, { showDebug: true });
    const terrain = new MockTerrainProvider();
    terrain.addMesh(MockTerrainProvider.createTerrainPlane(10));
    manager.setTerrainProvider(terrain);

    manager.getSpawnPosition(0, 0);
    expect(scene.children.length).toBeGreaterThan(0);

    manager.clearDebugVisualization();
    expect(scene.children.length).toBe(0);
  });

  test('dispose clears debug visualization', () => {
    const scene = createTestScene();
    const manager = new SpawnManager(scene, { showDebug: true });
    const terrain = new MockTerrainProvider();
    terrain.addMesh(MockTerrainProvider.createTerrainPlane(10));
    manager.setTerrainProvider(terrain);

    manager.getSpawnPosition(0, 0);
    manager.dispose();

    expect(scene.children.length).toBe(0);
  });
});

// ============== Edge Cases ==============

describe('Edge Cases', () => {
  test('handles very high terrain', () => {
    const manager = createSpawnManager();
    const terrain = new MockTerrainProvider();
    terrain.addMesh(MockTerrainProvider.createTerrainPlane(150));
    manager.setTerrainProvider(terrain);

    const pos = manager.getSpawnPosition(0, 0);

    // Should still work - raycast starts from SPAWN_RAYCAST_HEIGHT (200)
    expect(pos.y).toBeCloseTo(150 + PLAYER_HEIGHT + SPAWN_HEIGHT_OFFSET, 1);
  });

  test('handles terrain above raycast height (fallback)', () => {
    const manager = createSpawnManager();
    const terrain = new MockTerrainProvider();
    // Terrain above raycast start - ray won't hit it going down
    terrain.addMesh(MockTerrainProvider.createTerrainPlane(SPAWN_RAYCAST_HEIGHT + 50));
    manager.setTerrainProvider(terrain);

    const pos = manager.getSpawnPosition(0, 0);

    // Should fallback since raycast misses
    expect(pos.y).toBe(SPAWN_FALLBACK_HEIGHT);
  });

  test('handles negative terrain height', () => {
    const manager = createSpawnManager();
    const terrain = new MockTerrainProvider();
    terrain.addMesh(MockTerrainProvider.createTerrainPlane(-10));
    manager.setTerrainProvider(terrain);

    const pos = manager.getSpawnPosition(0, 0);

    expect(pos.y).toBeCloseTo(-10 + PLAYER_HEIGHT + SPAWN_HEIGHT_OFFSET, 1);
  });

  test('getCachedSpawnPosition returns clone', () => {
    const manager = createSpawnManager();
    const terrain = new MockTerrainProvider();
    terrain.addMesh(MockTerrainProvider.createTerrainPlane(10));
    manager.setTerrainProvider(terrain);
    manager.update();

    const pos1 = manager.getCachedSpawnPosition();
    const pos2 = manager.getCachedSpawnPosition();

    expect(pos1).not.toBe(pos2);
    expect(pos1.equals(pos2)).toBe(true);
  });
});

// ============== Constants Validation ==============

describe('Constants Validation', () => {
  test('SPAWN_HEIGHT_OFFSET is reasonable', () => {
    expect(SPAWN_HEIGHT_OFFSET).toBeGreaterThan(0);
    expect(SPAWN_HEIGHT_OFFSET).toBeLessThan(10);
  });

  test('SPAWN_FALLBACK_HEIGHT is high enough for safety', () => {
    expect(SPAWN_FALLBACK_HEIGHT).toBeGreaterThan(30);
  });

  test('SPAWN_RAYCAST_HEIGHT is high enough for tall terrain', () => {
    expect(SPAWN_RAYCAST_HEIGHT).toBeGreaterThan(100);
  });
});
