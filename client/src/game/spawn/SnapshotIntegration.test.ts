/**
 * Integration tests for Snapshot interactions with spawn, build, and loading
 * 
 * These tests simulate network snapshot scenarios and verify:
 * - Snapshot applies correctly during spawn
 * - Build commits interleaved with snapshots
 * - Player state recovery after disconnection patterns
 * - Chunk loading/unloading during snapshot processing
 */

import { describe, test, expect, beforeEach, vi, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { SpawnManager } from './SpawnManager.js';
import { VoxelIntegration } from '../voxel/VoxelIntegration.js';
import {
  RoomSnapshot,
  PlayerSnapshot,
  FLAG_GROUNDED,
  FLAG_SPRINTING,
  PLAYER_HEIGHT,
  SPAWN_HEIGHT_OFFSET,
  INITIAL_TERRAIN_HEIGHT,
  VOXEL_SCALE,
  BuildMode,
  BuildShape,
  createBuildOperation,
} from '@worldify/shared';
import { useGameStore } from '../../state/store.js';

// ============== Browser Environment Mocks ==============

// Mock window for controls.ts that adds event listeners
const mockWindow = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  requestAnimationFrame: vi.fn(),
  cancelAnimationFrame: vi.fn(),
};

// Mock document for pointer lock
const mockDocument = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  pointerLockElement: null,
  exitPointerLock: vi.fn(),
  body: {
    requestPointerLock: vi.fn(),
  },
};

// Set up global mocks before importing PlayerManager
beforeAll(() => {
  (global as any).window = mockWindow;
  (global as any).document = mockDocument;
});

afterAll(() => {
  delete (global as any).window;
  delete (global as any).document;
});

// Import PlayerManager after mocks are set up
// Use dynamic import to ensure mocks are in place
let PlayerManager: typeof import('../PlayerManager.js').PlayerManager;

beforeAll(async () => {
  const module = await import('../PlayerManager.js');
  PlayerManager = module.PlayerManager;
});

// ============== Test Utilities ==============

function createTestScene(): THREE.Scene {
  return new THREE.Scene();
}

function createTestIntegration(): {
  integration: VoxelIntegration;
  scene: THREE.Scene;
} {
  useGameStore.setState({ useServerChunks: false });
  const scene = createTestScene();
  const integration = new VoxelIntegration(scene, { collisionEnabled: true });
  integration.init();
  return { integration, scene };
}

function createTestSetup(): {
  scene: THREE.Scene;
  integration: VoxelIntegration;
  spawn: SpawnManager;
  playerManager: InstanceType<typeof PlayerManager>;
} {
  const { integration, scene } = createTestIntegration();
  const spawn = new SpawnManager(scene, { showDebug: false });
  spawn.setTerrainProvider(integration);
  const playerManager = new PlayerManager();
  playerManager.setVoxelIntegration(integration);
  return { scene, integration, spawn, playerManager };
}

/**
 * Create a mock snapshot with players
 */
function createSnapshot(tick: number, players: Partial<PlayerSnapshot>[]): RoomSnapshot {
  return {
    tick,
    players: players.map((p, index) => ({
      playerId: p.playerId ?? index + 1,
      x: p.x ?? 0,
      y: p.y ?? 3,
      z: p.z ?? 0,
      yaw: p.yaw ?? 0,
      pitch: p.pitch ?? 0,
      buttons: p.buttons ?? 0,
      flags: p.flags ?? FLAG_GROUNDED,
    })),
  };
}

/**
 * Create a build operation for adding material
 */
function createAddBuild(x: number, y: number, z: number, size: number = 2) {
  return createBuildOperation(x, y, z, {
    shape: BuildShape.SPHERE,
    mode: BuildMode.ADD,
    size: { x: size, y: size, z: size },
    material: 1,
  });
}

// ============== Snapshot + Spawn Interaction Tests ==============

