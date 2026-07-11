/**
 * SeamStitcher — reconciles vertex normals across chunk-mesh seams.
 *
 * SurfaceNets meshes each chunk independently and accumulates per-vertex normals
 * from only that chunk's faces. Two chunks that share a boundary each generate a
 * coincident vertex at the same world position but with a different accumulated
 * normal (each sees only a 2-voxel neighbor margin), producing a visible shading
 * seam. This module matches those coincident boundary vertices and reconciles their
 * normals so shading is continuous across chunk and group boundaries.
 *
 * How it works:
 *  - The mesh worker tags each vertex with a 6-bit boundary-plane mask and emits
 *    per-face expanded-vertex index lists (SurfaceNet.ts / MeshGeometry.ts).
 *  - After a chunk's mesh is applied it is enqueued here; once per frame `flush()`
 *    matches each fresh chunk's boundary vertices against its 6 neighbors and either
 *    AVERAGEs the normals (both freshly meshed) or COPIES the fresh chunk's normals
 *    into a stale (already-present, not-remeshed) neighbor.
 *  - Matching is done in chunk-local voxel-grid units (positions / VOXEL_SCALE) on
 *    the two in-plane axes only — never float world space — so coincident vertices,
 *    which carry bit-identical positions, hash to the same key.
 *
 * De-indexed geometry: expandGeometry duplicates each vertex per face, so every
 * matched position maps to several expanded indices; the normal is written to all of
 * them on both sides.
 */

import { VOXEL_SCALE, chunkKey, parseChunkKey } from '@worldify/shared';
import { ChunkGeometry } from './ChunkGeometry.js';
import { LAYER_COUNT } from './LayerConfig.js';

/** Face indices in the boundary CSR: [lowX, highX, lowY, highY, lowZ, highZ]. */
const FACE_LOW_X = 0, FACE_HIGH_X = 1, FACE_LOW_Y = 2, FACE_HIGH_Y = 3, FACE_LOW_Z = 4, FACE_HIGH_Z = 5;

/** Grid-unit quantization: 1/16 voxel. Bit-identical seam positions round identically. */
const QUANT = 16;

/**
 * Per-direction seam descriptor: which face of THIS chunk meets which face of the
 * neighbor at `(dx,dy,dz)`, and whether it's a positive-axis direction (used to
 * process each fresh↔fresh pair exactly once).
 */
interface SeamDir {
  dx: number; dy: number; dz: number;
  thisFace: number; nbrFace: number;
  positive: boolean;
}

const SEAM_DIRS: SeamDir[] = [
  { dx: 1, dy: 0, dz: 0, thisFace: FACE_HIGH_X, nbrFace: FACE_LOW_X, positive: true },
  { dx: -1, dy: 0, dz: 0, thisFace: FACE_LOW_X, nbrFace: FACE_HIGH_X, positive: false },
  { dx: 0, dy: 1, dz: 0, thisFace: FACE_HIGH_Y, nbrFace: FACE_LOW_Y, positive: true },
  { dx: 0, dy: -1, dz: 0, thisFace: FACE_LOW_Y, nbrFace: FACE_HIGH_Y, positive: false },
  { dx: 0, dy: 0, dz: 1, thisFace: FACE_HIGH_Z, nbrFace: FACE_LOW_Z, positive: true },
  { dx: 0, dy: 0, dz: -1, thisFace: FACE_LOW_Z, nbrFace: FACE_HIGH_Z, positive: false },
];

/** Pack two quantized in-plane grid coords (each < 1024) into one integer key. */
function packKey(qa: number, qb: number): number {
  return (qa & 0x3ff) | ((qb & 0x3ff) << 10);
}

export class SeamStitcher {
  private pending = new Set<string>();

  /** Toggle (debug): when false, flush() does nothing — for A/B comparison. */
  enabled = true;
  /** When true, log per-flush match counts. */
  debug = false;

  constructor(
    private readonly geometries: Map<string, ChunkGeometry>,
    private readonly markGroupDirty: (chunkKey: string) => void,
  ) {}

  /** Queue a freshly-meshed chunk for seam reconciliation on the next flush. */
  enqueue(key: string): void {
    this.pending.add(key);
  }

  /**
   * Reconcile all queued chunks against their neighbors, then clear the queue.
   * Must run before the grouper re-bakes normals into merged buffers.
   */
  flush(): void {
    if (this.pending.size === 0) return;
    if (!this.enabled) { this.pending.clear(); return; }

    const fresh = this.pending;
    let seams = 0;
    let matched = 0;

    for (const key of fresh) {
      const thisGeo = this.geometries.get(key);
      if (!thisGeo || !thisGeo.hasGeometry()) continue;
      const { cx, cy, cz } = parseChunkKey(key);

      for (const dir of SEAM_DIRS) {
        const nbrKey = chunkKey(cx + dir.dx, cy + dir.dy, cz + dir.dz);
        const nbrGeo = this.geometries.get(nbrKey);
        if (!nbrGeo || !nbrGeo.hasGeometry()) continue;

        const nbrFresh = fresh.has(nbrKey);
        // Both fresh → AVERAGE, but process each unordered pair once (positive side).
        // Stale neighbor → COPY this chunk's seam normals into it (all directions).
        if (nbrFresh && !dir.positive) continue;

        seams++;
        const res = this.reconcileSeam(thisGeo, dir.thisFace, nbrGeo, dir.nbrFace, nbrFresh);
        matched += res.matched;
        // Only re-merge a group whose normals ACTUALLY changed. A remesh that leaves
        // the shared seam normals unchanged (the common case once a seam has settled)
        // no longer dirties both groups every time — cutting grouper rebuild churn.
        if (res.thisChanged) this.markGroupDirty(key);
        if (res.nbrChanged) this.markGroupDirty(nbrKey);
      }
    }

    if (this.debug) {
      console.log(`[SeamStitcher] fresh=${fresh.size} seams=${seams} matchedVerts=${matched}`);
    }
    this.pending.clear();
  }

