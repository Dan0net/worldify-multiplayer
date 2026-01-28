/**
 * VoxelCollision - Collision detection for voxel terrain
 * 
 * Provides raycast and geometric collision queries against chunk meshes.
 * Uses a simple BVH (Bounding Volume Hierarchy) for spatial acceleration.
 */

import * as THREE from 'three';
import { CHUNK_WORLD_SIZE, VOXEL_SCALE, worldToChunk, chunkKey } from '@worldify/shared';
import { Chunk } from './Chunk.js';
import { ChunkMesh } from './ChunkMesh.js';

// ============== Types ==============

/** Result of a raycast hit */
export interface RaycastHit {
  /** Hit position in world coordinates */
  point: THREE.Vector3;
  /** Surface normal at hit point */
  normal: THREE.Vector3;
  /** Distance from ray origin to hit */
  distance: number;
  /** Chunk key where hit occurred */
  chunkKey: string;
  /** Triangle index that was hit */
  triangleIndex: number;
}

/** Result of a collision query */
export interface CollisionResult {
  /** Whether collision occurred */
  collided: boolean;
  /** Penetration depth (how far inside the surface) */
  penetrationDepth: number;
  /** Normal pointing away from surface (direction to push out) */
  normal: THREE.Vector3;
  /** Contact point on the surface */
  contactPoint: THREE.Vector3;
}

/** Simple AABB (Axis-Aligned Bounding Box) */
export interface AABB {
  min: THREE.Vector3;
  max: THREE.Vector3;
}

/** Triangle data for collision */
export interface Triangle {
  v0: THREE.Vector3;
  v1: THREE.Vector3;
  v2: THREE.Vector3;
  normal: THREE.Vector3;
}

/** BVH node for spatial acceleration */
export interface BVHNode {
  bounds: AABB;
  triangles: Triangle[] | null; // Leaf nodes have triangles
  left: BVHNode | null;
  right: BVHNode | null;
}

// ============== Constants ==============

/** Maximum triangles per BVH leaf node */
const MAX_TRIANGLES_PER_LEAF = 8;

/** Small epsilon for floating point comparisons */
const EPSILON = 1e-6;

// ============== Helper Functions ==============

/**
 * Create an empty AABB.
 */
export function createEmptyAABB(): AABB {
  return {
    min: new THREE.Vector3(Infinity, Infinity, Infinity),
    max: new THREE.Vector3(-Infinity, -Infinity, -Infinity),
  };
}

/**
 * Expand AABB to include a point.
 */
export function expandAABB(aabb: AABB, point: THREE.Vector3): void {
  aabb.min.min(point);
  aabb.max.max(point);
}

/**
 * Expand AABB to include another AABB.
 */
export function mergeAABB(a: AABB, b: AABB): AABB {
  return {
    min: new THREE.Vector3().copy(a.min).min(b.min),
    max: new THREE.Vector3().copy(a.max).max(b.max),
  };
}

/**
 * Compute AABB for a triangle.
 */
export function triangleAABB(tri: Triangle): AABB {
  const aabb = createEmptyAABB();
  expandAABB(aabb, tri.v0);
  expandAABB(aabb, tri.v1);
  expandAABB(aabb, tri.v2);
  return aabb;
}

/**
 * Check if a ray intersects an AABB.
 */
export function rayIntersectsAABB(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  aabb: AABB,
  maxDist: number
): boolean {
  let tmin = 0;
  let tmax = maxDist;

  for (let i = 0; i < 3; i++) {
    const axis = ['x', 'y', 'z'][i] as 'x' | 'y' | 'z';
    const invD = 1 / direction[axis];
    let t0 = (aabb.min[axis] - origin[axis]) * invD;
    let t1 = (aabb.max[axis] - origin[axis]) * invD;

    if (invD < 0) {
      [t0, t1] = [t1, t0];
    }

    tmin = Math.max(tmin, t0);
    tmax = Math.min(tmax, t1);

    if (tmax < tmin) return false;
  }

  return true;
}

