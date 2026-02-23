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
import { worldToChunk, chunkKey, COLLIDER_CHUNK_RADIUS } from '@worldify/shared';

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

  /** Last known player chunk for collider proximity checks */
  private lastColliderPlayerChunk: { cx: number; cy: number; cz: number } | null = null;

  /** Chunk keys whose mesh was updated and may need a collider rebuild */
  private pendingColliderKeys: Set<string> = new Set();

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

    // Event-driven collision: queue key for deferred proximity-based rebuild
    this.world.addRemeshListener((key) => {
      this.pendingColliderKeys.add(key);
    });

    // Event-driven collision: remove collider when a chunk unloads
    this.world.addUnloadListener((key) => {
      if (this.colliderGenerations.has(key)) {
        this.collision.removeCollider(key);
        this.colliderGenerations.delete(key);
      }
    });
    
    // Update debug visualization if enabled
    if (this.config.debugEnabled) {
      this.debug.update(this.world.chunks, this.world.geometries, this.colliderGenerations);
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
    
    // Sync colliders: build nearby, remove distant
    this.syncColliders(playerPos);
    
    // Update debug visualization
    this.debug.update(this.world.chunks, this.world.geometries, this.colliderGenerations);
  }

  /**
   * Sync collision colliders based on player proximity.
   * - Builds BVH for chunks within COLLIDER_CHUNK_RADIUS that are pending or newly nearby.
   * - Removes colliders for chunks that are now too far away.
   * Only rescans the full set when the player crosses a chunk boundary.
   */
  private syncColliders(playerPos: THREE.Vector3): void {
    const pc = worldToChunk(playerPos.x, playerPos.y, playerPos.z);

    // Process any pending remesh keys that fall within range
    if (this.pendingColliderKeys.size > 0) {
      for (const key of this.pendingColliderKeys) {
        const chunk = this.world.chunks.get(key);
        if (!chunk) continue;
        if (Math.abs(chunk.cx - pc.cx) <= COLLIDER_CHUNK_RADIUS &&
            Math.abs(chunk.cy - pc.cy) <= COLLIDER_CHUNK_RADIUS &&
            Math.abs(chunk.cz - pc.cz) <= COLLIDER_CHUNK_RADIUS) {
          this.buildCollider(key, chunk.cx, chunk.cy, chunk.cz);
        } else if (this.colliderGenerations.has(key)) {
          this.collision.removeCollider(key);
          this.colliderGenerations.delete(key);
        }
      }
      this.pendingColliderKeys.clear();
    }

    // Full proximity rescan only when the player crosses a chunk boundary
    const prev = this.lastColliderPlayerChunk;
    if (prev && prev.cx === pc.cx && prev.cy === pc.cy && prev.cz === pc.cz) return;
    this.lastColliderPlayerChunk = { ...pc };

    // Build the set of desired chunk keys and ensure colliders are up-to-date
    const desiredKeys = new Set<string>();
    for (let dx = -COLLIDER_CHUNK_RADIUS; dx <= COLLIDER_CHUNK_RADIUS; dx++) {
      for (let dy = -COLLIDER_CHUNK_RADIUS; dy <= COLLIDER_CHUNK_RADIUS; dy++) {
        for (let dz = -COLLIDER_CHUNK_RADIUS; dz <= COLLIDER_CHUNK_RADIUS; dz++) {
          const k = chunkKey(pc.cx + dx, pc.cy + dy, pc.cz + dz);
          desiredKeys.add(k);
          const geo = this.world.geometries.get(k);
          if (!geo || !geo.hasGeometry()) continue;
          const gen = this.colliderGenerations.get(k);
          if (gen === undefined || gen !== geo.meshGeneration) {
            this.buildCollider(k, pc.cx + dx, pc.cy + dy, pc.cz + dz);
          }
        }
      }
    }

    // Remove colliders outside desired set (cheap Set.has lookup, no coord parsing)
    for (const key of this.colliderGenerations.keys()) {
      if (!desiredKeys.has(key)) {
        this.collision.removeCollider(key);
        this.colliderGenerations.delete(key);
      }
    }
  }

  /**
   * Build (or rebuild) a single collider from the chunk's current geometry.
   */
  private buildCollider(key: string, cx: number, cy: number, cz: number): void {
    const geo = this.world.geometries.get(key);
    if (!geo || !geo.hasGeometry()) return;
    const mesh = geo.getMesh();
    if (!mesh) return;

    if (this.colliderGenerations.has(key)) {
      this.collision.removeCollider(key);
    }
    this.collision.addCollider(key, cx, cy, cz, mesh);
    this.colliderGenerations.set(key, geo.meshGeneration);
  }

  /**
   * Rebuild collision for specific chunks after voxel modification.
   * Also called reactively via remesh listener.
   */
  rebuildCollisionForChunks(chunkKeys: string[]): void {
    for (const key of chunkKeys) {
      const chunk = this.world.chunks.get(key);
      if (!chunk) continue;
      const geo = this.world.geometries.get(key);
      if (!geo || !geo.hasGeometry()) continue;

      const mesh = geo.getMesh();
      if (!mesh) continue;

      // Remove old collider if exists
      if (this.colliderGenerations.has(key)) {
        this.collision.removeCollider(key);
        this.colliderGenerations.delete(key);
      }

      // Add new collider with updated geometry
      this.collision.addCollider(key, chunk.cx, chunk.cy, chunk.cz, mesh);
      this.colliderGenerations.set(key, geo.meshGeneration);
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
    for (const geo of this.world.geometries.values()) {
      if (geo.hasGeometry()) {
        const solid = geo.getMesh();
        if (solid) {
          meshes.push(solid);
        }
        if (geo.transparentMesh) {
          meshes.push(geo.transparentMesh);
        }
        if (geo.liquidMesh) {
          meshes.push(geo.liquidMesh);
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
    this.pendingColliderKeys.clear();
    this.lastColliderPlayerChunk = null;
    this.collision.dispose();
    
    // Refresh world — syncColliders will rebuild nearby colliders next frame
    this.world.refresh();
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
    this.pendingColliderKeys.clear();
    this.lastColliderPlayerChunk = null;
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
    this.pendingColliderKeys.clear();
    this.lastColliderPlayerChunk = null;
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
