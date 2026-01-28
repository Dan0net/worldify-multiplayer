/**
 * VoxelIntegration - Ties together VoxelWorld, VoxelCollision, and VoxelDebug
 * 
 * This module provides a single entry point for the voxel terrain system,
 * managing initialization, updates, and cleanup.
 */

import * as THREE from 'three';
import { VOXEL_SCALE, INITIAL_TERRAIN_HEIGHT } from '@worldify/shared';
import { VoxelWorld } from './VoxelWorld.js';
import { VoxelCollision } from './VoxelCollision.js';
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
  spawnHeightOffset: 2.0, // 2 meters above terrain
};

/**
 * VoxelIntegration manages the voxel terrain system.
 * 
 * - Initializes VoxelWorld for chunk management
 * - Initializes VoxelCollision for physics
 * - Initializes VoxelDebug for visualization
 * - Syncs BVH data when chunks are meshed
 * - Provides ground detection for player spawning
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
  
  /** Track which chunks have BVHs built */
  private bvhBuiltChunks: Set<string> = new Set();

  constructor(scene: THREE.Scene, config: VoxelConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    
    // Create subsystems
    this.world = new VoxelWorld(scene);
    this.collision = new VoxelCollision();
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
    
    // Build BVHs for all initial chunk meshes
    this.syncBVHs();
    
    // Update debug visualization if enabled
    if (this.config.debugEnabled) {
      this.debug.update(this.world.chunks, this.world.meshes);
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
    
    // Sync BVHs for any new/updated chunks
    this.syncBVHs();
    
    // Update debug visualization
    this.debug.update(this.world.chunks, this.world.meshes);
  }

  /**
   * Synchronize BVHs with chunk meshes.
   * Builds BVHs for new meshes, removes BVHs for unloaded chunks.
   */
  private syncBVHs(): void {
    // Build BVHs for chunks that have meshes but no BVH
    for (const [key, chunkMesh] of this.world.meshes) {
      if (!this.bvhBuiltChunks.has(key) && chunkMesh.hasGeometry()) {
        const mesh = chunkMesh.getMesh();
        if (mesh) {
          this.collision.buildBVH(key, mesh);
          this.bvhBuiltChunks.add(key);
        }
      }
    }
    
    // Remove BVHs for chunks that were unloaded
    const chunksToRemove: string[] = [];
    for (const key of this.bvhBuiltChunks) {
      if (!this.world.chunks.has(key)) {
        chunksToRemove.push(key);
      }
    }
    for (const key of chunksToRemove) {
      this.collision.removeBVH(key);
      this.bvhBuiltChunks.delete(key);
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
    
    // Try to find ground height using collision raycast
    const groundY = this.collision.getGroundHeight(
      new THREE.Vector3(x, 100, z), // Start high
      200 // Max distance
    );
    
    if (groundY !== null) {
      spawnPos.y = groundY + this.config.spawnHeightOffset;
    } else {
      // Fallback: use terrain height constant
      spawnPos.y = INITIAL_TERRAIN_HEIGHT * VOXEL_SCALE + this.config.spawnHeightOffset;
    }
    
    return spawnPos;
  }

  /**
   * Get the ground height at a world position.
   * Uses collision raycast for accuracy.
   * 
   * @param x World X coordinate
   * @param z World Z coordinate
   * @returns Ground Y coordinate, or null if no ground found
   */
  getGroundHeight(x: number, z: number): number | null {
    return this.collision.getGroundHeight(
      new THREE.Vector3(x, 100, z),
      200
    );
  }

  /**
   * Raycast against terrain.
   * 
   * @param origin Ray origin
   * @param direction Normalized direction
   * @param maxDist Maximum distance
   * @returns Hit result or null
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDist: number) {
    return this.collision.raycast(origin, direction, maxDist);
  }

  /**
   * Check sphere collision with terrain.
   * 
   * @param center Sphere center
   * @param radius Sphere radius
   * @returns Collision result or null
   */
  sphereCollide(center: THREE.Vector3, radius: number) {
    if (!this.config.collisionEnabled) return null;
    return this.collision.sphereCollide(center, radius);
  }

  /**
   * Resolve capsule collision for player physics.
   * Returns push-out vector to move player out of terrain.
   * 
   * @param feetPos Player feet position
   * @param headPos Player head position
   * @param radius Player capsule radius
   * @returns Push-out vector
   */
  resolveCapsuleCollision(feetPos: THREE.Vector3, headPos: THREE.Vector3, radius: number): THREE.Vector3 {
    if (!this.config.collisionEnabled) {
      return new THREE.Vector3(0, 0, 0);
    }
    return this.collision.resolveCapsuleCollision(feetPos, headPos, radius);
  }

  /**
   * Check if a point is inside solid terrain.
   */
  isPointInsideTerrain(point: THREE.Vector3): boolean {
    return this.collision.isPointInsideTerrain(point);
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
  }

  /**
   * Get statistics about the voxel system.
   */
  getStats() {
    const worldStats = this.world.getStats();
    return {
      ...worldStats,
      bvhCount: this.collision.getBVHCount(),
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
    // Clear BVH tracking
    this.bvhBuiltChunks.clear();
    this.collision.dispose();
    
    // Refresh world
    this.world.refresh();
    
    // Rebuild BVHs
    this.syncBVHs();
  }

  /**
   * Dispose of all resources.
   */
  dispose(): void {
    this.debug.dispose();
    this.collision.dispose();
    this.world.dispose();
    this.bvhBuiltChunks.clear();
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
