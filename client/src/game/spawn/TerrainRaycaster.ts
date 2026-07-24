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
   * Get all collision meshes for raycasting (solid + transparent + liquid).
   * @returns Array of Three.js meshes
   */
  getCollisionMeshes(): THREE.Object3D[];

  /**
   * Get only the solid (collidable) meshes — excludes transparent foliage + liquid.
   * @returns Array of Three.js meshes
   */
  getSolidMeshes(): THREE.Object3D[];

  /**
   * Solid raycast meshes grouped by LOD level, each with its scale (2^level). Explore renders the base
   * disk and coarse rings at different scales, so a marker/spawn raycast must test each level in its own
   * scaled space. Entry 0 is the base level. Optional — implementations without LOD may omit it.
   */
  getSolidMeshesByLevel?(): { scale: number; meshes: THREE.Object3D[] }[];
}
