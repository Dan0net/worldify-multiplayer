/**
 * TerrainRaycaster - Interface for terrain height queries
 * 
 * Decouples spawn/respawn logic from VoxelIntegration implementation.
 * Any system that can provide terrain height via raycast can implement this.
 */

import * as THREE from 'three';

/**
 * Interface for querying terrain height.
 * Implemented by VoxelIntegration to provide terrain collision data.
 */
export interface TerrainRaycaster {
  /**
   * Get all collision meshes for raycasting.
   * @returns Array of Three.js meshes
   */
  getCollisionMeshes(): THREE.Object3D[];
}