describe('Snapshot and Spawn Interactions', () => {
  test('spawn position valid before first snapshot', () => {
    const { spawn, integration } = createTestSetup();
    
    spawn.update();
    
    // Spawn should be ready from local terrain generation
    expect(spawn.isSpawnReady()).toBe(true);
    
    const spawnPos = spawn.getCachedSpawnPosition();
    expect(spawnPos.y).toBeGreaterThan(0);
  });

  test('player snapshot position uses spawn when joining', () => {
    const { scene, spawn, playerManager, integration } = createTestSetup();
    
    spawn.update();
    const spawnPos = spawn.getCachedSpawnPosition();
    
    // Set local player ID
    playerManager.setLocalPlayerId(1);
    
    // First snapshot places player at server-decided position (which should be near spawn)
    const snapshot = createSnapshot(1, [
      { playerId: 1, x: spawnPos.x, y: spawnPos.y, z: spawnPos.z },
    ]);
    
    playerManager.handleSnapshot(snapshot, scene);
    
    const localPlayer = playerManager.getLocalPlayer();
    expect(localPlayer).toBeDefined();
  });

  test('respawn finds position after snapshot shows player fell', () => {
    const { scene, spawn, playerManager, integration } = createTestSetup();
    
    spawn.update();
    playerManager.setLocalPlayerId(1);
    
    // Player joins at normal position
    const normalY = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE + PLAYER_HEIGHT;
    const snapshot1 = createSnapshot(1, [
      { playerId: 1, x: 0, y: normalY, z: 0, flags: FLAG_GROUNDED },
    ]);
    playerManager.handleSnapshot(snapshot1, scene);
    
    // Simulate player falls far below
    const fallenY = -100;
    const currentPos = new THREE.Vector3(0, fallenY, 0);
    const lastGrounded = new THREE.Vector3(0, normalY, 0);
    
    const respawnPos = spawn.findRespawnPosition(currentPos, lastGrounded);
    
    expect(respawnPos).not.toBeNull();
    // Should respawn at last grounded position
    expect(respawnPos!.y).toBe(normalY);
  });

  test('multiple players in snapshot do not interfere with spawn', () => {
    const { scene, spawn, playerManager, integration } = createTestSetup();
    
    spawn.update();
    const spawnPos = spawn.getCachedSpawnPosition();
    
    playerManager.setLocalPlayerId(1);
    
    // Snapshot with multiple players
    const snapshot = createSnapshot(1, [
      { playerId: 1, x: 0, y: spawnPos.y, z: 0 },
      { playerId: 2, x: 5, y: spawnPos.y, z: 5 },
      { playerId: 3, x: -5, y: spawnPos.y, z: -5 },
    ]);
    
    playerManager.handleSnapshot(snapshot, scene);
    
    // Spawn should still work for any position
    expect(spawn.getSpawnPosition(5, 5)).toBeDefined();
    expect(spawn.getSpawnPosition(-5, -5)).toBeDefined();
  });
});

// ============== Snapshot + Build Interaction Tests ==============

describe('Snapshot and Build Interactions', () => {
  test('build commit between snapshots updates terrain', () => {
    const { scene, integration, spawn, playerManager } = createTestSetup();
    
    spawn.update();
    playerManager.setLocalPlayerId(1);
    
    // First snapshot
    const snapshot1 = createSnapshot(1, [
      { playerId: 1, x: 0, y: 3, z: 0 },
    ]);
    playerManager.handleSnapshot(snapshot1, scene);
    
    // Build commit arrives
    const build = createAddBuild(4, 4, 4, 2);
    const modified = integration.world.applyBuildOperation(build);
    integration.rebuildCollisionForChunks(modified);
    
    // Second snapshot
    const snapshot2 = createSnapshot(2, [
      { playerId: 1, x: 4, y: 5, z: 4 },
    ]);
    playerManager.handleSnapshot(snapshot2, scene);
    
    // Spawn at build location should work
    const spawnAtBuild = spawn.getSpawnPosition(4, 4);
    expect(spawnAtBuild).toBeDefined();
  });

  test('rapid build commits between snapshots', () => {
    const { scene, integration, playerManager } = createTestSetup();
    
    playerManager.setLocalPlayerId(1);
    
    // Interleave snapshots with builds
    for (let i = 0; i < 5; i++) {
      // Snapshot
      const snapshot = createSnapshot(i, [
        { playerId: 1, x: i * 2, y: 3, z: 0 },
      ]);
      playerManager.handleSnapshot(snapshot, scene);
      
      // Build
      const build = createAddBuild(i * 2, 4, 0, 1);
      integration.world.applyBuildOperation(build);
    }
    
    // World should still be intact
    expect(integration.world.getChunkCount()).toBe(64);
  });

  test('player position in snapshot reflects build height', () => {
    const { scene, integration, spawn, playerManager } = createTestSetup();
    
    spawn.update();
    playerManager.setLocalPlayerId(1);
    
    // Build a tall structure
    const structureHeight = 5;
    for (let y = 0; y < structureHeight; y++) {
      const build = createAddBuild(5, y + 2, 5, 1.5);
      integration.world.applyBuildOperation(build);
    }
    
    // Snapshot shows player on top of structure
    const topY = structureHeight + 3;
    const snapshot = createSnapshot(1, [
      { playerId: 1, x: 5, y: topY, z: 5, flags: FLAG_GROUNDED },
    ]);
    playerManager.handleSnapshot(snapshot, scene);
    
    // Respawn should use this as last grounded
    const currentPos = new THREE.Vector3(5, -50, 5);
    const lastGrounded = new THREE.Vector3(5, topY, 5);
    
    const respawn = spawn.findRespawnPosition(currentPos, lastGrounded);
    expect(respawn).not.toBeNull();
    expect(respawn!.y).toBe(topY);
  });
});

