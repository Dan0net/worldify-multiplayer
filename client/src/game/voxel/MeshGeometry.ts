/**
 * MeshGeometry - Convert SurfaceNet output to renderable geometry data
 * 
 * Expands indexed geometry to per-face vertices for material blending.
 * Each triangle's 3 vertices get:
 * - The same 3 material IDs (from the triangle's 3 original vertices)
 * - Different barycentric weights (1,0,0), (0,1,0), (0,0,1)
 * 
 * The shader interpolates between materials using these barycentric coords,
 * creating smooth material transitions across triangle boundaries.
 * 
 * Split into two layers:
 * - expandGeometry(): Pure function (no Three.js) — runs in worker or main thread
 * - createBufferGeometry(): Wraps raw arrays into THREE.BufferGeometry (main thread only)
 * 
 * Pattern from worldify-app's MeshWorkerMultimat.ts
 */

import * as THREE from 'three';
import { VOXEL_SCALE, CHUNK_SIZE, MESH_MARGIN } from '@worldify/shared';
import { SurfaceNetOutput } from './SurfaceNet.js';

/**
 * Conservative local-space extent of a chunk mesh, in world units. SurfaceNets places
 * vertices at grid coords in [0, CHUNK_SIZE+MESH_MARGIN] × VOXEL_SCALE (never negative),
 * so this box always contains the geometry. Used to set bounds without a per-remesh
 * vertex scan (computeBoundingBox/Sphere iterate every vertex, on the main thread).
 */
const CHUNK_MESH_EXTENT = (CHUNK_SIZE + MESH_MARGIN) * VOXEL_SCALE;
const CHUNK_BOUND_CENTER = CHUNK_MESH_EXTENT / 2;
// Half-diagonal of the extent cube — radius from center to a far corner.
const CHUNK_BOUND_RADIUS = Math.sqrt(3) * CHUNK_BOUND_CENTER;
/**
 * Raw expanded mesh data - plain typed arrays, no Three.js dependency.
 * This is what gets transferred between worker and main thread.
 */
export interface ExpandedMeshData {
  positions: Float32Array;
  normals: Float32Array;
  materialIds: Float32Array;
  materialWeights: Float32Array;
  lightLevels: Float32Array;
  blockLightLevels: Float32Array;
  indices: Uint32Array;
  /**
   * Boundary (seam) vertices grouped by chunk face, for normal reconciliation.
   * CSR layout: `indices` holds expanded-vertex indices; face `f`'s slice is
   * `indices[faceOffsets[f] .. faceOffsets[f+1]]`. Face order:
   * [lowX, highX, lowY, highY, lowZ, highZ] (matches SurfaceNet boundaryFlags bits).
   */
  boundary: { indices: Uint32Array; faceOffsets: Uint32Array };
}

/**
 * Expand indexed SurfaceNet output to per-face vertices for material blending.
 * Pure function — no Three.js dependency. Safe to run in a worker.
 * 
 * @param output SurfaceNet mesh data with indexed vertices and per-vertex materials
 * @returns Expanded mesh data, or null if empty
 */
