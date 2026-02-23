/**
 * ChunkGeometry - Manages geometry lifecycle for voxel chunks
 *
 * Each chunk has three geometry slots (solid, transparent, liquid).
 * Geometry is stored here but NOT added to the scene — ChunkGrouper owns
 * scene rendering via merged group meshes.
 *
 * Preview mesh management lives in BuildPreview, not here.
 */

import * as THREE from 'three';
import { Chunk } from './Chunk.js';
import { SurfaceNetOutput } from './SurfaceNet.js';
import type { SplitSurfaceNetOutput } from './SurfaceNet.js';
import { expandGeometry, createGeometryFromSurfaceNet, createBufferGeometry, type ExpandedMeshData } from './MeshGeometry.js';
import { createLayerMesh, LAYER_SOLID, LAYER_TRANSPARENT, LAYER_LIQUID, LAYER_COUNT } from './LayerConfig.js';

// Re-export for external consumers
export type { ExpandedMeshData } from './MeshGeometry.js';

// ============== ChunkGeometry Class ==============

/**
 * Container for a chunk's geometries (solid, transparent, liquid).
 * Uses a slot-based architecture — all three layers are managed identically.
 */
export class ChunkGeometry {
  /** Main meshes indexed by layer (used as geometry containers + for collision) */
  private mainMeshes: (THREE.Mesh | null)[] = [null, null, null];

  /** Cached geometry array returned by getGeometries() — avoids allocation per call */
  private cachedGeoArray: (THREE.BufferGeometry | null)[] = [null, null, null];

  /** The chunk this geometry represents */
  readonly chunk: Chunk;

  /** Whether the geometries have been disposed */
  disposed: boolean = false;

  /** Generation counter - increments each time geometry is updated */
  meshGeneration: number = 0;

  constructor(chunk: Chunk) {
    this.chunk = chunk;
  }

  // ============== Geometry Updates ==============

  /**
   * Create or update geometries from worker results (ExpandedMeshData).
   * Primary path — used by the async worker pipeline.
   */
  updateFromData(
    solid: ExpandedMeshData | null,
    transparent: ExpandedMeshData | null,
    liquid: ExpandedMeshData | null,
  ): void {
    this.updateAllSlots([solid, transparent, liquid]);
    this.disposed = false;
    this.meshGeneration++;
  }

  /**
   * Create or update geometries from SurfaceNetOutput (sync/fallback path).
   */
  updateFromSurfaceNet(output: SplitSurfaceNetOutput): void {
    this.updateAllSlots([
      toExpandedData(output.solid),
      toExpandedData(output.transparent),
      toExpandedData(output.liquid),
    ]);
    this.disposed = false;
    this.meshGeneration++;
  }

  // ============== Accessors ==============

  /**
   * Get per-layer geometries array for ChunkGrouper.
   * Eliminates the repeated solidMesh?.geometry ?? null pattern.
   */
  getGeometries(): (THREE.BufferGeometry | null)[] {
    this.cachedGeoArray[LAYER_SOLID] = this.mainMeshes[LAYER_SOLID]?.geometry ?? null;
    this.cachedGeoArray[LAYER_TRANSPARENT] = this.mainMeshes[LAYER_TRANSPARENT]?.geometry ?? null;
    this.cachedGeoArray[LAYER_LIQUID] = this.mainMeshes[LAYER_LIQUID]?.geometry ?? null;
    return this.cachedGeoArray;
  }

  /** Solid mesh (for collision detection / raycasting) */
  get solidMesh(): THREE.Mesh | null { return this.mainMeshes[LAYER_SOLID]; }

  /** Transparent mesh */
  get transparentMesh(): THREE.Mesh | null { return this.mainMeshes[LAYER_TRANSPARENT]; }

  /** Liquid mesh */
  get liquidMesh(): THREE.Mesh | null { return this.mainMeshes[LAYER_LIQUID]; }

  /** Get the solid mesh for collision/raycasting */
  getMesh(): THREE.Mesh | null { return this.mainMeshes[LAYER_SOLID]; }

  /** Check if any layer has geometry */
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

  /** Dispose all geometries */
  dispose(): void {
    for (let i = 0; i < this.mainMeshes.length; i++) {
      const m = this.mainMeshes[i];
      if (m) {
        m.geometry.dispose();
        this.mainMeshes[i] = null;
      }
    }
    this.disposed = true;
  }

  // ============== Private Helpers ==============

  /** Update all mesh slots from data array. */
  private updateAllSlots(data: [ExpandedMeshData | null, ExpandedMeshData | null, ExpandedMeshData | null]): void {
    const worldPos = this.chunk.getWorldPosition();

    for (let i = 0; i < LAYER_COUNT; i++) {
      this.mainMeshes[i] = this.updateSlot(this.mainMeshes[i], data[i], i, worldPos);
    }
  }

  /** Update a single mesh slot: reuse geometry swap or create/remove */
  private updateSlot(
    existing: THREE.Mesh | null,
    data: ExpandedMeshData | null,
    layer: number,
    worldPos: { x: number; y: number; z: number },
  ): THREE.Mesh | null {
    if (!data) {
      if (existing) {
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

    // Create new mesh (not added to scene — ChunkGrouper handles scene rendering)
    const mesh = createLayerMesh(newGeometry, layer, this.chunk.key);
    mesh.position.set(worldPos.x, worldPos.y, worldPos.z);
    mesh.userData.chunkCoords = { cx: this.chunk.cx, cy: this.chunk.cy, cz: this.chunk.cz };
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