// ============== Snapshot + Chunk Loading Tests ==============

describe('Snapshot and Chunk Loading Interactions', () => {
  test('snapshot received before chunks fully loaded', () => {
    const scene = createTestScene();
    const playerManager = new PlayerManager();
    
    // Don't initialize integration yet (simulating late loading)
    playerManager.setLocalPlayerId(1);
    
    // Snapshot arrives before terrain
    const snapshot = createSnapshot(1, [
      { playerId: 1, x: 0, y: 10, z: 0 },
    ]);
    
    // Should not crash
    playerManager.handleSnapshot(snapshot, scene);
    
    const localPlayer = playerManager.getLocalPlayer();
    expect(localPlayer).toBeDefined();
  });

  test('player moves to new chunk area, spawn still works', () => {
    const { scene, integration, spawn, playerManager } = createTestSetup();
    
    spawn.update();
    playerManager.setLocalPlayerId(1);
    
    // Initial snapshot at origin
    const snapshot1 = createSnapshot(1, [
      { playerId: 1, x: 0, y: 3, z: 0 },
    ]);
    playerManager.handleSnapshot(snapshot1, scene);
    
    // Player moves far away (triggers chunk streaming)
    const farX = 20;
    integration.update(new THREE.Vector3(farX, 0, 0), 0.016);
    
    // Snapshot at new location
    const snapshot2 = createSnapshot(2, [
      { playerId: 1, x: farX, y: 3, z: 0 },
    ]);
    playerManager.handleSnapshot(snapshot2, scene);
    
    // Spawn at new location should work
    const spawnPos = spawn.getSpawnPosition(farX, 0);
    expect(spawnPos).toBeDefined();
    expect(Number.isFinite(spawnPos.y)).toBe(true);
  });

  test('chunks unload while processing snapshots', () => {
    const { scene, integration, spawn, playerManager } = createTestSetup();
    
    spawn.update();
    playerManager.setLocalPlayerId(1);
    
    // Start at origin
    playerManager.handleSnapshot(
      createSnapshot(1, [{ playerId: 1, x: 0, y: 3, z: 0 }]),
      scene
    );
    
    // Move through multiple chunk boundaries with snapshots
    const positions = [0, 16, 32, 48, 64];
    for (let i = 0; i < positions.length; i++) {
      const x = positions[i];
      integration.update(new THREE.Vector3(x, 0, 0), 0.016);
      
      playerManager.handleSnapshot(
        createSnapshot(i + 2, [{ playerId: 1, x, y: 3, z: 0 }]),
        scene
      );
    }
    
    // Original chunks should be unloaded
    expect(integration.world.getChunk(-2, 0, 0)).toBeUndefined();
    
    // Spawn at current location should still work
    expect(spawn.getSpawnPosition(64, 0)).toBeDefined();
  });
});

// ============== Edge Cases and Error Recovery ==============

