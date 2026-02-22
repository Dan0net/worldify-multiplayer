/**
 * TerrainBatch - Geometry merging for terrain draw-call reduction
 *
 * Instead of drawing each chunk as a separate mesh (hundreds of draw calls),
 * chunks are grouped into spatial buckets (GROUP_GRID³ chunks each) and their
 * geometries are merged into a single BufferGeometry per layer per group.
 *
 * Positions are baked to world space during the merge so the merged mesh sits
 * at the origin with an identity model matrix — no per-vertex transform needed.
 *
 * Shadow culling is applied per group based on the group center distance to
 * the player, using getShadowRadius() from QualityManager.
 */

import * as THREE from 'three';
import {
  getTerrainMaterial,
  getTransparentTerrainMaterial,
  getLiquidTerrainMaterial,
  getTransparentDepthMaterial,
} from './VoxelMaterials.js';
import { getShadowRadius } from '../quality/QualityManager.js';

// ---- Constants ----

/** Chunks per axis per spatial group */
const GROUP_GRID = 4;

/** Number of mesh layers (solid, transparent, liquid) */
const LAYER_COUNT = 3;

/** Growth factor when a merged buffer needs to be reallocated */
const BUFFER_GROWTH = 1.5;

/** Layer indices matching ChunkMesh convention */
const LAYER_SOLID = 0;
const LAYER_TRANSPARENT = 1;
const LAYER_LIQUID = 2;

// ---- Attribute layout ----

interface AttrDef {
  name: string;
  itemSize: number;
}

/** Vertex attributes to merge — must match MeshGeometry.createBufferGeometry */
const ATTRS: readonly AttrDef[] = [
  { name: 'position', itemSize: 3 },
  { name: 'normal', itemSize: 3 },
  { name: 'materialIds', itemSize: 3 },
  { name: 'materialWeights', itemSize: 3 },
  { name: 'lightLevel', itemSize: 1 },
];

// ---- Interfaces ----

interface ChunkSlot {
  cx: number;
  cy: number;
  cz: number;
  /** World-space origin of this chunk */
  wx: number;
  wy: number;
  wz: number;
  /** Per-layer geometry references (may be null if layer is empty) */
  geometries: (THREE.BufferGeometry | null)[];
  /** Whether this chunk is currently visible */
  visible: boolean;
  /** Key into the groups map */
  groupKey: string;
}

/** Tracks pre-allocated buffer capacity per layer so we can reuse them. */
interface LayerBuffers {
  vertexCapacity: number;
  indexCapacity: number;
}

interface MergedGroup {
  /** Per-layer merged meshes in the scene */
  meshes: (THREE.Mesh | null)[];
  /** Set of chunk keys belonging to this group */
  chunkKeys: Set<string>;
  /** Whether the group needs rebuilding */
  dirty: boolean;
  /** Center chunk coordinates (for shadow culling distance) */
  centerCx: number;
  centerCy: number;
  centerCz: number;
  /** Per-layer capacity tracking for buffer reuse */
  layerBuffers: (LayerBuffers | null)[];
}

// ---- Helpers ----

function groupKeyFromChunk(cx: number, cy: number, cz: number): string {
  const gx = Math.floor(cx / GROUP_GRID);
  const gy = Math.floor(cy / GROUP_GRID);
  const gz = Math.floor(cz / GROUP_GRID);
  return `${gx},${gy},${gz}`;
}

function groupCenter(gx: number, gy: number, gz: number): { cx: number; cy: number; cz: number } {
  return {
    cx: gx * GROUP_GRID + (GROUP_GRID >> 1),
    cy: gy * GROUP_GRID + (GROUP_GRID >> 1),
    cz: gz * GROUP_GRID + (GROUP_GRID >> 1),
  };
}

// ============================================================
// TerrainBatch
// ============================================================

export class TerrainBatch {
  private scene: THREE.Scene;
  private slots = new Map<string, ChunkSlot>();
  private groups = new Map<string, MergedGroup>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  // ---- Public API ----

  /**
   * Register or update a chunk's geometry references.
   * Called after ChunkMesh.updateMeshes / updateMeshesFromData.
   */
  updateChunk(
    key: string,
    cx: number,
    cy: number,
    cz: number,
    geometries: (THREE.BufferGeometry | null)[],
    worldPos: { x: number; y: number; z: number },
  ): void {
    const gk = groupKeyFromChunk(cx, cy, cz);

    let slot = this.slots.get(key);
    if (slot) {
      slot.geometries = geometries;
      const oldGk = slot.groupKey;
      if (oldGk !== gk) {
        this.removeFromGroup(key, oldGk);
        slot.groupKey = gk;
        slot.cx = cx;
        slot.cy = cy;
        slot.cz = cz;
        slot.wx = worldPos.x;
        slot.wy = worldPos.y;
        slot.wz = worldPos.z;
        this.addToGroup(key, gk, cx, cy, cz);
      }
    } else {
      slot = {
        cx,
        cy,
        cz,
        wx: worldPos.x,
        wy: worldPos.y,
        wz: worldPos.z,
        geometries,
        visible: true,
        groupKey: gk,
      };
      this.slots.set(key, slot);
      this.addToGroup(key, gk, cx, cy, cz);
    }

    this.markGroupDirty(gk);
  }

