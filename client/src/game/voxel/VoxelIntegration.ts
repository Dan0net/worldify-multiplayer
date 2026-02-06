/**
 * VoxelIntegration - Ties together VoxelWorld, VoxelCollision, and VoxelDebug
 * 
 * This module provides a single entry point for the voxel terrain system,
 * managing initialization, updates, and cleanup.
 * 
 * Implements TerrainRaycaster interface for SpawnManager to use.
 */

import * as THREE from 'three';
import { VoxelWorld } from './VoxelWorld.js';
import { VoxelCollision, CapsuleInfo, CapsuleCollisionResult } from './VoxelCollision.js';
import { VoxelDebugManager } from './VoxelDebug.js';
import type { TerrainRaycaster } from '../spawn/TerrainRaycaster.js';

/**
 * Configuration for the voxel integration.
 */
export interface VoxelConfig {
  /** Whether to enable debug visualization */
  debugEnabled?: boolean;
  /** Whether to enable collision */
  collisionEnabled?: boolean;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: Required<VoxelConfig> = {
  debugEnabled: false,
  collisionEnabled: true,
};

/**
 * VoxelIntegration manages the voxel terrain system.
 * 
 * - Initializes VoxelWorld for chunk management
 * - Initializes VoxelCollision for physics (using three-mesh-bvh)
 * - Initializes VoxelDebug for visualization
 * - Syncs colliders when chunks are meshed
 * - Implements TerrainRaycaster for spawn system
 * - Provides capsule collision for player physics
 */
export class VoxelIntegration implements TerrainRaycaster {
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
  
  /** Track which chunks have colliders built and their mesh generation */
  private colliderGenerations: Map<string, number> = new Map();

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

    // Rebuild collision BVH whenever a chunk is remeshed by a worker.
    // This ensures collision always matches the actual rendered geometry.
    this.world.onChunkRemeshed = (key) => {
      this.rebuildCollisionForChunks([key]);
    };
    
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
   * Set the camera for visibility-based chunk loading.
   * Must be called before chunks will load in server mode.
   */
  setCamera(camera: THREE.Camera): void {
    this.world.setCamera(camera);
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
   * Adds colliders for new meshes, updates when geometry changes, removes for unloaded chunks.
   */
  private syncColliders(): void {
    // Build or update colliders for chunks that have meshes
    for (const [key, chunkMesh] of this.world.meshes) {
      if (!chunkMesh.hasGeometry()) continue;
      
      const mesh = chunkMesh.getMesh();
      if (!mesh) continue;
      
      const currentGeneration = chunkMesh.meshGeneration;
      const storedGeneration = this.colliderGenerations.get(key);
      
      // Skip if collider exists and mesh hasn't changed
      if (storedGeneration === currentGeneration) continue;
      
      // Remove old collider if it exists (mesh was regenerated)
      if (storedGeneration !== undefined) {
        this.collision.removeCollider(key);
      }
      
      // Add new collider with current geometry
      this.collision.addCollider(key, mesh);
      this.colliderGenerations.set(key, currentGeneration);
    }
    
    // Remove colliders for chunks that were unloaded
    const chunksToRemove: string[] = [];
    for (const key of this.colliderGenerations.keys()) {
      if (!this.world.chunks.has(key)) {
        chunksToRemove.push(key);
      }
    }
    for (const key of chunksToRemove) {
      this.collision.removeCollider(key);
      this.colliderGenerations.delete(key);
    }
  }

  /**
   * Rebuild collision for specific chunks after voxel modification.
   * Call this after committing a build operation.
   * 
   * @param chunkKeys Array of chunk keys to rebuild collision for
   */
  rebuildCollisionForChunks(chunkKeys: string[]): void {
    for (const key of chunkKeys) {
      const chunkMesh = this.world.meshes.get(key);
      if (!chunkMesh || !chunkMesh.hasGeometry()) continue;

      const mesh = chunkMesh.getMesh();
      if (!mesh) continue;

      // Remove old collider if exists
      if (this.colliderGenerations.has(key)) {
        this.collision.removeCollider(key);
        this.colliderGenerations.delete(key);
      }

      // Add new collider with updated geometry
      this.collision.addCollider(key, mesh);
      this.colliderGenerations.set(key, chunkMesh.meshGeneration);
    }
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
   * Get all collision meshes for raycasting.
   * Returns an array of Three.js meshes that can be used with Raycaster.
   */
  getCollisionMeshes(): THREE.Object3D[] {
    const meshes: THREE.Object3D[] = [];
    for (const chunkMesh of this.world.meshes.values()) {
      if (chunkMesh.hasGeometry()) {
        const mesh = chunkMesh.getMesh();
        if (mesh) {
          meshes.push(mesh);
        }
      }
    }
    return meshes;
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
    this.colliderGenerations.clear();
    this.collision.dispose();
    
    // Refresh world
    this.world.refresh();
    
    // Rebuild colliders
    this.syncColliders();
  }

  /**
   * Clear all chunks and reload from server.
   * Used for dev/debug to force fresh chunk generation.
   * @param playerPos Current player position (to reload chunks around)
   */
  clearAndReload(playerPos?: THREE.Vector3): void {
    console.log('[VoxelIntegration] Clearing and reloading all chunks...');
    
    // Clear colliders
    this.colliderGenerations.clear();
    this.collision.dispose();
    
    // Clear and reload world
    this.world.clearAndReload(playerPos);
    
    // Debug will auto-update on next frame
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    this.debug.dispose();
    this.collision.dispose();
    this.world.dispose();
    this.colliderGenerations.clear();
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