/**
 * Check if a sphere intersects an AABB.
 */
export function sphereIntersectsAABB(center: THREE.Vector3, radius: number, aabb: AABB): boolean {
  // Find closest point on AABB to sphere center
  const closest = new THREE.Vector3(
    Math.max(aabb.min.x, Math.min(center.x, aabb.max.x)),
    Math.max(aabb.min.y, Math.min(center.y, aabb.max.y)),
    Math.max(aabb.min.z, Math.min(center.z, aabb.max.z))
  );

  const distSq = center.distanceToSquared(closest);
  return distSq <= radius * radius;
}

/**
 * Ray-triangle intersection using Möller–Trumbore algorithm.
 * @returns Distance to intersection, or null if no hit
 */
export function rayTriangleIntersect(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  tri: Triangle
): number | null {
  const edge1 = new THREE.Vector3().subVectors(tri.v1, tri.v0);
  const edge2 = new THREE.Vector3().subVectors(tri.v2, tri.v0);
  const h = new THREE.Vector3().crossVectors(direction, edge2);
  const a = edge1.dot(h);

  if (Math.abs(a) < EPSILON) return null; // Ray parallel to triangle

  const f = 1 / a;
  const s = new THREE.Vector3().subVectors(origin, tri.v0);
  const u = f * s.dot(h);

  if (u < 0 || u > 1) return null;

  const q = new THREE.Vector3().crossVectors(s, edge1);
  const v = f * direction.dot(q);

  if (v < 0 || u + v > 1) return null;

  const t = f * edge2.dot(q);

  if (t > EPSILON) return t;
  return null;
}

/**
 * Find closest point on a triangle to a given point.
 */
export function closestPointOnTriangle(point: THREE.Vector3, tri: Triangle): THREE.Vector3 {
  const ab = new THREE.Vector3().subVectors(tri.v1, tri.v0);
  const ac = new THREE.Vector3().subVectors(tri.v2, tri.v0);
  const ap = new THREE.Vector3().subVectors(point, tri.v0);

  const d1 = ab.dot(ap);
  const d2 = ac.dot(ap);
  if (d1 <= 0 && d2 <= 0) return tri.v0.clone();

  const bp = new THREE.Vector3().subVectors(point, tri.v1);
  const d3 = ab.dot(bp);
  const d4 = ac.dot(bp);
  if (d3 >= 0 && d4 <= d3) return tri.v1.clone();

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return new THREE.Vector3().copy(tri.v0).addScaledVector(ab, v);
  }

  const cp = new THREE.Vector3().subVectors(point, tri.v2);
  const d5 = ab.dot(cp);
  const d6 = ac.dot(cp);
  if (d6 >= 0 && d5 <= d6) return tri.v2.clone();

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return new THREE.Vector3().copy(tri.v0).addScaledVector(ac, w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return new THREE.Vector3().subVectors(tri.v2, tri.v1).multiplyScalar(w).add(tri.v1);
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return new THREE.Vector3().copy(tri.v0).addScaledVector(ab, v).addScaledVector(ac, w);
}

/**
 * Check sphere-triangle collision.
 */
export function sphereTriangleCollision(
  center: THREE.Vector3,
  radius: number,
  tri: Triangle
): CollisionResult | null {
  const closest = closestPointOnTriangle(center, tri);
  const diff = new THREE.Vector3().subVectors(center, closest);
  const distSq = diff.lengthSq();

  if (distSq > radius * radius) return null;

  const dist = Math.sqrt(distSq);
  const penetration = radius - dist;

  // Normal pointing away from surface
  let normal: THREE.Vector3;
  if (dist > EPSILON) {
    normal = diff.divideScalar(dist);
  } else {
    // Point is exactly on triangle - use triangle normal
    normal = tri.normal.clone();
  }

  return {
    collided: true,
    penetrationDepth: penetration,
    normal,
    contactPoint: closest,
  };
}

// ============== BVH Building ==============

/**
 * Build BVH from triangles.
 */
