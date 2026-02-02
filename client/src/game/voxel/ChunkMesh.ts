/**
 * ChunkMesh - Manages Three.js mesh lifecycle for voxel chunks
 * 
 * Each chunk has two meshes:
 * - solidMesh: Opaque materials rendered without alpha blending
 * - transparentMesh: Materials with alpha (leaves, etc.) rendered with transparency
 */

import * as THREE from 'three';
import { Chunk } from './Chunk.js';
import { SurfaceNetOutput } from './SurfaceNet.js';
import { ChunkMeshOutput } from './ChunkMesher.js';
import { getTerrainMaterial, getTransparentTerrainMaterial } from './VoxelMaterials.js';
import { createGeometryFromSurfaceNet } from './MeshGeometry.js';

/**
 * Create a solid (opaque) mesh from geometry.
 */
function createSolidMesh(geometry: THREE.BufferGeometry, chunkKey: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, getTerrainMaterial());
  mesh.userData.chunkKey = chunkKey;
  mesh.userData.meshType = 'solid';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/**
 * Create a transparent mesh from geometry.
 */
function createTransparentMesh(geometry: THREE.BufferGeometry, chunkKey: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, getTransparentTerrainMaterial());
  mesh.userData.chunkKey = chunkKey;
  mesh.userData.meshType = 'transparent';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Transparent objects should render after opaque ones
  mesh.renderOrder = 1;
  return mesh;
}

// ============== ChunkMesh Class ==============

/**
 * Container for a chunk's meshes (solid and transparent) and related data.
 */
export class ChunkMesh {
  /** Solid (opaque) mesh - used for collision detection */
  solidMesh: THREE.Mesh | null = null;
  
  /** Transparent mesh - leaves and other alpha materials */
  transparentMesh: THREE.Mesh | null = null;
  
  /** Preview solid mesh for build preview (visual only, not for collision) */
  previewSolidMesh: THREE.Mesh | null = null;
  
  /** Preview transparent mesh for build preview */
  previewTransparentMesh: THREE.Mesh | null = null;
  
  /** Whether preview mode is active (hides main meshes, shows preview) */
  private previewActive: boolean = false;
  
  /** The chunk this mesh represents */
  readonly chunk: Chunk;
  
  /** Whether the meshes have been disposed */
  disposed: boolean = false;
  
  /** Generation counter - increments each time mesh geometry is updated */
  meshGeneration: number = 0;

  constructor(chunk: Chunk) {
    this.chunk = chunk;
  }

  /**
   * Create or update meshes from ChunkMeshOutput (solid + transparent).
   * @param output Mesh data for solid and transparent materials
   * @param scene Optional scene to add meshes to
   */
  updateMeshes(output: ChunkMeshOutput, scene?: THREE.Scene): void {
    // Dispose old meshes if they exist
    this.disposeMeshes(scene);

    const worldPos = this.chunk.getWorldPosition();
    const chunkCoords = { cx: this.chunk.cx, cy: this.chunk.cy, cz: this.chunk.cz };

    // Create solid mesh
    if (output.solid.vertexCount > 0 && output.solid.triangleCount > 0) {
      const solidGeometry = createGeometryFromSurfaceNet(output.solid);
      this.solidMesh = createSolidMesh(solidGeometry, this.chunk.key);
      this.solidMesh.position.set(worldPos.x, worldPos.y, worldPos.z);
      this.solidMesh.userData.chunkCoords = chunkCoords;
      
      if (scene) {
        scene.add(this.solidMesh);
      }
      this.solidMesh.updateMatrixWorld(true);
    }

    // Create transparent mesh
    if (output.transparent.vertexCount > 0 && output.transparent.triangleCount > 0) {
      const transparentGeometry = createGeometryFromSurfaceNet(output.transparent);
      this.transparentMesh = createTransparentMesh(transparentGeometry, this.chunk.key);
      this.transparentMesh.position.set(worldPos.x, worldPos.y, worldPos.z);
      this.transparentMesh.userData.chunkCoords = chunkCoords;
      
      if (scene) {
        scene.add(this.transparentMesh);
      }
      this.transparentMesh.updateMatrixWorld(true);
    }

    this.disposed = false;
    this.meshGeneration++;
  }

