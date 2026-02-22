/**
 * ChunkMesh - Manages Three.js mesh lifecycle for voxel chunks
 * 
 * Each chunk has three mesh slots (solid, transparent, liquid) for both
 * main rendering and build preview. Uses a slot-based architecture to
 * eliminate repetitive per-type code.
 */

import * as THREE from 'three';
import { Chunk } from './Chunk.js';
import { SurfaceNetOutput } from './SurfaceNet.js';
import type { SplitSurfaceNetOutput } from './SurfaceNet.js';
import { expandGeometry, createGeometryFromSurfaceNet, createBufferGeometry, type ExpandedMeshData } from './MeshGeometry.js';
import { createLayerMesh, LAYER_SOLID, LAYER_TRANSPARENT, LAYER_LIQUID, LAYER_COUNT } from './LayerConfig.js';

// Re-export for external consumers
export type { ExpandedMeshData } from './MeshGeometry.js';

// ============== ChunkMesh Class ==============

/** Input data for mesh updates — one entry per layer */
export type MeshLayerData = [ExpandedMeshData | null, ExpandedMeshData | null, ExpandedMeshData | null];

/**
 * Container for a chunk's meshes (solid, transparent, liquid) and preview meshes.
 * Uses a slot-based architecture — all three layers are managed identically.
 */
export class ChunkMesh {
  /** Main meshes indexed by MeshLayer */
  private mainMeshes: (THREE.Mesh | null)[] = [null, null, null];

  /** Preview meshes indexed by MeshLayer */
  private previewMeshes: (THREE.Mesh | null)[] = [null, null, null];

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

  // ============== Main Mesh Updates ==============

  /**
   * Create or update main meshes from worker results (ExpandedMeshData).
   * Primary path — used by the async worker pipeline.
   */
  updateMeshesFromData(
    solid: ExpandedMeshData | null,
    transparent: ExpandedMeshData | null,
    liquid: ExpandedMeshData | null,
    scene?: THREE.Scene,
  ): void {
    // If preview is active (pending commit), don't touch preview state.
    // Main meshes update underneath; onChunkRemeshed will swap visibility.
    if (!this.previewActive) {
      this.disposePreviewMeshes(scene);
    }

    this.updateAllSlots(this.mainMeshes, [solid, transparent, liquid], scene);
    this.disposed = false;
    this.meshGeneration++;
  }

  /**
   * Create or update main meshes from SurfaceNetOutput (sync/fallback path).
   */
  updateMeshes(output: SplitSurfaceNetOutput, scene?: THREE.Scene): void {
    this.disposePreviewMeshes(scene);
    this.previewActive = false;

    this.updateAllSlots(this.mainMeshes, [
      toExpandedData(output.solid),
      toExpandedData(output.transparent),
      toExpandedData(output.liquid),
    ], scene);

    this.disposed = false;
    this.meshGeneration++;
  }

  // ============== Preview Mesh Updates ==============

  /**
   * Update preview meshes from worker results (ExpandedMeshData).
   * Used by BuildPreview's async worker pipeline.
   */
  updatePreviewMeshesFromData(
    solid: ExpandedMeshData | null,
    transparent: ExpandedMeshData | null,
    liquid: ExpandedMeshData | null,
    scene: THREE.Scene,
  ): void {
    this.disposePreviewMeshes(scene);
    const worldPos = this.chunk.getWorldPosition();
    const data = [solid, transparent, liquid];

    for (let i = 0; i < LAYER_COUNT; i++) {
      if (!data[i]) continue;
      const geometry = createBufferGeometry(data[i]!);
      const mesh = createLayerMesh(geometry, i, this.chunk.key);
      mesh.userData.isPreview = true;
      mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
      scene.add(mesh);
      this.previewMeshes[i] = mesh;
    }
  }

  // ============== Preview State ==============

  /**
   * Set preview mode active. When active, main meshes are hidden.
   */
  setPreviewActive(active: boolean, scene: THREE.Scene): void {
    if (this.previewActive === active) return;
    this.previewActive = active;

    for (let i = 0; i < LAYER_COUNT; i++) {
      if (this.mainMeshes[i]) this.mainMeshes[i]!.visible = !active;
    }
    if (!active) this.disposePreviewMeshes(scene);
  }

  isPreviewActive(): boolean {
    return this.previewActive;
  }

  // ============== Accessors ==============

  /** Solid mesh (for collision detection) */
  get solidMesh(): THREE.Mesh | null { return this.mainMeshes[LAYER_SOLID]; }

  /** Transparent mesh */
  get transparentMesh(): THREE.Mesh | null { return this.mainMeshes[LAYER_TRANSPARENT]; }

