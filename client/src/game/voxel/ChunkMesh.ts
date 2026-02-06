/**
 * ChunkMesh - Manages Three.js mesh lifecycle for voxel chunks
 * 
 * Each chunk has three meshes:
 * - solidMesh: Opaque materials rendered without alpha blending
 * - transparentMesh: Materials with alpha (leaves, etc.) rendered with transparency
 * - liquidMesh: Water and other liquid materials with special rendering
 */

import * as THREE from 'three';
import { Chunk } from './Chunk.js';
import { SurfaceNetOutput } from './SurfaceNet.js';
import { ChunkMeshOutput } from './ChunkMesher.js';
import { getTerrainMaterial, getTransparentTerrainMaterial, getLiquidTerrainMaterial, getTransparentDepthMaterial } from './VoxelMaterials.js';
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
  // Use custom depth material for alpha-tested shadow casting
  mesh.customDepthMaterial = getTransparentDepthMaterial();
  // Transparent objects should render after opaque ones
  mesh.renderOrder = 1;
  return mesh;
}

/**
 * Create a liquid mesh from geometry.
 */
function createLiquidMesh(geometry: THREE.BufferGeometry, chunkKey: string): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, getLiquidTerrainMaterial());
  mesh.userData.chunkKey = chunkKey;
  mesh.userData.meshType = 'liquid';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  // Liquid renders after transparent
  mesh.renderOrder = 2;
  return mesh;
}

// ============== ChunkMesh Class ==============

/**
 * Container for a chunk's meshes (solid, transparent, and liquid) and related data.
 */
export class ChunkMesh {
  /** Solid (opaque) mesh - used for collision detection */
  solidMesh: THREE.Mesh | null = null;
  
  /** Transparent mesh - leaves and other alpha materials */
  transparentMesh: THREE.Mesh | null = null;
  
  /** Liquid mesh - water and other liquid materials */
  liquidMesh: THREE.Mesh | null = null;
  
  /** Preview solid mesh for build preview (visual only, not for collision) */
  previewSolidMesh: THREE.Mesh | null = null;
  
  /** Preview transparent mesh for build preview */
  previewTransparentMesh: THREE.Mesh | null = null;
  
  /** Preview liquid mesh for build preview */
  previewLiquidMesh: THREE.Mesh | null = null;
  
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
   * Create or update meshes from ChunkMeshOutput (solid + transparent + liquid).
   * Reuses existing THREE.Mesh objects when possible to avoid scene.remove/add overhead.
   * @param output Mesh data for solid, transparent, and liquid materials
   * @param scene Optional scene to add/remove meshes
   */
  updateMeshes(output: ChunkMeshOutput, scene?: THREE.Scene): void {
    // Clean up preview state (always needed before updating main meshes)
    this.disposePreviewMeshes(scene);
    this.previewActive = false;

    const worldPos = this.chunk.getWorldPosition();
    const chunkCoords = { cx: this.chunk.cx, cy: this.chunk.cy, cz: this.chunk.cz };

    // Update each mesh slot, reusing existing Mesh objects where possible
    this.solidMesh = this.updateMeshSlot(
      this.solidMesh, output.solid, createSolidMesh, worldPos, chunkCoords, scene
    );
    this.transparentMesh = this.updateMeshSlot(
      this.transparentMesh, output.transparent, createTransparentMesh, worldPos, chunkCoords, scene
    );
    this.liquidMesh = this.updateMeshSlot(
      this.liquidMesh, output.liquid, createLiquidMesh, worldPos, chunkCoords, scene
    );

    this.disposed = false;
    this.meshGeneration++;
  }

  /**
   * Update a single mesh slot: reuse existing mesh if possible, create/remove as needed.
   * - non-empty → non-empty: swap geometry on existing mesh (no scene.remove/add)
   * - empty → non-empty: create new mesh and add to scene  
   * - non-empty → empty: remove from scene and dispose
   * - empty → empty: no-op
   */
  private updateMeshSlot(
    existing: THREE.Mesh | null,
    output: SurfaceNetOutput,
    createFn: (geometry: THREE.BufferGeometry, chunkKey: string) => THREE.Mesh,
    worldPos: { x: number; y: number; z: number },
    chunkCoords: { cx: number; cy: number; cz: number },
    scene?: THREE.Scene,
  ): THREE.Mesh | null {
    const hasData = output.vertexCount > 0 && output.triangleCount > 0;

    if (!hasData) {
      // Remove existing mesh if present
      if (existing) {
        if (scene) scene.remove(existing);
        existing.geometry.dispose();
      }
      return null;
    }

    const newGeometry = createGeometryFromSurfaceNet(output);

    if (existing) {
      // Reuse existing mesh — swap geometry, skip scene.remove/add
      const oldGeometry = existing.geometry;
      existing.geometry = newGeometry;
      oldGeometry.dispose();
      return existing;
    }

    // Create new mesh (first time or transitioning from empty)
    const mesh = createFn(newGeometry, this.chunk.key);
    mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
    mesh.userData.chunkCoords = chunkCoords;
    if (scene) scene.add(mesh);
    mesh.updateMatrixWorld(true);
    return mesh;
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

    // Create preview liquid mesh
    if (output.liquid.vertexCount > 0 && output.liquid.triangleCount > 0) {
      const liquidGeometry = createGeometryFromSurfaceNet(output.liquid);
      this.previewLiquidMesh = createLiquidMesh(liquidGeometry, this.chunk.key);
      this.previewLiquidMesh.userData.isPreview = true;
      this.previewLiquidMesh.position.set(worldPos.x, worldPos.y, worldPos.z);
      scene.add(this.previewLiquidMesh);
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
    if (this.previewLiquidMesh) {
      if (scene) scene.remove(this.previewLiquidMesh);
      this.previewLiquidMesh.geometry.dispose();
      this.previewLiquidMesh = null;
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
    if (this.liquidMesh) {
      this.liquidMesh.visible = !active;
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
    
    if (this.liquidMesh) {
      if (scene) scene.remove(this.liquidMesh);
      this.liquidMesh.geometry.dispose();
      this.liquidMesh = null;
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
   * Check if this chunk mesh has valid geometry (solid, transparent, or liquid).
   */
  hasGeometry(): boolean {
    return (this.solidMesh !== null || this.transparentMesh !== null || this.liquidMesh !== null) && !this.disposed;
  }

  /**
   * Set visibility of all meshes (for culling).
   * When preview is active, main meshes stay hidden regardless of this setting.
   * Does not affect preview meshes.
   */
  setVisible(visible: boolean): void {
    // If preview is active, main meshes must stay hidden
    const effectiveVisible = visible && !this.previewActive;
    if (this.solidMesh) this.solidMesh.visible = effectiveVisible;
    if (this.transparentMesh) this.transparentMesh.visible = effectiveVisible;
    if (this.liquidMesh) this.liquidMesh.visible = effectiveVisible;
  }

  /**
   * Get the solid mesh (for collision, etc).
   * @returns The solid mesh or null if not created/disposed
   */
  getMesh(): THREE.Mesh | null {
    return this.solidMesh;
  }

  /**
   * Get all meshes as an array.
   * @returns Array of non-null meshes (solid, transparent, and/or liquid)
   */
  getAllMeshes(): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    if (this.solidMesh) meshes.push(this.solidMesh);
    if (this.transparentMesh) meshes.push(this.transparentMesh);
    if (this.liquidMesh) meshes.push(this.liquidMesh);
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
    if (this.liquidMesh) {
      const posAttr = this.liquidMesh.geometry.getAttribute('position');
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
    if (this.liquidMesh) {
      const index = this.liquidMesh.geometry.index;
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