  /**
   * Legacy: Create or update the solid mesh only from SurfaceNet output.
   * @deprecated Use updateMeshes() with ChunkMeshOutput instead
   * @param output SurfaceNet mesh data
   * @param scene Optional scene to add mesh to
   */
  updateMesh(output: SurfaceNetOutput, scene?: THREE.Scene): void {
    // Dispose old solid mesh if exists
    if (this.solidMesh) {
      if (scene) scene.remove(this.solidMesh);
      this.solidMesh.geometry.dispose();
      this.solidMesh = null;
    }

    // Don't create mesh for empty geometry
    if (output.vertexCount === 0 || output.triangleCount === 0) {
      return;
    }

    // Create geometry and mesh
    const geometry = createGeometryFromSurfaceNet(output);
    this.solidMesh = createSolidMesh(geometry, this.chunk.key);
    
    // Position mesh at chunk world position
    const worldPos = this.chunk.getWorldPosition();
    this.solidMesh.position.set(worldPos.x, worldPos.y, worldPos.z);
    this.solidMesh.userData.chunkCoords = { cx: this.chunk.cx, cy: this.chunk.cy, cz: this.chunk.cz };

    this.disposed = false;
    this.meshGeneration++;

    // Add to scene if provided
    if (scene) {
      scene.add(this.solidMesh);
    }
    
    // Update world matrix so raycasting works immediately
    this.solidMesh.updateMatrixWorld(true);
  }

  /**
   * Update the preview meshes from ChunkMeshOutput (temp data).
   * The preview meshes are visual only - collision uses the main solid mesh.
   * @param output Mesh data from temp voxel data
   * @param scene Scene to add preview meshes to
   */
  updatePreviewMeshes(output: ChunkMeshOutput, scene: THREE.Scene): void {
    // Dispose old preview meshes
    this.disposePreviewMeshes(scene);

    const worldPos = this.chunk.getWorldPosition();

    // Create preview solid mesh
    if (output.solid.vertexCount > 0 && output.solid.triangleCount > 0) {
      const solidGeometry = createGeometryFromSurfaceNet(output.solid);
      this.previewSolidMesh = createSolidMesh(solidGeometry, this.chunk.key);
      this.previewSolidMesh.userData.isPreview = true;
      this.previewSolidMesh.position.set(worldPos.x, worldPos.y, worldPos.z);
      scene.add(this.previewSolidMesh);
    }

    // Create preview transparent mesh
    if (output.transparent.vertexCount > 0 && output.transparent.triangleCount > 0) {
      const transparentGeometry = createGeometryFromSurfaceNet(output.transparent);
      this.previewTransparentMesh = createTransparentMesh(transparentGeometry, this.chunk.key);
      this.previewTransparentMesh.userData.isPreview = true;
      this.previewTransparentMesh.position.set(worldPos.x, worldPos.y, worldPos.z);
      scene.add(this.previewTransparentMesh);
    }
  }

  /**
   * Legacy: Update the preview mesh from SurfaceNet output (temp data).
   * @deprecated Use updatePreviewMeshes() with ChunkMeshOutput instead
   */
  updatePreviewMesh(output: SurfaceNetOutput, scene: THREE.Scene): void {
    // Dispose old preview mesh
    this.disposePreviewMesh(scene);

    // Don't create mesh for empty geometry
    if (output.vertexCount === 0 || output.triangleCount === 0) {
      return;
    }

    // Create geometry and mesh using helpers
    const geometry = createGeometryFromSurfaceNet(output);
    this.previewSolidMesh = createSolidMesh(geometry, this.chunk.key);
    this.previewSolidMesh.userData.isPreview = true;
    
    const worldPos = this.chunk.getWorldPosition();
    this.previewSolidMesh.position.set(worldPos.x, worldPos.y, worldPos.z);

    scene.add(this.previewSolidMesh);
  }

  /**
   * Dispose of the preview meshes only.
   */
  disposePreviewMeshes(scene?: THREE.Scene): void {
    if (this.previewSolidMesh) {
      if (scene) scene.remove(this.previewSolidMesh);
      this.previewSolidMesh.geometry.dispose();
      this.previewSolidMesh = null;
    }
    if (this.previewTransparentMesh) {
      if (scene) scene.remove(this.previewTransparentMesh);
      this.previewTransparentMesh.geometry.dispose();
      this.previewTransparentMesh = null;
    }
  }

