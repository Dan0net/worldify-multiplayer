/**
 * VoxelCollision - Collision detection for voxel terrain using three-mesh-bvh
 * 
 * Uses the three-mesh-bvh library for efficient capsule-based collision detection,
 * similar to worldify-app's Player.ts implementation.
 */

import * as THREE from 'three';
import { 
  MeshBVHHelper,
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast 
} from 'three-mesh-bvh';
import { CHUNK_WORLD_SIZE, COLLISION_CHUNK_RADIUS } from '@worldify/shared';

// Add BVH methods to THREE.BufferGeometry prototype
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

// ============== Types ==============

/** Result of a capsule collision */
export interface CapsuleCollisionResult {
  /** Whether collision occurred */
  collided: boolean;
  /** Push-out vector to resolve collision */
  deltaVector: THREE.Vector3;
  /** Whether player is on ground */
  isOnGround: boolean;
}

/** Capsule geometry info */
export interface CapsuleInfo {
  radius: number;
  segment: THREE.Line3;
}

/** Cached collider entry: mesh + chunk coordinates to avoid parsing keys per frame */
interface ColliderEntry {
  mesh: THREE.Mesh;
  cx: number;
  cy: number;
  cz: number;
}

// ============== VoxelCollision Class ==============

/**
 * Main collision system for the voxel world.
 * Uses three-mesh-bvh for efficient collision detection with capsule geometry.
 */
export class VoxelCollision {
  /** Collider entries keyed by chunk key (mesh + cached chunk coords) */
  private colliders: Map<string, ColliderEntry> = new Map();
  
  /** BVH helpers for debug visualization */
  private bvhHelpers: Map<string, MeshBVHHelper> = new Map();
  
  /** Parent scene for debug helpers */
  private scene: THREE.Scene | null = null;
  
  /** Whether debug visualization is enabled */
  private debugEnabled = false;

  /** Temporary vectors for collision calculations */
  private tempVector = new THREE.Vector3();
  private tempVector2 = new THREE.Vector3();
  private tempBox = new THREE.Box3();
  private tempMat = new THREE.Matrix4();
  private tempSegment = new THREE.Line3();

  /**
   * Set the scene for debug visualization
   */
  setScene(scene: THREE.Scene): void {
    this.scene = scene;
  }

  /**
   * Add or update a collider mesh for a chunk.
   * The mesh's geometry will have its BVH computed.
   */
  addCollider(key: string, cx: number, cy: number, cz: number, mesh: THREE.Mesh): void {
    // Remove existing collider if present
    if (this.colliders.has(key)) {
      this.removeCollider(key);
    }

    if (!mesh.geometry || !mesh.geometry.attributes.position || 
        mesh.geometry.attributes.position.count === 0) {
      return;
    }

    // Compute BVH for the mesh geometry
    if (!mesh.geometry.boundsTree) {
      mesh.geometry.computeBoundsTree();
    }

    this.colliders.set(key, { mesh, cx, cy, cz });

    // Create debug helper if enabled
    if (this.debugEnabled && this.scene) {
      const helper = new MeshBVHHelper(mesh, 10);
      helper.visible = true;
      this.bvhHelpers.set(key, helper);
      this.scene.add(helper);
    }
  }

  /**
   * Remove collider for a chunk.
   */
  removeCollider(key: string): void {
    const entry = this.colliders.get(key);
    if (entry && entry.mesh.geometry.boundsTree) {
      entry.mesh.geometry.disposeBoundsTree();
    }
    this.colliders.delete(key);

    // Remove debug helper
    const helper = this.bvhHelpers.get(key);
    if (helper && this.scene) {
      this.scene.remove(helper);
    }
    this.bvhHelpers.delete(key);
  }

  /**
   * Set debug visualization enabled/disabled
   */
  setDebugEnabled(enabled: boolean): void {
    this.debugEnabled = enabled;

    if (enabled && this.scene) {
      // Create helpers for existing colliders
      for (const [key, { mesh }] of this.colliders) {
        if (!this.bvhHelpers.has(key)) {
          const helper = new MeshBVHHelper(mesh, 10);
          helper.visible = true;
          this.bvhHelpers.set(key, helper);
          this.scene.add(helper);
        }
      }
    } else if (this.scene) {
      // Remove all helpers
      for (const [, helper] of this.bvhHelpers) {
        this.scene.remove(helper);
      }
      this.bvhHelpers.clear();
    }
  }