export function buildBVH(triangles: Triangle[]): BVHNode | null {
  if (triangles.length === 0) return null;

  // Compute bounds for all triangles
  const bounds = createEmptyAABB();
  for (const tri of triangles) {
    expandAABB(bounds, tri.v0);
    expandAABB(bounds, tri.v1);
    expandAABB(bounds, tri.v2);
  }

  // Leaf node if few triangles
  if (triangles.length <= MAX_TRIANGLES_PER_LEAF) {
    return { bounds, triangles, left: null, right: null };
  }

  // Find longest axis to split
  const size = new THREE.Vector3().subVectors(bounds.max, bounds.min);
  let axis: 'x' | 'y' | 'z' = 'x';
  if (size.y > size.x && size.y > size.z) axis = 'y';
  else if (size.z > size.x && size.z > size.y) axis = 'z';

  // Compute centroids and sort
  const centroidAxis = triangles.map((tri) => {
    const centroid = new THREE.Vector3().addVectors(tri.v0, tri.v1).add(tri.v2).divideScalar(3);
    return centroid[axis];
  });

  // Sort triangles by centroid
  const sorted = triangles
    .map((tri, i) => ({ tri, centroid: centroidAxis[i] }))
    .sort((a, b) => a.centroid - b.centroid)
    .map((item) => item.tri);

  // Split in half
  const mid = Math.floor(sorted.length / 2);
  const leftTris = sorted.slice(0, mid);
  const rightTris = sorted.slice(mid);

  return {
    bounds,
    triangles: null,
    left: buildBVH(leftTris),
    right: buildBVH(rightTris),
  };
}

/**
 * Extract triangles from a Three.js mesh geometry (in world coordinates).
 */
export function extractTrianglesFromMesh(mesh: THREE.Mesh): Triangle[] {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const index = geometry.getIndex();

  if (!position || !index) return [];

  const triangles: Triangle[] = [];
  const worldMatrix = mesh.matrixWorld;

  for (let i = 0; i < index.count; i += 3) {
    const i0 = index.getX(i);
    const i1 = index.getX(i + 1);
    const i2 = index.getX(i + 2);

    const v0 = new THREE.Vector3(
      position.getX(i0),
      position.getY(i0),
      position.getZ(i0)
    ).applyMatrix4(worldMatrix);

    const v1 = new THREE.Vector3(
      position.getX(i1),
      position.getY(i1),
      position.getZ(i1)
    ).applyMatrix4(worldMatrix);

    const v2 = new THREE.Vector3(
      position.getX(i2),
      position.getY(i2),
      position.getZ(i2)
    ).applyMatrix4(worldMatrix);

    // Compute face normal
    const edge1 = new THREE.Vector3().subVectors(v1, v0);
    const edge2 = new THREE.Vector3().subVectors(v2, v0);
    const faceNormal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();

    triangles.push({ v0, v1, v2, normal: faceNormal });
  }

  return triangles;
}

// ============== ChunkBVH Class ==============

/**
 * BVH for a single chunk's collision geometry.
 */
export class ChunkBVH {
  readonly chunkKey: string;
  readonly root: BVHNode | null;
  readonly triangleCount: number;

  constructor(chunkKey: string, mesh: THREE.Mesh | null) {
    this.chunkKey = chunkKey;

    if (!mesh) {
      this.root = null;
      this.triangleCount = 0;
      return;
    }

    const triangles = extractTrianglesFromMesh(mesh);
    this.root = buildBVH(triangles);
    this.triangleCount = triangles.length;
  }

