/**
 * ChunkMesh - Convert SurfaceNet output to Three.js mesh
 */

import * as THREE from 'three';
import { VOXEL_SCALE } from '@worldify/shared';
import { SurfaceNetOutput } from './SurfaceNet.js';
import { Chunk } from './Chunk.js';
import { getMaterialColor, voxelMaterial } from './VoxelMaterials.js';

/**
 * Container for a chunk's mesh and related data.
 */
export class ChunkMesh {
  /** The Three.js mesh */
  mesh: THREE.Mesh | null = null;
  
  /** The chunk this mesh represents */
  readonly chunk: Chunk;
  
  /** Whether the mesh has been disposed */
  disposed: boolean = false;

  constructor(chunk: Chunk) {
    this.chunk = chunk;
  }

  /**
   * Create or update the mesh from SurfaceNet output.
   * @param output SurfaceNet mesh data
   * @param scene Optional scene to add mesh to
   */
  updateMesh(output: SurfaceNetOutput, scene?: THREE.Scene): void {
    // Dispose old mesh if exists
    if (this.mesh) {
      this.disposeMesh(scene);
    }

    // Don't create mesh for empty geometry
    if (output.vertexCount === 0 || output.triangleCount === 0) {
      return;
    }

    // Create geometry
    const geometry = new THREE.BufferGeometry();

    // Set position attribute (scale from voxel units to world units)
    const scaledPositions = new Float32Array(output.positions.length);
    for (let i = 0; i < output.positions.length; i++) {
      scaledPositions[i] = output.positions[i] * VOXEL_SCALE;
    }
    geometry.setAttribute('position', new THREE.BufferAttribute(scaledPositions, 3));

    // Set normal attribute
    geometry.setAttribute('normal', new THREE.BufferAttribute(output.normals, 3));

    // Set index attribute
    geometry.setIndex(new THREE.BufferAttribute(output.indices, 1));

    // Create vertex colors from materials
    const colors = new Float32Array(output.vertexCount * 3);
    for (let i = 0; i < output.vertexCount; i++) {
      const materialId = output.materials[i];
      const color = getMaterialColor(materialId);
      colors[i * 3] = color.r;
      colors[i * 3 + 1] = color.g;
      colors[i * 3 + 2] = color.b;
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    // Compute bounding box/sphere for frustum culling
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    // Create mesh
    this.mesh = new THREE.Mesh(geometry, voxelMaterial);
    
    // Position mesh at chunk world position
    const worldPos = this.chunk.getWorldPosition();
    this.mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

    // Set user data for identification
    this.mesh.userData.chunkKey = this.chunk.key;
    this.mesh.userData.chunkCoords = { cx: this.chunk.cx, cy: this.chunk.cy, cz: this.chunk.cz };

    // Enable shadow casting/receiving
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;

    this.disposed = false;

    // Add to scene if provided
    if (scene) {
      scene.add(this.mesh);
    }
  }

  /**
   * Dispose of the mesh and clean up resources.
   * @param scene Optional scene to remove mesh from
   */
  disposeMesh(scene?: THREE.Scene): void {
    if (this.mesh) {
      // Remove from scene
      if (scene) {
        scene.remove(this.mesh);
      }

      // Dispose geometry
      this.mesh.geometry.dispose();

      // Note: We don't dispose the shared material
      
      this.mesh = null;
    }
    this.disposed = true;
  }

  /**
   * Check if this chunk mesh has valid geometry.
   */
  hasGeometry(): boolean {
    return this.mesh !== null && !this.disposed;
  }

  /**
   * Get the vertex count of the current mesh.
   */
  getVertexCount(): number {
    if (!this.mesh) return 0;
    const posAttr = this.mesh.geometry.getAttribute('position');
    return posAttr ? posAttr.count : 0;
  }

  /**
   * Get the triangle count of the current mesh.
   */
  getTriangleCount(): number {
    if (!this.mesh) return 0;
    const index = this.mesh.geometry.index;
    return index ? index.count / 3 : 0;
  }
}

/**
 * Create a mesh directly from SurfaceNet output (standalone function).
 * @param output SurfaceNet mesh data
 * @param chunk The source chunk (for positioning)
 * @returns THREE.Mesh or null if empty geometry
 */
export function createMeshFromSurfaceNet(output: SurfaceNetOutput, chunk: Chunk): THREE.Mesh | null {
  if (output.vertexCount === 0 || output.triangleCount === 0) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();

  // Scale positions from voxel units to world units
  const scaledPositions = new Float32Array(output.positions.length);
  for (let i = 0; i < output.positions.length; i++) {
    scaledPositions[i] = output.positions[i] * VOXEL_SCALE;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(scaledPositions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(output.normals, 3));
  geometry.setIndex(new THREE.BufferAttribute(output.indices, 1));

  // Create vertex colors
  const colors = new Float32Array(output.vertexCount * 3);
  for (let i = 0; i < output.vertexCount; i++) {
    const materialId = output.materials[i];
    const color = getMaterialColor(materialId);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const mesh = new THREE.Mesh(geometry, voxelMaterial);
  
  const worldPos = chunk.getWorldPosition();
  mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

  mesh.userData.chunkKey = chunk.key;
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return mesh;
}

/**
 * Dispose a mesh created with createMeshFromSurfaceNet.
 */
export function disposeMesh(mesh: THREE.Mesh, scene?: THREE.Scene): void {
  if (scene) {
    scene.remove(mesh);
  }
  mesh.geometry.dispose();
}