  /**
   * Reconcile one seam between two chunk geometries across all layers.
   * @param average when true, average both sides' normals; otherwise copy `thisGeo`'s
   *                normal into `nbrGeo` (the stale side).
   * @returns matched-position count plus which side(s) had a normal actually change.
   */
  private reconcileSeam(
    thisGeo: ChunkGeometry,
    thisFace: number,
    nbrGeo: ChunkGeometry,
    nbrFace: number,
    average: boolean,
  ): { matched: number; thisChanged: boolean; nbrChanged: boolean } {
    const axis = thisFace >> 1;        // 0=X, 1=Y, 2=Z
    const a = (axis + 1) % 3;          // first in-plane axis
    const b = (axis + 2) % 3;          // second in-plane axis
    let matched = 0;
    let anyThis = false;
    let anyNbr = false;

    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const tB = thisGeo.getBoundary(layer);
      const nB = nbrGeo.getBoundary(layer);
      if (!tB || !nB) continue;

      const tStart = tB.faceOffsets[thisFace], tEnd = tB.faceOffsets[thisFace + 1];
      const nStart = nB.faceOffsets[nbrFace], nEnd = nB.faceOffsets[nbrFace + 1];
      if (tStart === tEnd || nStart === nEnd) continue;

      const tGeo = thisGeo.getLayerGeometry(layer);
      const nGeo = nbrGeo.getLayerGeometry(layer);
      if (!tGeo || !nGeo) continue;

      const tPos = tGeo.getAttribute('position').array as Float32Array;
      const tNrm = tGeo.getAttribute('normal').array as Float32Array;
      const nPos = nGeo.getAttribute('position').array as Float32Array;
      const nNrm = nGeo.getAttribute('normal').array as Float32Array;

      // Hash both sides' boundary-face vertices by in-plane grid position.
      const tMap = this.hashFace(tB.indices, tStart, tEnd, tPos, a, b);
      const nMap = this.hashFace(nB.indices, nStart, nEnd, nPos, a, b);

      let touchedThis = false;
      let touchedNbr = false;

      for (const [k, tIdxs] of tMap) {
        const nIdxs = nMap.get(k);
        if (!nIdxs) continue;
        matched++;

        const t0 = tIdxs[0] * 3;
        const n0 = nIdxs[0] * 3;

        if (average) {
          let x = tNrm[t0] + nNrm[n0];
          let y = tNrm[t0 + 1] + nNrm[n0 + 1];
          let z = tNrm[t0 + 2] + nNrm[n0 + 2];
          const len = Math.hypot(x, y, z);
          if (len > 1e-6) { x /= len; y /= len; z /= len; }
          else { x = tNrm[t0]; y = tNrm[t0 + 1]; z = tNrm[t0 + 2]; }
          // Write only the side(s) whose normal actually moved — skip no-op rewrites
          // of an already-settled seam so its group isn't needlessly re-merged.
          if (differs(tNrm, t0, x, y, z)) { writeNormal(tNrm, tIdxs, x, y, z); touchedThis = true; }
          if (differs(nNrm, n0, x, y, z)) { writeNormal(nNrm, nIdxs, x, y, z); touchedNbr = true; }
        } else {
          // Copy this chunk's normal into the stale neighbor's duplicates (if different).
          const x = tNrm[t0], y = tNrm[t0 + 1], z = tNrm[t0 + 2];
          if (differs(nNrm, n0, x, y, z)) { writeNormal(nNrm, nIdxs, x, y, z); touchedNbr = true; }
        }
      }

      if (touchedThis) { thisGeo.markNormalsNeedUpdate(layer); anyThis = true; }
      if (touchedNbr) { nbrGeo.markNormalsNeedUpdate(layer); anyNbr = true; }
    }

    return { matched, thisChanged: anyThis, nbrChanged: anyNbr };
  }

  /** Map in-plane grid key → list of expanded vertex indices for one boundary face. */
  private hashFace(
    faceIndices: Uint32Array,
    start: number,
    end: number,
    positions: Float32Array,
    a: number,
    b: number,
  ): Map<number, number[]> {
    const map = new Map<number, number[]>();
    for (let i = start; i < end; i++) {
      const vi = faceIndices[i];
      const base = vi * 3;
      const qa = Math.round((positions[base + a] / VOXEL_SCALE) * QUANT);
      const qb = Math.round((positions[base + b] / VOXEL_SCALE) * QUANT);
      const key = packKey(qa, qb);
      const list = map.get(key);
      if (list) list.push(vi);
      else map.set(key, [vi]);
    }
    return map;
  }
}

/** Normals within this per-component distance are treated as unchanged. */
const NORMAL_EPS = 1e-4;

/** True if the normal at `base` differs from (x,y,z) beyond NORMAL_EPS on any axis. */
function differs(normals: Float32Array, base: number, x: number, y: number, z: number): boolean {
  return Math.abs(normals[base] - x) > NORMAL_EPS
    || Math.abs(normals[base + 1] - y) > NORMAL_EPS
    || Math.abs(normals[base + 2] - z) > NORMAL_EPS;
}

/** Write a normal to every expanded vertex index in the list. */
function writeNormal(normals: Float32Array, idxs: number[], x: number, y: number, z: number): void {
  for (let i = 0; i < idxs.length; i++) {
    const o = idxs[i] * 3;
    normals[o] = x;
    normals[o + 1] = y;
    normals[o + 2] = z;
  }
}