  /**
   * Raycast against this chunk's BVH.
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDist: number): RaycastHit | null {
    if (!this.root) return null;

    let closestHit: RaycastHit | null = null;
    let closestDist = maxDist;

    const stack: BVHNode[] = [this.root];
    let triangleIndex = 0;

    while (stack.length > 0) {
      const node = stack.pop()!;

      // Skip if ray doesn't intersect bounds
      if (!rayIntersectsAABB(origin, direction, node.bounds, closestDist)) {
        continue;
      }

      // Leaf node - test triangles
      if (node.triangles) {
        for (const tri of node.triangles) {
          const t = rayTriangleIntersect(origin, direction, tri);
          if (t !== null && t < closestDist) {
            closestDist = t;
            closestHit = {
              point: new THREE.Vector3().copy(origin).addScaledVector(direction, t),
              normal: tri.normal.clone(),
              distance: t,
              chunkKey: this.chunkKey,
              triangleIndex,
            };
          }
          triangleIndex++;
        }
      } else {
        // Internal node - push children
        if (node.left) stack.push(node.left);
        if (node.right) stack.push(node.right);
      }
    }

    return closestHit;
  }

  /**
   * Sphere collision against this chunk's BVH.
   */
  sphereCollide(center: THREE.Vector3, radius: number): CollisionResult | null {
    if (!this.root) return null;

    let deepestCollision: CollisionResult | null = null;
    let maxPenetration = 0;

    const stack: BVHNode[] = [this.root];

    while (stack.length > 0) {
      const node = stack.pop()!;

      // Skip if sphere doesn't intersect bounds
      if (!sphereIntersectsAABB(center, radius, node.bounds)) {
        continue;
      }

      // Leaf node - test triangles
      if (node.triangles) {
        for (const tri of node.triangles) {
          const result = sphereTriangleCollision(center, radius, tri);
          if (result && result.penetrationDepth > maxPenetration) {
            maxPenetration = result.penetrationDepth;
            deepestCollision = result;
          }
        }
      } else {
        // Internal node - push children
        if (node.left) stack.push(node.left);
        if (node.right) stack.push(node.right);
      }
    }

    return deepestCollision;
  }
}

// ============== VoxelCollision Class ==============

/**
 * Main collision system for the voxel world.
 * Manages BVHs for all chunks and provides world-level queries.
 */
export class VoxelCollision {
  /** BVHs for each chunk, keyed by chunk key */
  private bvhs: Map<string, ChunkBVH> = new Map();

  /**
   * Build or rebuild BVH for a chunk.
   */
  buildBVH(chunkKey: string, mesh: THREE.Mesh | null): void {
    const bvh = new ChunkBVH(chunkKey, mesh);
    this.bvhs.set(chunkKey, bvh);
  }

  /**
   * Remove BVH for a chunk.
   */
  removeBVH(chunkKey: string): void {
    this.bvhs.delete(chunkKey);
  }

  /**
   * Get chunk keys that might intersect with a sphere.
   */
  private getRelevantChunks(center: THREE.Vector3, radius: number): string[] {
    const keys: string[] = [];

    // Get chunk bounds that the sphere could touch
    const minChunk = worldToChunk(
      center.x - radius,
      center.y - radius,
      center.z - radius
    );
    const maxChunk = worldToChunk(
      center.x + radius,
      center.y + radius,
      center.z + radius
    );

    for (let cz = minChunk.cz; cz <= maxChunk.cz; cz++) {
      for (let cy = minChunk.cy; cy <= maxChunk.cy; cy++) {
        for (let cx = minChunk.cx; cx <= maxChunk.cx; cx++) {
          const key = chunkKey(cx, cy, cz);
          if (this.bvhs.has(key)) {
            keys.push(key);
          }
        }
      }
    }

    return keys;
  }

  /**
   * Raycast against all loaded chunks.
   * @param origin Ray origin in world coordinates
   * @param direction Normalized ray direction
   * @param maxDist Maximum distance to check
   * @returns Closest hit, or null if no hit
   */
  raycast(origin: THREE.Vector3, direction: THREE.Vector3, maxDist: number): RaycastHit | null {
    let closestHit: RaycastHit | null = null;
    let closestDist = maxDist;

    // Get chunks along ray path (simplified - check all for now)
    // TODO: Optimize with ray-march through chunks
    for (const bvh of this.bvhs.values()) {
      const hit = bvh.raycast(origin, direction, closestDist);
      if (hit && hit.distance < closestDist) {
        closestDist = hit.distance;
        closestHit = hit;
      }
    }

    return closestHit;
  }

