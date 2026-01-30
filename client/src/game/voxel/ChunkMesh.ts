/**
 * ChunkMesh - Convert SurfaceNet output to Three.js mesh
 */

import * as THREE from 'three';
import { VOXEL_SCALE, Chunk } from '@worldify/shared';
import { SurfaceNetOutput } from './SurfaceNet.js';
import { getMaterialColor, voxelMaterial } from './VoxelMaterials.js';

// ============== Helper Functions ==============

/**
 * Create a BufferGeometry from SurfaceNet output.
 * This is the single source of truth for geometry creation.
 */
function createGeometryFromOutput(output: SurfaceNetOutput): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();

  // Scale positions from voxel units to world units
  const scaledPositions = new Float32Array(output.positions.length);
  for (let i = 0; i < output.positions.length; i++) {
    scaledPositions[i] = output.positions[i] * VOXEL_SCALE;
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(scaledPositions, 3));

  // Normals
  geometry.setAttribute('normal', new THREE.BufferAttribute(output.normals, 3));

  // Indices
  geometry.setIndex(new THREE.BufferAttribute(output.indices, 1));

  // Vertex colors from materials
  const colors = new Float32Array(output.vertexCount * 3);
  for (let i = 0; i < output.vertexCount; i++) {
    const materialId = output.materials[i];
    const color = getMaterialColor(materialId);
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Compute bounds for frustum culling
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

/**
 * Create a mesh from geometry with standard settings.
 */
function createMesh(geometry: THREE.BufferGeometry, chunkKey: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, voxelMaterial);
  mesh.userData.chunkKey = chunkKey;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ============== ChunkMesh Class ==============

/**
 * Container for a chunk's mesh and related data.
 */
export class ChunkMesh {
  /** The Three.js mesh (used for collision) */
  mesh: THREE.Mesh | null = null;
  
  /** Preview mesh for build preview (visual only, not for collision) */
  previewMesh: THREE.Mesh | null = null;
  
  /** Whether preview mode is active (hides main mesh, shows preview) */
  private previewActive: boolean = false;
  
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

    // Create geometry and mesh using helpers
    const geometry = createGeometryFromOutput(output);
    this.mesh = createMesh(geometry, this.chunk.key);
    
    // Position mesh at chunk world position
    const worldPos = this.chunk.getWorldPosition();
    this.mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
    this.mesh.userData.chunkCoords = { cx: this.chunk.cx, cy: this.chunk.cy, cz: this.chunk.cz };

    this.disposed = false;

    // Add to scene if provided
    if (scene) {
      scene.add(this.mesh);
    }
  }

  /**
   * Update the preview mesh from SurfaceNet output (temp data).
   * The preview mesh is visual only - collision uses the main mesh.
   * @param output SurfaceNet mesh data from temp voxel data
   * @param scene Scene to add preview mesh to
   */
  updatePreviewMesh(output: SurfaceNetOutput, scene: THREE.Scene): void {
    // Dispose old preview mesh
    this.disposePreviewMesh(scene);

    // Don't create mesh for empty geometry
    if (output.vertexCount === 0 || output.triangleCount === 0) {
      return;
    }

    // Create geometry and mesh using helpers
    const geometry = createGeometryFromOutput(output);
    this.previewMesh = createMesh(geometry, this.chunk.key);
    this.previewMesh.userData.isPreview = true;
    
    const worldPos = this.chunk.getWorldPosition();
    this.previewMesh.position.set(worldPos.x, worldPos.y, worldPos.z);

    scene.add(this.previewMesh);
  }

  /**
   * Dispose of the preview mesh only.
   */
  disposePreviewMesh(scene?: THREE.Scene): void {
    if (this.previewMesh) {
      if (scene) {
        scene.remove(this.previewMesh);
      }
      this.previewMesh.geometry.dispose();
      this.previewMesh = null;
    }
  }

  /**
   * Set preview mode active. When active, main mesh is hidden.
   */
  setPreviewActive(active: boolean, scene?: THREE.Scene): void {
    if (this.previewActive === active) return;
    this.previewActive = active;

    if (this.mesh) {
      this.mesh.visible = !active;
    }
    
    // If deactivating, clean up preview mesh
    if (!active && this.previewMesh) {
      this.disposePreviewMesh(scene);
    }
  }

  /**
   * Check if preview mode is active.
   */
  isPreviewActive(): boolean {
    return this.previewActive;
  }

  /**
   * Dispose of the mesh and clean up resources.
   * @param scene Optional scene to remove mesh from
   */
  disposeMesh(scene?: THREE.Scene): void {
    // Also dispose preview mesh
    this.disposePreviewMesh(scene);
    this.previewActive = false;
    
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
   * Get the Three.js mesh (for collision, etc).
   * @returns The mesh or null if not created/disposed
   */
  getMesh(): THREE.Mesh | null {
    return this.mesh;
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

  const geometry = createGeometryFromOutput(output);
  const mesh = createMesh(geometry, chunk.key);
  
  const worldPos = chunk.getWorldPosition();
  mesh.position.set(worldPos.x, worldPos.y, worldPos.z);

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