  /**
   * Resolve capsule collision against all terrain.
   * Based on worldify-app's Player.ts collisionUpdate implementation.
   * 
   * @param capsuleInfo Capsule geometry (radius and segment from feet to head)
   * @param position Current position (origin of capsule segment)
   * @param velocity Current velocity (for ground detection)
   * @param delta Delta time for ground detection threshold
   * @returns Collision result with push-out vector and ground state
   */
  resolveCapsuleCollision(
    capsuleInfo: CapsuleInfo,
    position: THREE.Vector3,
    velocity: THREE.Vector3,
    delta: number
  ): CapsuleCollisionResult {
    // Accumulate total delta across all colliders
    const totalDelta = new THREE.Vector3();
    // Working position that gets updated after each collider
    const workingPosition = position.clone();

    // Compute player chunk coords for distance filtering
    const pcx = Math.floor(position.x / CHUNK_WORLD_SIZE);
    const pcy = Math.floor(position.y / CHUNK_WORLD_SIZE);
    const pcz = Math.floor(position.z / CHUNK_WORLD_SIZE);

    for (const { mesh: collider, cx, cy, cz } of this.colliders.values()) {
      if (!collider?.matrixWorld || !collider.geometry?.boundsTree) continue;

      // Skip colliders far from the player (Chebyshev distance in chunk coords)
      if (Math.abs(cx - pcx) > COLLISION_CHUNK_RADIUS ||
          Math.abs(cy - pcy) > COLLISION_CHUNK_RADIUS ||
          Math.abs(cz - pcz) > COLLISION_CHUNK_RADIUS) {
        continue;
      }

      // Reset temp objects
      this.tempBox.makeEmpty();
      this.tempSegment.copy(capsuleInfo.segment);
      this.tempMat.copy(collider.matrixWorld).invert();

      // Transform capsule segment to collider's local space
      // Use workingPosition which includes adjustments from previous colliders
      this.tempSegment.start.add(workingPosition).applyMatrix4(this.tempMat);
      this.tempSegment.end.add(workingPosition).applyMatrix4(this.tempMat);

      // Get AABB of the capsule
      this.tempBox.expandByPoint(this.tempSegment.start);
      this.tempBox.expandByPoint(this.tempSegment.end);
      this.tempBox.min.addScalar(-capsuleInfo.radius);
      this.tempBox.max.addScalar(capsuleInfo.radius);

      // Use BVH shapecast for efficient collision detection
      collider.geometry.boundsTree.shapecast({
        intersectsBounds: (box) => box.intersectsBox(this.tempBox),

        intersectsTriangle: (tri) => {
          // Find closest points between triangle and capsule segment
          const triPoint = this.tempVector;
          const capsulePoint = this.tempVector2;

          const distance = tri.closestPointToSegment(
            this.tempSegment,
            triPoint,
            capsulePoint
          );

          if (distance < capsuleInfo.radius) {
            const depth = capsuleInfo.radius - distance;
            const direction = capsulePoint.sub(triPoint).normalize();

            // For ground collisions (mostly vertical), snap to pure vertical
            if (direction.y > 0.5) {
              direction.y = 1;
              direction.x = 0;
              direction.z = 0;
            }

            this.tempSegment.start.addScaledVector(direction, depth);
            this.tempSegment.end.addScaledVector(direction, depth);
          }
        },
      });

      // Get adjusted position back in world space
      const newPosition = this.tempVector;
      newPosition.copy(this.tempSegment.start).applyMatrix4(collider.matrixWorld);

      // Calculate delta from working position (not original position)
      const deltaVector = this.tempVector2;
      deltaVector.subVectors(newPosition, workingPosition);

      // Add offset to capsule segment start
      deltaVector.sub(capsuleInfo.segment.start);

      const offset = Math.max(0.0, deltaVector.length() - 1e-5);
      deltaVector.normalize().multiplyScalar(offset);

      // Accumulate this collider's delta
      if (deltaVector.lengthSq() > 0) {
        totalDelta.add(deltaVector);
        // Update working position for next collider
        workingPosition.add(deltaVector);
      }
    }

    // Check if on ground based on vertical push-out vs velocity
    const isOnGround = totalDelta.y > Math.abs(delta * velocity.y * 0.25);

    return {
      collided: totalDelta.lengthSq() > 0,
      deltaVector: totalDelta,
      isOnGround,
    };
  }

  /**
   * Get number of loaded colliders
   */
  getColliderCount(): number {
    return this.colliders.size;
  }

  /**
   * Get total triangle count across all colliders
   */
  getTotalTriangleCount(): number {
    let count = 0;
    for (const { mesh } of this.colliders.values()) {
      const index = mesh.geometry.getIndex();
      if (index) {
        count += index.count / 3;
      }
    }
    return count;
  }

  /**
   * Clear all colliders
   */
  dispose(): void {
    for (const key of [...this.colliders.keys()]) {
      this.removeCollider(key);
    }
  }
}
