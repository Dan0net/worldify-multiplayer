/**
 * MeshGeometry - Convert SurfaceNet output to Three.js BufferGeometry
 * 
 * Expands indexed geometry to per-face vertices for material blending.
 * Each triangle's 3 vertices get:
 * - The same 3 material IDs (from the triangle's 3 original vertices)
 * - Different barycentric weights (1,0,0), (0,1,0), (0,0,1)
 * 
 * The shader interpolates between materials using these barycentric coords,
 * creating smooth material transitions across triangle boundaries.
 * 
 * Pattern from worldify-app's MeshWorkerMultimat.ts
 */

import * as THREE from 'three';
import { VOXEL_SCALE } from '@worldify/shared';
import { SurfaceNetOutput } from './SurfaceNet.js';
import { getMaterialColor } from './VoxelMaterials.js';

/**
 * Create a BufferGeometry from SurfaceNet output with material blending support.
 * 
 * This expands indexed geometry to per-face vertices, allowing each triangle
 * to blend between up to 3 materials using barycentric interpolation.
 * 
 * @param output SurfaceNet mesh data with indexed vertices and per-vertex materials
 * @returns Three.js BufferGeometry with materialIds and materialWeights attributes
 */
export function createGeometryFromSurfaceNet(output: SurfaceNetOutput): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  
  const triangleCount = output.triangleCount;
  const expandedVertexCount = triangleCount * 3;
  
  // Expanded arrays - 3 vertices per triangle, no sharing
  const positions = new Float32Array(expandedVertexCount * 3);
  const normals = new Float32Array(expandedVertexCount * 3);
  const colors = new Float32Array(expandedVertexCount * 3);
  const materialIds = new Float32Array(expandedVertexCount * 3);
  const materialWeights = new Float32Array(expandedVertexCount * 3);
  const indices = new Uint32Array(expandedVertexCount);
  
  // Process each triangle
  for (let faceIdx = 0; faceIdx < triangleCount; faceIdx++) {
    // Get original vertex indices for this triangle
    const i0 = output.indices[faceIdx * 3];
    const i1 = output.indices[faceIdx * 3 + 1];
    const i2 = output.indices[faceIdx * 3 + 2];
    
    // Get materials from original vertices
    const m0 = output.materials[i0];
    const m1 = output.materials[i1];
    const m2 = output.materials[i2];
    
    // Expanded vertex indices (sequential, no sharing)
    const v0 = faceIdx * 3;
    const v1 = faceIdx * 3 + 1;
    const v2 = faceIdx * 3 + 2;
    
    // Copy positions (scaled to world units)
    positions[v0 * 3] = output.positions[i0 * 3] * VOXEL_SCALE;
    positions[v0 * 3 + 1] = output.positions[i0 * 3 + 1] * VOXEL_SCALE;
    positions[v0 * 3 + 2] = output.positions[i0 * 3 + 2] * VOXEL_SCALE;
    
    positions[v1 * 3] = output.positions[i1 * 3] * VOXEL_SCALE;
    positions[v1 * 3 + 1] = output.positions[i1 * 3 + 1] * VOXEL_SCALE;
    positions[v1 * 3 + 2] = output.positions[i1 * 3 + 2] * VOXEL_SCALE;
    
    positions[v2 * 3] = output.positions[i2 * 3] * VOXEL_SCALE;
    positions[v2 * 3 + 1] = output.positions[i2 * 3 + 1] * VOXEL_SCALE;
    positions[v2 * 3 + 2] = output.positions[i2 * 3 + 2] * VOXEL_SCALE;
    
    // Copy normals from original vertices
    normals[v0 * 3] = output.normals[i0 * 3];
    normals[v0 * 3 + 1] = output.normals[i0 * 3 + 1];
    normals[v0 * 3 + 2] = output.normals[i0 * 3 + 2];
    
    normals[v1 * 3] = output.normals[i1 * 3];
    normals[v1 * 3 + 1] = output.normals[i1 * 3 + 1];
    normals[v1 * 3 + 2] = output.normals[i1 * 3 + 2];
    
    normals[v2 * 3] = output.normals[i2 * 3];
    normals[v2 * 3 + 1] = output.normals[i2 * 3 + 1];
    normals[v2 * 3 + 2] = output.normals[i2 * 3 + 2];
    
    // Colors from primary material (for fallback rendering)
    const color0 = getMaterialColor(m0);
    const color1 = getMaterialColor(m1);
    const color2 = getMaterialColor(m2);
    
    colors[v0 * 3] = color0.r;
    colors[v0 * 3 + 1] = color0.g;
    colors[v0 * 3 + 2] = color0.b;
    
    colors[v1 * 3] = color1.r;
    colors[v1 * 3 + 1] = color1.g;
    colors[v1 * 3 + 2] = color1.b;
    
    colors[v2 * 3] = color2.r;
    colors[v2 * 3 + 1] = color2.g;
    colors[v2 * 3 + 2] = color2.b;
    
    // Material IDs: ALL 3 materials assigned to EACH vertex of this triangle
    // This allows the shader to blend between all 3 materials
    materialIds[v0 * 3] = m0;
    materialIds[v0 * 3 + 1] = m1;
    materialIds[v0 * 3 + 2] = m2;
    
    materialIds[v1 * 3] = m0;
    materialIds[v1 * 3 + 1] = m1;
    materialIds[v1 * 3 + 2] = m2;
    
    materialIds[v2 * 3] = m0;
    materialIds[v2 * 3 + 1] = m1;
    materialIds[v2 * 3 + 2] = m2;
    
    // Material weights: barycentric coords (1,0,0), (0,1,0), (0,0,1)
    // Vertex 0 gets 100% of material 0
    materialWeights[v0 * 3] = 1.0;
    materialWeights[v0 * 3 + 1] = 0.0;
    materialWeights[v0 * 3 + 2] = 0.0;
    
    // Vertex 1 gets 100% of material 1
    materialWeights[v1 * 3] = 0.0;
    materialWeights[v1 * 3 + 1] = 1.0;
    materialWeights[v1 * 3 + 2] = 0.0;
    
    // Vertex 2 gets 100% of material 2
    materialWeights[v2 * 3] = 0.0;
    materialWeights[v2 * 3 + 1] = 0.0;
    materialWeights[v2 * 3 + 2] = 1.0;
    
    // Sequential indices (no sharing)
    indices[v0] = v0;
    indices[v1] = v1;
    indices[v2] = v2;
  }
  
  // Set attributes
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('materialIds', new THREE.BufferAttribute(materialIds, 3));
  geometry.setAttribute('materialWeights', new THREE.BufferAttribute(materialWeights, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));

  // Compute bounds for frustum culling
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}
