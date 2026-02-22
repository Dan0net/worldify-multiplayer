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
import { getTerrainMaterial, getTransparentTerrainMaterial, getLiquidTerrainMaterial, getTransparentDepthMaterial } from './VoxelMaterials.js';
import { expandGeometry, createGeometryFromSurfaceNet, createBufferGeometry, type ExpandedMeshData } from './MeshGeometry.js';

// Re-export for external consumers
export type { ExpandedMeshData } from './MeshGeometry.js';

// ============== Mesh Layer Configuration ==============

/** Identifies a mesh rendering layer */
const enum MeshLayer {
  SOLID = 0,
  TRANSPARENT = 1,
  LIQUID = 2,
}

/** Configuration for each mesh layer */
interface MeshLayerConfig {
  material: () => THREE.Material;
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  customDepthMaterial?: () => THREE.Material;
  meshType: string;
}

const LAYER_CONFIGS: readonly MeshLayerConfig[] = [
  { // SOLID
    material: getTerrainMaterial,
    castShadow: true,
    receiveShadow: true,
    renderOrder: 0,
    meshType: 'solid',
  },
  { // TRANSPARENT
    material: getTransparentTerrainMaterial,
    castShadow: true,
    receiveShadow: true,
    renderOrder: 1,
    customDepthMaterial: getTransparentDepthMaterial,
    meshType: 'transparent',
  },
  { // LIQUID
    material: getLiquidTerrainMaterial,
    castShadow: false,
    receiveShadow: true,
    renderOrder: 2,
    meshType: 'liquid',
  },
];

const LAYER_COUNT = 3;

/** Create a Three.js mesh for a given layer */
function createLayerMesh(geometry: THREE.BufferGeometry, chunkKey: string, layer: MeshLayer): THREE.Mesh {
  const config = LAYER_CONFIGS[layer];
  const mesh = new THREE.Mesh(geometry, config.material());
  mesh.userData.chunkKey = chunkKey;
  mesh.userData.meshType = config.meshType;
  mesh.castShadow = config.castShadow;
  mesh.receiveShadow = config.receiveShadow;
  mesh.renderOrder = config.renderOrder;
  if (config.customDepthMaterial) {
    mesh.customDepthMaterial = config.customDepthMaterial();
  }
  return mesh;
}

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
      const mesh = createLayerMesh(geometry, this.chunk.key, i as MeshLayer);
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
  get solidMesh(): THREE.Mesh | null { return this.mainMeshes[MeshLayer.SOLID]; }

  /** Transparent mesh */
  get transparentMesh(): THREE.Mesh | null { return this.mainMeshes[MeshLayer.TRANSPARENT]; }

  /** Liquid mesh */
  get liquidMesh(): THREE.Mesh | null { return this.mainMeshes[MeshLayer.LIQUID]; }

  /** Get the solid mesh for collision/raycasting */
  getMesh(): THREE.Mesh | null { return this.mainMeshes[MeshLayer.SOLID]; }

  /** Get all non-null main meshes */
  getAllMeshes(): THREE.Mesh[] {
    return this.mainMeshes.filter((m): m is THREE.Mesh => m !== null);
  }

  /** Check if any mesh layer has geometry */
  hasGeometry(): boolean {
    return !this.disposed && this.mainMeshes.some(m => m !== null);
  }

  // ============== Visibility / Shadows ==============

  /** Set visibility of main meshes (preview meshes unaffected) */
  setVisible(visible: boolean): void {
    const effective = visible && !this.previewActive;
    for (let i = 0; i < LAYER_COUNT; i++) {
      if (this.mainMeshes[i]) this.mainMeshes[i]!.visible = effective;
    }
  }

  /** Toggle castShadow on solid and transparent meshes (shadow distance culling) */
  setShadowCasting(enabled: boolean): void {
    if (this.mainMeshes[MeshLayer.SOLID]) this.mainMeshes[MeshLayer.SOLID]!.castShadow = enabled;
    if (this.mainMeshes[MeshLayer.TRANSPARENT]) this.mainMeshes[MeshLayer.TRANSPARENT]!.castShadow = enabled;
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

  // ============== Legacy Aliases (keep callers compiling) ==============

  /** @deprecated Use disposeMeshes() */
  disposeMesh(scene?: THREE.Scene): void { this.disposeMeshes(scene); }

  /** @deprecated Use solidMesh getter */
  get mesh(): THREE.Mesh | null { return this.solidMesh; }

  /**
   * @deprecated Use updateMeshes() with SplitSurfaceNetOutput
   * Handles both single SurfaceNetOutput and split output for backward compat.
   */
  updateMesh(output: SurfaceNetOutput | SplitSurfaceNetOutput, scene?: THREE.Scene): void {
    if ('solid' in output) {
      this.updateMeshes(output, scene);
    } else {
      // Single SurfaceNetOutput → solid-only
      this.disposePreviewMeshes(scene);
      this.previewActive = false;
      this.updateAllSlots(this.mainMeshes, [toExpandedData(output), null, null], scene);
      this.disposed = false;
      this.meshGeneration++;
    }
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
      meshArray[i] = this.updateSlot(meshArray[i], data[i], i as MeshLayer, worldPos, chunkCoords, scene);
    }
  }

  /** Update a single mesh slot: reuse geometry swap or create/remove */
  private updateSlot(
    existing: THREE.Mesh | null,
    data: ExpandedMeshData | null,
    layer: MeshLayer,
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

    const mesh = createLayerMesh(newGeometry, this.chunk.key, layer);
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
  const mesh = createLayerMesh(geometry, chunk.key, MeshLayer.SOLID);
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
