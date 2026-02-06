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
import { VOXEL_SCALE } from '@worldify/shared';
import { SurfaceNetOutput } from './SurfaceNet.js';

/**
 * Raw expanded mesh data - plain typed arrays, no Three.js dependency.
 * This is what gets transferred between worker and main thread.
 */
export interface ExpandedMeshData {
  positions: Float32Array;
  normals: Float32Array;
  materialIds: Float32Array;
  materialWeights: Float32Array;
  indices: Uint32Array;
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
  const indices = new Uint32Array(expandedVertexCount);
  
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
    
    indices[v0] = v0;
    indices[v1] = v1;
    indices[v2] = v2;
  }
  
  return { positions, normals, materialIds, materialWeights, indices };
}

/**
 * Wrap raw expanded mesh data into a THREE.BufferGeometry.
 * Main thread only — lightweight, just setAttribute calls.
 */
export function createBufferGeometry(data: ExpandedMeshData): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normals, 3));
  geometry.setAttribute('materialIds', new THREE.BufferAttribute(data.materialIds, 3));
  geometry.setAttribute('materialWeights', new THREE.BufferAttribute(data.materialWeights, 3));
  geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
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