  /** Liquid mesh */
  get liquidMesh(): THREE.Mesh | null { return this.mainMeshes[LAYER_LIQUID]; }

  /** Get the solid mesh for collision/raycasting */
  getMesh(): THREE.Mesh | null { return this.mainMeshes[LAYER_SOLID]; }

  /** Check if any mesh layer has geometry */
  hasGeometry(): boolean {
    return !this.disposed && this.mainMeshes.some(m => m !== null);
  }

  // ============== Stats ==============

  getVertexCount(): number {
    let count = 0;
    for (let i = 0; i < LAYER_COUNT; i++) {
      const attr = this.mainMeshes[i]?.geometry.getAttribute('position');
      if (attr) count += attr.count;
    }
    return count;
  }

  getTriangleCount(): number {
    let count = 0;
    for (let i = 0; i < LAYER_COUNT; i++) {
      const idx = this.mainMeshes[i]?.geometry.index;
      if (idx) count += idx.count / 3;
    }
    return count;
  }

  // ============== Disposal ==============

  /** Dispose all meshes (main + preview) */
  disposeMeshes(scene?: THREE.Scene): void {
    this.disposePreviewMeshes(scene);
    this.previewActive = false;
    disposeMeshArray(this.mainMeshes, scene);
    this.disposed = true;
  }

  /** Dispose preview meshes only */
  disposePreviewMeshes(scene?: THREE.Scene): void {
    disposeMeshArray(this.previewMeshes, scene);
  }

  // ============== Private Helpers ==============

  /**
   * Update all mesh slots from data array. Reuses existing THREE.Mesh objects
   * when possible (swap geometry) to avoid scene.remove/add overhead.
   */
  private updateAllSlots(meshArray: (THREE.Mesh | null)[], data: MeshLayerData, scene?: THREE.Scene): void {
    const worldPos = this.chunk.getWorldPosition();
    const chunkCoords = { cx: this.chunk.cx, cy: this.chunk.cy, cz: this.chunk.cz };

    for (let i = 0; i < LAYER_COUNT; i++) {
      meshArray[i] = this.updateSlot(meshArray[i], data[i], i, worldPos, chunkCoords, scene);
    }
  }

  /** Update a single mesh slot: reuse geometry swap or create/remove */
  private updateSlot(
    existing: THREE.Mesh | null,
    data: ExpandedMeshData | null,
    layer: number,
    worldPos: { x: number; y: number; z: number },
    chunkCoords: { cx: number; cy: number; cz: number },
    scene?: THREE.Scene,
  ): THREE.Mesh | null {
    if (!data) {
      if (existing) {
        if (scene) scene.remove(existing);
        existing.geometry.dispose();
      }
      return null;
    }

    const newGeometry = createBufferGeometry(data);

    if (existing) {
      const old = existing.geometry;
      existing.geometry = newGeometry;
      old.dispose();
      return existing;
    }

    const mesh = createLayerMesh(newGeometry, layer, this.chunk.key);
    mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
    mesh.userData.chunkCoords = chunkCoords;
    if (this.previewActive) mesh.visible = false;
    if (scene) scene.add(mesh);
    mesh.updateMatrixWorld(true);
    return mesh;
  }
}

// ============== Helper Functions ==============

/** Convert SurfaceNetOutput to ExpandedMeshData (or null if empty) */
function toExpandedData(output: SurfaceNetOutput): ExpandedMeshData | null {
  if (output.vertexCount === 0 || output.triangleCount === 0) return null;
  return expandGeometry(output);
}

/** Dispose all meshes in an array and null them out */
function disposeMeshArray(meshArray: (THREE.Mesh | null)[], scene?: THREE.Scene): void {
  for (let i = 0; i < meshArray.length; i++) {
    const m = meshArray[i];
    if (m) {
      if (scene) scene.remove(m);
      m.geometry.dispose();
      meshArray[i] = null;
    }
  }
}

// ============== Standalone Functions ==============

/**
 * Create a mesh directly from SurfaceNet output (standalone).
 */
export function createMeshFromSurfaceNet(output: SurfaceNetOutput, chunk: Chunk): THREE.Mesh | null {
  if (output.vertexCount === 0 || output.triangleCount === 0) return null;
  const geometry = createGeometryFromSurfaceNet(output);
  const mesh = createLayerMesh(geometry, LAYER_SOLID, chunk.key);
  const worldPos = chunk.getWorldPosition();
  mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
  return mesh;
}

/**
 * Dispose a standalone mesh.
 */
export function disposeMesh(mesh: THREE.Mesh, scene?: THREE.Scene): void {
  if (scene) scene.remove(mesh);
  mesh.geometry.dispose();
}