  /**
   * Sphere collision against terrain.
   * @param center Sphere center in world coordinates
   * @param radius Sphere radius
   * @returns Collision result with deepest penetration, or null if no collision
   */
  sphereCollide(center: THREE.Vector3, radius: number): CollisionResult | null {
    const relevantChunks = this.getRelevantChunks(center, radius);

    let deepestCollision: CollisionResult | null = null;
    let maxPenetration = 0;

    for (const key of relevantChunks) {
      const bvh = this.bvhs.get(key);
      if (!bvh) continue;

      const result = bvh.sphereCollide(center, radius);
      if (result && result.penetrationDepth > maxPenetration) {
        maxPenetration = result.penetrationDepth;
        deepestCollision = result;
      }
    }

    return deepestCollision;
  }

  /**
   * Capsule collision against terrain.
   * Approximated as sphere sweep along the capsule axis.
   * @param p1 First endpoint of capsule
   * @param p2 Second endpoint of capsule
   * @param radius Capsule radius
   * @returns Array of collision results along the capsule
   */
  capsuleCollide(p1: THREE.Vector3, p2: THREE.Vector3, radius: number): CollisionResult[] {
    const results: CollisionResult[] = [];

    // Sample points along capsule
    const axis = new THREE.Vector3().subVectors(p2, p1);
    const length = axis.length();
    axis.normalize();

    // Number of samples based on capsule length
    const samples = Math.max(2, Math.ceil(length / radius) + 1);

    for (let i = 0; i < samples; i++) {
      const t = i / (samples - 1);
      const samplePoint = new THREE.Vector3().lerpVectors(p1, p2, t);

      const collision = this.sphereCollide(samplePoint, radius);
      if (collision) {
        results.push(collision);
      }
    }

    return results;
  }

  /**
   * Resolve capsule collision by computing push-out vector.
   * @param p1 First endpoint of capsule
   * @param p2 Second endpoint of capsule
   * @param radius Capsule radius
   * @returns Push-out vector to resolve collision, or zero vector if no collision
   */
  resolveCapsuleCollision(p1: THREE.Vector3, p2: THREE.Vector3, radius: number): THREE.Vector3 {
    const collisions = this.capsuleCollide(p1, p2, radius);

    if (collisions.length === 0) {
      return new THREE.Vector3(0, 0, 0);
    }

    // Accumulate push-out from all collisions
    const pushOut = new THREE.Vector3(0, 0, 0);
    for (const collision of collisions) {
      pushOut.addScaledVector(collision.normal, collision.penetrationDepth);
    }

    // Average the push-out
    if (collisions.length > 1) {
      pushOut.divideScalar(collisions.length);
    }

    return pushOut;
  }

  /**
   * Ground check - raycast straight down to find ground height.
   * @param position Position to check from
   * @param maxDist Maximum distance to check down
   * @returns Ground height (Y coordinate) or null if no ground found
   */
  getGroundHeight(position: THREE.Vector3, maxDist: number = 100): number | null {
    const origin = new THREE.Vector3(position.x, position.y, position.z);
    const direction = new THREE.Vector3(0, -1, 0);

    const hit = this.raycast(origin, direction, maxDist);
    return hit ? hit.point.y : null;
  }

  /**
   * Check if a point is inside solid terrain.
   */
  isPointInsideTerrain(point: THREE.Vector3): boolean {
    // Raycast upward - if we hit something, we're inside
    const hit = this.raycast(point, new THREE.Vector3(0, 1, 0), 1000);
    return hit !== null;
  }

  /**
   * Get total number of BVHs loaded.
   */
  getBVHCount(): number {
    return this.bvhs.size;
  }

  /**
   * Get total triangle count across all BVHs.
   */
  getTotalTriangleCount(): number {
    let count = 0;
    for (const bvh of this.bvhs.values()) {
      count += bvh.triangleCount;
    }
    return count;
  }

  /**
   * Clear all BVHs.
   */
  dispose(): void {
    this.bvhs.clear();
  }
}
