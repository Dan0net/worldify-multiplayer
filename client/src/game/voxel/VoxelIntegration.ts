/**
 * VoxelIntegration - Ties together VoxelWorld, VoxelCollision, and VoxelDebug
 * 
 * This module provides a single entry point for the voxel terrain system,
 * managing initialization, updates, and cleanup.
 */

import * as THREE from 'three';
import { VOXEL_SCALE, INITIAL_TERRAIN_HEIGHT } from '@worldify/shared';
import { VoxelWorld } from './VoxelWorld.js';
import { VoxelCollision, CapsuleInfo, CapsuleCollisionResult } from './VoxelCollision.js';
import { VoxelDebugManager } from './VoxelDebug.js';

/**
 * Configuration for the voxel integration.
 */
export interface VoxelConfig {
  /** Whether to enable debug visualization */
  debugEnabled?: boolean;
  /** Whether to enable collision */
  collisionEnabled?: boolean;
  /** Initial player spawn height offset above terrain */
  spawnHeightOffset?: number;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<VoxelConfig> = {
  debugEnabled: false,
  collisionEnabled: true,
  spawnHeightOffset: 5.0, // 5 meters above terrain
};

/**
 * VoxelIntegration manages the voxel terrain system.
 * 
 * - Initializes VoxelWorld for chunk management
 * - Initializes VoxelCollision for physics (using three-mesh-bvh)
 * - Initializes VoxelDebug for visualization
 * - Syncs colliders when chunks are meshed
 * - Provides capsule collision for player physics
 */
export class VoxelIntegration {
  /** The voxel world manager */
  readonly world: VoxelWorld;
  
  /** The collision system */
  readonly collision: VoxelCollision;
  
  /** The debug visualization system */
  readonly debug: VoxelDebugManager;
  
  /** Configuration */
  private config: Required<VoxelConfig>;
  
  /** Whether the system has been initialized */
  private initialized = false;
  
  /** Track which chunks have colliders built */
  private colliderBuiltChunks: Set<string> = new Set();

  constructor(scene: THREE.Scene, config: VoxelConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Create subsystems
    this.world = new VoxelWorld(scene);
    this.collision = new VoxelCollision();
    this.collision.setScene(scene);
    this.debug = new VoxelDebugManager(scene);
  }

  /**
   * Initialize the voxel terrain system.
   * Creates initial chunks around the origin.
   */
  init(): void {
    if (this.initialized) return;
    
    // Initialize the world (generates initial chunks)
    this.world.init();
    
    // Build colliders for all initial chunk meshes
    this.syncColliders();
    
    // Update debug visualization if enabled
    if (this.config.debugEnabled) {
      this.debug.update(this.world.chunks, this.world.meshes);
      this.collision.setDebugEnabled(true);
    }
    
    this.initialized = true;
  }

  /**
   * Update the voxel system based on player position.
   * Should be called every frame.
   * 
   * @param playerPos Current player world position
   */
  update(playerPos: THREE.Vector3): void {
    if (!this.initialized) return;
    
    // Update world (handles chunk loading/unloading)
    this.world.update(playerPos);
    
    // Sync colliders for any new/updated chunks
    this.syncColliders();
    
    // Update debug visualization
    this.debug.update(this.world.chunks, this.world.meshes);
  }

  /**
   * Synchronize colliders with chunk meshes.
   * Adds colliders for new meshes, removes colliders for unloaded chunks.
   */
  private syncColliders(): void {
    // Build colliders for chunks that have meshes but no collider
    for (const [key, chunkMesh] of this.world.meshes) {
      if (!this.colliderBuiltChunks.has(key) && chunkMesh.hasGeometry()) {
        const mesh = chunkMesh.getMesh();
        if (mesh) {
          this.collision.addCollider(key, mesh);
          this.colliderBuiltChunks.add(key);
        }
      }
    }
    
    // Remove colliders for chunks that were unloaded
    const chunksToRemove: string[] = [];
    for (const key of this.colliderBuiltChunks) {
      if (!this.world.chunks.has(key)) {
        chunksToRemove.push(key);
      }
    }
    for (const key of chunksToRemove) {
      this.collision.removeCollider(key);
      this.colliderBuiltChunks.delete(key);
    }
  }

  /**
   * Get the spawn position for a player.
   * Returns a position above the terrain at the origin.
   * 
   * @param x World X coordinate (default 0)
   * @param z World Z coordinate (default 0)
   * @returns Spawn position with Y set above terrain
   */
  getSpawnPosition(x: number = 0, z: number = 0): THREE.Vector3 {
    const spawnPos = new THREE.Vector3(x, 0, z);
    
    // Use terrain height constant as fallback
    spawnPos.y = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE + this.config.spawnHeightOffset;
    
    return spawnPos;
  }

  /**
   * Resolve capsule collision against terrain.
   * This is the main collision method - uses three-mesh-bvh capsule collision.
   * 
   * @param capsuleInfo Capsule geometry (radius and segment)
   * @param position Current player position
   * @param velocity Current player velocity
   * @param delta Delta time for ground detection
   * @returns Collision result with push-out vector and ground state
   */
  resolveCapsuleCollision(
    capsuleInfo: CapsuleInfo,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    delta: number
  ): CapsuleCollisionResult {
    if (!this.config.collisionEnabled) {
      return {
        collided: false,
        deltaVector: new THREE.Vector3(0, 0, 0),
        isOnGround: false,
      };
    }
    return this.collision.resolveCapsuleCollision(capsuleInfo, position, velocity, delta);
  }

  /**
   * Enable or disable collision.
   */
  setCollisionEnabled(enabled: boolean): void {
    this.config.collisionEnabled = enabled;
  }

  /**
   * Enable or disable debug visualization.
   */
  setDebugEnabled(enabled: boolean): void {
    this.config.debugEnabled = enabled;
    this.collision.setDebugEnabled(enabled);
  }

  /**
   * Get statistics about the voxel system.
   */
  getStats() {
    const worldStats = this.world.getStats();
    return {
      ...worldStats,
      colliderCount: this.collision.getColliderCount(),
      triangleCount: this.collision.getTotalTriangleCount(),
      collisionEnabled: this.config.collisionEnabled,
      debugEnabled: this.config.debugEnabled,
    };
  }

  /**
   * Check if the system is initialized.
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Force refresh of all chunks.
   */
  refresh(): void {
    // Clear collider tracking
    this.colliderBuiltChunks.clear();
    this.collision.dispose();
    
    // Refresh world
    this.world.refresh();
    
    // Rebuild colliders
    this.syncColliders();
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    this.debug.dispose();
    this.collision.dispose();
    this.world.dispose();
    this.colliderBuiltChunks.clear();
    this.initialized = false;
  }
}

/**
 * Create a VoxelIntegration instance.
 * Convenience function for creating and initializing the voxel system.
 * 
 * @param scene The Three.js scene
 * @param config Optional configuration
 * @returns Initialized VoxelIntegration
 */
export function createVoxelIntegration(scene: THREE.Scene, config?: VoxelConfig): VoxelIntegration {
  const integration = new VoxelIntegration(scene, config);
  integration.init();
  return integration;
}