export function expandGeometry(output: SurfaceNetOutput): ExpandedMeshData | null {
  const triangleCount = output.triangleCount;
  if (triangleCount === 0 || output.vertexCount === 0) return null;

  const expandedVertexCount = triangleCount * 3;
  
  const positions = new Float32Array(expandedVertexCount * 3);
  const normals = new Float32Array(expandedVertexCount * 3);
  const materialIds = new Float32Array(expandedVertexCount * 3);
  const materialWeights = new Float32Array(expandedVertexCount * 3);
  const lightLevels = new Float32Array(expandedVertexCount);
  const blockLightLevels = new Float32Array(expandedVertexCount);
  const indices = new Uint32Array(expandedVertexCount);

  // Per-face buckets of expanded-vertex indices that sit on a chunk boundary plane.
  // Order matches SurfaceNet boundaryFlags bits: [lowX, highX, lowY, highY, lowZ, highZ].
  const srcFlags = output.boundaryFlags;
  const faceBuckets: number[][] = [[], [], [], [], [], []];
  const pushBoundary = (srcIdx: number, expandedIdx: number): void => {
    const flag = srcFlags[srcIdx];
    if (flag === 0) return;
    for (let f = 0; f < 6; f++) {
      if (flag & (1 << f)) faceBuckets[f].push(expandedIdx);
    }
  };

  for (let faceIdx = 0; faceIdx < triangleCount; faceIdx++) {
    const i0 = output.indices[faceIdx * 3];
    const i1 = output.indices[faceIdx * 3 + 1];
    const i2 = output.indices[faceIdx * 3 + 2];

    const m0 = output.materials[i0];
    const m1 = output.materials[i1];
    const m2 = output.materials[i2];

    const v0 = faceIdx * 3;
    const v1 = faceIdx * 3 + 1;
    const v2 = faceIdx * 3 + 2;
    
    // Positions (scaled to world units)
    positions[v0 * 3] = output.positions[i0 * 3] * VOXEL_SCALE;
    positions[v0 * 3 + 1] = output.positions[i0 * 3 + 1] * VOXEL_SCALE;
    positions[v0 * 3 + 2] = output.positions[i0 * 3 + 2] * VOXEL_SCALE;
    
    positions[v1 * 3] = output.positions[i1 * 3] * VOXEL_SCALE;
    positions[v1 * 3 + 1] = output.positions[i1 * 3 + 1] * VOXEL_SCALE;
    positions[v1 * 3 + 2] = output.positions[i1 * 3 + 2] * VOXEL_SCALE;
    
    positions[v2 * 3] = output.positions[i2 * 3] * VOXEL_SCALE;
    positions[v2 * 3 + 1] = output.positions[i2 * 3 + 1] * VOXEL_SCALE;
    positions[v2 * 3 + 2] = output.positions[i2 * 3 + 2] * VOXEL_SCALE;
    
    // Normals
    normals[v0 * 3] = output.normals[i0 * 3];
    normals[v0 * 3 + 1] = output.normals[i0 * 3 + 1];
    normals[v0 * 3 + 2] = output.normals[i0 * 3 + 2];
    
    normals[v1 * 3] = output.normals[i1 * 3];
    normals[v1 * 3 + 1] = output.normals[i1 * 3 + 1];
    normals[v1 * 3 + 2] = output.normals[i1 * 3 + 2];
    
    normals[v2 * 3] = output.normals[i2 * 3];
    normals[v2 * 3 + 1] = output.normals[i2 * 3 + 1];
    normals[v2 * 3 + 2] = output.normals[i2 * 3 + 2];
    
    // Material IDs: all 3 materials on every vertex of this triangle
    materialIds[v0 * 3] = m0; materialIds[v0 * 3 + 1] = m1; materialIds[v0 * 3 + 2] = m2;
    materialIds[v1 * 3] = m0; materialIds[v1 * 3 + 1] = m1; materialIds[v1 * 3 + 2] = m2;
    materialIds[v2 * 3] = m0; materialIds[v2 * 3 + 1] = m1; materialIds[v2 * 3 + 2] = m2;
    
    // Barycentric weights: (1,0,0), (0,1,0), (0,0,1)
    materialWeights[v0 * 3] = 1; materialWeights[v0 * 3 + 1] = 0; materialWeights[v0 * 3 + 2] = 0;
    materialWeights[v1 * 3] = 0; materialWeights[v1 * 3 + 1] = 1; materialWeights[v1 * 3 + 2] = 0;
    materialWeights[v2 * 3] = 0; materialWeights[v2 * 3 + 1] = 0; materialWeights[v2 * 3 + 2] = 1;
    
    // Light levels (1 float per expanded vertex)
    lightLevels[v0] = output.lights[i0];
    lightLevels[v1] = output.lights[i1];
    lightLevels[v2] = output.lights[i2];

    // Block light levels (1 float per expanded vertex)
    blockLightLevels[v0] = output.blockLights[i0];
    blockLightLevels[v1] = output.blockLights[i1];
    blockLightLevels[v2] = output.blockLights[i2];

    indices[v0] = v0;
    indices[v1] = v1;
    indices[v2] = v2;

    // Record boundary membership per expanded vertex (uses the source vertex's flag).
    pushBoundary(i0, v0);
    pushBoundary(i1, v1);
    pushBoundary(i2, v2);
  }

  // Flatten the 6 buckets into a single CSR array + length-7 offsets.
  const faceOffsets = new Uint32Array(7);
  let total = 0;
  for (let f = 0; f < 6; f++) { faceOffsets[f] = total; total += faceBuckets[f].length; }
  faceOffsets[6] = total;
  const boundaryIndices = new Uint32Array(total);
  let w = 0;
  for (let f = 0; f < 6; f++) {
    const b = faceBuckets[f];
    for (let i = 0; i < b.length; i++) boundaryIndices[w++] = b[i];
  }

  return {
    positions, normals, materialIds, materialWeights, lightLevels, blockLightLevels, indices,
    boundary: { indices: boundaryIndices, faceOffsets },
  };
}

/**
 * Wrap raw expanded mesh data into a THREE.BufferGeometry.
 * Main thread only — lightweight, just setAttribute calls.
 * Attribute layout must match TERRAIN_ATTRS in LayerConfig.ts.
 */
export function createBufferGeometry(data: ExpandedMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('materialIds', new THREE.BufferAttribute(data.materialIds, 3));
  geometry.setAttribute('materialWeights', new THREE.BufferAttribute(data.materialWeights, 3));
  geometry.setAttribute('lightLevel', new THREE.BufferAttribute(data.lightLevels, 1));
  geometry.setAttribute('blockLight', new THREE.BufferAttribute(data.blockLightLevels, 1));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  // Fixed conservative bounds — avoids the per-remesh vertex scan of
  // computeBoundingBox/computeBoundingSphere. The chunk mesh always fits this box.
  geometry.boundingBox = new THREE.Box3(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(CHUNK_MESH_EXTENT, CHUNK_MESH_EXTENT, CHUNK_MESH_EXTENT),
  );
  geometry.boundingSphere = new THREE.Sphere(
    new THREE.Vector3(CHUNK_BOUND_CENTER, CHUNK_BOUND_CENTER, CHUNK_BOUND_CENTER),
    CHUNK_BOUND_RADIUS,
  );
  return geometry;
}

/**
 * Create a BufferGeometry from SurfaceNet output with material blending support.
 * Convenience wrapper: expandGeometry + createBufferGeometry in one call.
 * Used by sync path (fallback) and existing callers.
 */
export function createGeometryFromSurfaceNet(output: SurfaceNetOutput): THREE.BufferGeometry {
  const data = expandGeometry(output);
  if (!data) return new THREE.BufferGeometry();
  return createBufferGeometry(data);
}