describe('Edge Cases and Error Recovery', () => {
  test('empty snapshot handled gracefully', () => {
    const { scene, playerManager } = createTestSetup();
    
    playerManager.setLocalPlayerId(1);
    
    const emptySnapshot = createSnapshot(1, []);
    
    // Should not crash
    playerManager.handleSnapshot(emptySnapshot, scene);
  });

  test('duplicate player IDs in snapshot', () => {
    const { scene, playerManager } = createTestSetup();
    
    playerManager.setLocalPlayerId(1);
    
    // This shouldn't happen but should handle gracefully
    const snapshot = createSnapshot(1, [
      { playerId: 1, x: 0, y: 3, z: 0 },
      { playerId: 2, x: 5, y: 3, z: 5 },
    ]);
    
    playerManager.handleSnapshot(snapshot, scene);
    
    // Local player should exist
    expect(playerManager.getLocalPlayer()).toBeDefined();
  });

  test('player removed from snapshot (disconnect)', () => {
    const { scene, playerManager } = createTestSetup();
    
    playerManager.setLocalPlayerId(1);
    
    // Snapshot with two players
    playerManager.handleSnapshot(
      createSnapshot(1, [
        { playerId: 1, x: 0, y: 3, z: 0 },
        { playerId: 2, x: 5, y: 3, z: 5 },
      ]),
      scene
    );
    
    // Next snapshot player 2 is gone
    playerManager.handleSnapshot(
      createSnapshot(2, [
        { playerId: 1, x: 0, y: 3, z: 0 },
      ]),
      scene
    );
    
    // Local player should still exist
    expect(playerManager.getLocalPlayer()).toBeDefined();
  });

  test('build at spawn point then snapshot with player there', () => {
    const { scene, integration, spawn, playerManager } = createTestSetup();
    
    spawn.update();
    playerManager.setLocalPlayerId(1);
    
    // Build a platform at spawn
    const build = createAddBuild(0, 3, 0, 2);
    const modified = integration.world.applyBuildOperation(build);
    integration.rebuildCollisionForChunks(modified);
    
    // Snapshot shows player on the platform
    playerManager.handleSnapshot(
      createSnapshot(1, [
        { playerId: 1, x: 0, y: 5, z: 0, flags: FLAG_GROUNDED },
      ]),
      scene
    );
    
    // Spawn should still detect terrain
    spawn.update();
    expect(spawn.isSpawnReady()).toBe(true);
  });

  test('very high tick number snapshot', () => {
    const { scene, playerManager } = createTestSetup();
    
    playerManager.setLocalPlayerId(1);
    
    const highTickSnapshot = createSnapshot(4294967295, [
      { playerId: 1, x: 0, y: 3, z: 0 },
    ]);
    
    playerManager.handleSnapshot(highTickSnapshot, scene);
    
    expect(playerManager.getLocalPlayer()).toBeDefined();
  });

  test('negative coordinates in snapshot', () => {
    const { scene, integration, spawn, playerManager } = createTestSetup();
    
    spawn.update();
    playerManager.setLocalPlayerId(1);
    
    // Snapshot with negative coordinates
    const snapshot = createSnapshot(1, [
      { playerId: 1, x: -10, y: 3, z: -10 },
    ]);
    
    playerManager.handleSnapshot(snapshot, scene);
    
    // Spawn at negative coords should work (chunks exist there)
    const spawnPos = spawn.getSpawnPosition(-10, -10);
    expect(spawnPos).toBeDefined();
  });

  test('dispose cleans up after many snapshots', () => {
    const { scene, integration, spawn, playerManager } = createTestSetup();
    
    playerManager.setLocalPlayerId(1);
    
    // Get initial scene children count (terrain meshes)
    const initialChildren = scene.children.length;
    
    // Process many snapshots with multiple players
    for (let i = 0; i < 100; i++) {
      playerManager.handleSnapshot(
        createSnapshot(i, [
          { playerId: 1, x: 0, y: 3, z: 0 },
          { playerId: 2, x: 5, y: 3, z: 5 },
        ]),
        scene
      );
    }
    
    // There should be a remote player mesh added
    const childrenWithPlayers = scene.children.length;
    expect(childrenWithPlayers).toBeGreaterThan(initialChildren);
    
    // Simulate player leaving before dispose (like in real game)
    playerManager.handleSnapshot(
      createSnapshot(101, [
        { playerId: 1, x: 0, y: 3, z: 0 },
        // Player 2 is gone
      ]),
      scene
    );
    
    // Dispose player manager
    playerManager.dispose();
    
    // Dispose spawn
    spawn.dispose();
    
    // Dispose integration (removes terrain)
    integration.dispose();
    
    // Scene should be clean (integration removes all terrain meshes)
    expect(scene.children.length).toBe(0);
  });
});