  /**
   * Legacy alias for disposePreviewMeshes.
   * @deprecated Use disposePreviewMeshes() instead
   */
  disposePreviewMesh(scene?: THREE.Scene): void {
    this.disposePreviewMeshes(scene);
  }

  /**
   * Set preview mode active. When active, main meshes are hidden.
   * @param active Whether to activate preview mode
   * @param scene Scene to remove preview meshes from when deactivating (required)
   */
  setPreviewActive(active: boolean, scene: THREE.Scene): void {
    if (this.previewActive === active) return;
    this.previewActive = active;

    if (this.solidMesh) {
      this.solidMesh.visible = !active;
    }
    if (this.transparentMesh) {
      this.transparentMesh.visible = !active;
    }
    
    // If deactivating, clean up preview meshes
    if (!active) {
      this.disposePreviewMeshes(scene);
    }
  }

  /**
   * Check if preview mode is active.
   */
  isPreviewActive(): boolean {
    return this.previewActive;
  }

  /**
   * Dispose of all meshes and clean up resources.
   * @param scene Optional scene to remove meshes from
   */
  disposeMeshes(scene?: THREE.Scene): void {
    // Also dispose preview meshes
    this.disposePreviewMeshes(scene);
    this.previewActive = false;
    
    if (this.solidMesh) {
      if (scene) scene.remove(this.solidMesh);
      this.solidMesh.geometry.dispose();
      this.solidMesh = null;
    }
    
    if (this.transparentMesh) {
      if (scene) scene.remove(this.transparentMesh);
      this.transparentMesh.geometry.dispose();
      this.transparentMesh = null;
    }
    
    this.disposed = true;
  }

  /**
   * Legacy alias for disposeMeshes.
   * @deprecated Use disposeMeshes() instead
   */
  disposeMesh(scene?: THREE.Scene): void {
    this.disposeMeshes(scene);
  }

  /**
   * Check if this chunk mesh has valid geometry (solid or transparent).
   */
  hasGeometry(): boolean {
    return (this.solidMesh !== null || this.transparentMesh !== null) && !this.disposed;
  }

  /**
   * Get the solid mesh (for collision, etc).
   * @returns The solid mesh or null if not created/disposed
   */
  getMesh(): THREE.Mesh | null {
    return this.solidMesh;
  }

  /**
   * Get both meshes as an array.
   * @returns Array of non-null meshes (solid and/or transparent)
   */
  getAllMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    if (this.solidMesh) meshes.push(this.solidMesh);
    if (this.transparentMesh) meshes.push(this.transparentMesh);
    return meshes;
  }

  /**
   * Get the total vertex count of all meshes.
   */
  getVertexCount(): number {
    let count = 0;
    if (this.solidMesh) {
      const posAttr = this.solidMesh.geometry.getAttribute('position');
      if (posAttr) count += posAttr.count;
    }
    if (this.transparentMesh) {
      const posAttr = this.transparentMesh.geometry.getAttribute('position');
      if (posAttr) count += posAttr.count;
    }
    return count;
  }

  /**
   * Get the total triangle count of all meshes.
   */
  getTriangleCount(): number {
    let count = 0;
    if (this.solidMesh) {
      const index = this.solidMesh.geometry.index;
      if (index) count += index.count / 3;
    }
    if (this.transparentMesh) {
      const index = this.transparentMesh.geometry.index;
      if (index) count += index.count / 3;
    }
    return count;
  }

  // Legacy property for backwards compatibility
  get mesh(): THREE.Mesh | null {
    return this.solidMesh;
  }

  set mesh(value: THREE.Mesh | null) {
    this.solidMesh = value;
  }

  get previewMesh(): THREE.Mesh | null {
    return this.previewSolidMesh;
  }

  set previewMesh(value: THREE.Mesh | null) {
    this.previewSolidMesh = value;
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

  const geometry = createGeometryFromSurfaceNet(output);
  const mesh = createSolidMesh(geometry, chunk.key);
  
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