  /**
   * Set visibility for a chunk (called from updateMeshVisibility).
   * Marks the owning group dirty so it is rebuilt on the next rebuild() call.
   */
  setVisible(key: string, visible: boolean): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    if (slot.visible !== visible) {
      slot.visible = visible;
      this.markGroupDirty(slot.groupKey);
    }
  }

  /**
   * Remove a chunk (called from unloadChunk).
   */
  removeChunk(key: string): void {
    const slot = this.slots.get(key);
    if (!slot) return;
    const gk = slot.groupKey;
    this.slots.delete(key);
    this.removeFromGroup(key, gk);
    this.markGroupDirty(gk);

    // If group is now empty, dispose its scene meshes immediately
    const group = this.groups.get(gk);
    if (group && group.chunkKeys.size === 0) {
      this.disposeGroup(gk);
    }
  }

  /**
   * Rebuild all dirty groups. Call once per frame after updateMeshVisibility.
   */
  rebuild(playerCx: number, playerCy: number, playerCz: number): void {
    const shadowRadius = getShadowRadius();

    for (const [gk, group] of this.groups) {
      if (!group.dirty) continue;
      group.dirty = false;
      this.rebuildGroup(gk, group, playerCx, playerCy, playerCz, shadowRadius);
    }
  }

  /**
   * Dispose everything (called from VoxelWorld.dispose).
   */
  dispose(): void {
    for (const gk of this.groups.keys()) {
      this.disposeGroup(gk);
    }
    this.groups.clear();
    this.slots.clear();
  }

  // ---- Private: group bookkeeping ----

  private addToGroup(chunkKey: string, gk: string, _cx: number, _cy: number, _cz: number): void {
    let group = this.groups.get(gk);
    if (!group) {
      // Parse group coords from key to compute center
      const parts = gk.split(',');
      const gx = parseInt(parts[0], 10);
      const gy = parseInt(parts[1], 10);
      const gz = parseInt(parts[2], 10);
      const center = groupCenter(gx, gy, gz);

      group = {
        meshes: new Array<THREE.Mesh | null>(LAYER_COUNT).fill(null),
        chunkKeys: new Set(),
        dirty: true,
        centerCx: center.cx,
        centerCy: center.cy,
        centerCz: center.cz,
        layerBuffers: new Array<LayerBuffers | null>(LAYER_COUNT).fill(null),
      };
      this.groups.set(gk, group);
    }
    group.chunkKeys.add(chunkKey);
  }

  private removeFromGroup(chunkKey: string, gk: string): void {
    const group = this.groups.get(gk);
    if (group) group.chunkKeys.delete(chunkKey);
  }

  private markGroupDirty(gk: string): void {
    const group = this.groups.get(gk);
    if (group) group.dirty = true;
  }

  private disposeGroup(gk: string): void {
    const group = this.groups.get(gk);
    if (!group) return;
    for (let i = 0; i < LAYER_COUNT; i++) {
      const m = group.meshes[i];
      if (m) {
        this.scene.remove(m);
        m.geometry.dispose();
        group.meshes[i] = null;
      }
      group.layerBuffers[i] = null;
    }
    this.groups.delete(gk);
  }

  // ---- Private: merge & rebuild ----

  private rebuildGroup(
    _gk: string,
    group: MergedGroup,
    playerCx: number,
    playerCy: number,
    playerCz: number,
    shadowRadius: number,
  ): void {
    // Collect visible chunk slots for this group
    const visibleSlots: ChunkSlot[] = [];
    for (const ck of group.chunkKeys) {
      const slot = this.slots.get(ck);
      if (slot && slot.visible) visibleSlots.push(slot);
    }

    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      // Gather non-empty geometries for this layer
      const geos: { geo: THREE.BufferGeometry; wx: number; wy: number; wz: number }[] = [];
      for (const slot of visibleSlots) {
        const geo = slot.geometries[layer];
        if (geo && geo.index && geo.index.count > 0) {
          geos.push({ geo, wx: slot.wx, wy: slot.wy, wz: slot.wz });
        }
      }

      const existing = group.meshes[layer];

      if (geos.length === 0) {
        // Nothing to render for this layer — hide mesh but keep buffers for reuse
        if (existing) {
          existing.visible = false;
        }
        continue;
      }

      // Count totals
      let totalVerts = 0;
      let totalIndices = 0;
      for (const { geo } of geos) {
        totalVerts += geo.getAttribute('position').count;
        totalIndices += geo.index!.count;
      }

      // Determine if we can reuse existing GPU buffers (avoids allocation + GC)
      const lb = group.layerBuffers[layer];
      const canReuse = !!(existing && lb &&
        totalVerts <= lb.vertexCapacity &&
        totalIndices <= lb.indexCapacity);

      let merged: THREE.BufferGeometry;

      if (canReuse) {
        // Fast path: write into existing geometry's typed arrays
        merged = existing!.geometry;
      } else {
        // Slow path: allocate new buffers (with growth headroom on re-alloc)
        const vertCap = lb ? Math.ceil(totalVerts * BUFFER_GROWTH) : totalVerts;
        const idxCap = lb ? Math.ceil(totalIndices * BUFFER_GROWTH) : totalIndices;

        merged = new THREE.BufferGeometry();
        for (const attr of ATTRS) {
          merged.setAttribute(
            attr.name,
            new THREE.BufferAttribute(new Float32Array(vertCap * attr.itemSize), attr.itemSize),
          );
        }
        merged.setIndex(new THREE.BufferAttribute(new Uint32Array(idxCap), 1));

        group.layerBuffers[layer] = { vertexCapacity: vertCap, indexCapacity: idxCap };
      }

      // ---- Fill attribute data (shared by both paths) ----

      for (const attr of ATTRS) {
        const dstAttr = merged.getAttribute(attr.name) as THREE.BufferAttribute;
        const arr = dstAttr.array as Float32Array;
        let vertOffset = 0;

        if (attr.name === 'position') {
          // Bake positions into world space
          for (const { geo, wx, wy, wz } of geos) {
            const srcAttr = geo.getAttribute(attr.name) as THREE.BufferAttribute | undefined;
            if (!srcAttr) continue;
            const srcArr = srcAttr.array as Float32Array;
            for (let v = 0; v < srcAttr.count; v++) {
              const sBase = v * 3;
              const dBase = (vertOffset + v) * 3;
              arr[dBase] = srcArr[sBase] + wx;
              arr[dBase + 1] = srcArr[sBase + 1] + wy;
              arr[dBase + 2] = srcArr[sBase + 2] + wz;
            }
            vertOffset += srcAttr.count;
          }
        } else {
          for (const { geo } of geos) {
            const srcAttr = geo.getAttribute(attr.name) as THREE.BufferAttribute | undefined;
            if (!srcAttr) continue;
            arr.set(srcAttr.array as Float32Array, vertOffset * attr.itemSize);
            vertOffset += srcAttr.count;
          }
        }

        // Only upload the used portion to the GPU (not the over-allocated tail)
        dstAttr.updateRange.offset = 0;
        dstAttr.updateRange.count = totalVerts * attr.itemSize;
        dstAttr.needsUpdate = true;
      }

      // ---- Fill index buffer ----

      const idxAttr = merged.index!;
      const indices = idxAttr.array as Uint32Array;
      let idxOffset = 0;
      let vertBase = 0;
      for (const { geo } of geos) {
        const srcIdx = geo.index!;
        const srcArr = srcIdx.array;
        for (let i = 0; i < srcIdx.count; i++) {
          indices[idxOffset + i] = srcArr[i] + vertBase;
        }
        idxOffset += srcIdx.count;
        vertBase += geo.getAttribute('position').count;
      }
      idxAttr.updateRange.offset = 0;
      idxAttr.updateRange.count = totalIndices;
      idxAttr.needsUpdate = true;
      merged.setDrawRange(0, totalIndices);

      // ---- Attach geometry to mesh if new allocation ----

      if (!canReuse) {
        if (existing) {
          const old = existing.geometry;
          existing.geometry = merged;
          old.dispose();
          existing.visible = true;
        } else {
          const mesh = this.createLayerMesh(merged, layer);
          mesh.position.set(0, 0, 0); // World-space positions baked in
          this.scene.add(mesh);
          group.meshes[layer] = mesh;
        }
      } else {
        existing!.visible = true;
      }

      // Shadow distance culling per group
      const mesh = group.meshes[layer]!;
      const dx = Math.abs(group.centerCx - playerCx);
      const dy = Math.abs(group.centerCy - playerCy);
      const dz = Math.abs(group.centerCz - playerCz);
      const inShadow = dx <= shadowRadius && dy <= shadowRadius && dz <= shadowRadius;
      // Liquid layer never casts shadows
      mesh.castShadow = layer !== LAYER_LIQUID && inShadow;
    }
  }

  /** Create a Three.js mesh for a specific layer with appropriate material/settings */
  private createLayerMesh(geometry: THREE.BufferGeometry, layer: number): THREE.Mesh {
    let material: THREE.Material;
    let castShadow = true;
    let receiveShadow = true;
    let renderOrder = 0;
    let customDepthMaterial: THREE.Material | undefined;

    switch (layer) {
      case LAYER_SOLID:
        material = getTerrainMaterial();
        break;
      case LAYER_TRANSPARENT:
        material = getTransparentTerrainMaterial();
        renderOrder = 1;
        customDepthMaterial = getTransparentDepthMaterial();
        break;
      case LAYER_LIQUID:
        material = getLiquidTerrainMaterial();
        castShadow = false;
        renderOrder = 2;
        break;
      default:
        material = getTerrainMaterial();
    }

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    mesh.renderOrder = renderOrder;
    if (customDepthMaterial) mesh.customDepthMaterial = customDepthMaterial;
    // Merged groups span many chunks — disable per-mesh frustum culling
    mesh.frustumCulled = false;
    return mesh;
  }
}
