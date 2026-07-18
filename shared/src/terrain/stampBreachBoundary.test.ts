/**
 * Regression: terrain stamps must be suppressed over cave breaches CONSISTENTLY across chunk
 * boundaries.
 *
 * A stamp (tree / rock / building) is anchored at a single origin column. If that column is where a
 * worm or cavern breaches the surface, the whole stamp is dropped so nothing is left floating over the
 * open cave mouth. Stamps are larger than one voxel, so a stamp anchored near a chunk edge overhangs
 * into neighbouring chunks — and each chunk decides independently whether to draw its slice.
 *
 * The bug: the breach test consulted the CURRENT chunk's breach set and returned false whenever the
 * stamp's origin lay in a different (neighbouring) tile. So the origin chunk correctly suppressed the
 * stamp, but the neighbour chunk it overhung into did not — the overhang was drawn, floating over the
 * open cave mouth. The fix makes the breach test a pure function of the stamp's world origin (resolving
 * the tile that OWNS that origin column), so every chunk the stamp touches makes the same decision.
 *
 * This test drives the real generator (no reaching into breach internals): it finds a stamp the
 * generator genuinely breach-suppresses at its origin (present in a no-caves world, absent once caves
 * carve a breach under it) and that overhangs a chunk boundary, then asserts the overhang is absent
 * from the neighbour chunk too. Pre-fix the neighbour leaked dozens of solid overhang voxels here.
 */

import { describe, it, expect } from 'vitest';
import {
  TerrainGenerator,
  DEFAULT_CAVE_CONFIG,
  getStamp,
  getWeight,
  CHUNK_SIZE,
  VOXEL_SCALE,
  type StampPlacement,
} from '../index.js';

const caveConfig = { ...DEFAULT_CAVE_CONFIG, wormsEnabled: true, cavernsEnabled: true };
const SEED = 1234;

const isSolid = (packed: number) => getWeight(packed) > 0;

describe('stamp breach suppression across chunk boundaries', () => {
  it('drops a boundary-spanning stamp in the neighbour chunk it overhangs, not just its origin tile', () => {
    // Three worlds, same seed. Only stamps/caves differ, so per-voxel diffs are unambiguous:
    //   genOn      – stamps on,  caves on  (the real world)
    //   genOff     – stamps off, caves on  (terrain+caves baseline → isolates stamp voxels in genOn)
    //   genNoCaves – stamps on,  caves off (no breaches → every stamp placed → ground-truth footprint)
    const genOn = new TerrainGenerator({ seed: SEED, enableStamps: true, caveConfig });
    const genOff = new TerrainGenerator({ seed: SEED, enableStamps: false, caveConfig });
    const genNoCaves = new TerrainGenerator({
      seed: SEED,
      enableStamps: true,
      caveConfig: { ...caveConfig, wormsEnabled: false, cavernsEnabled: false },
    });
    // Stamp placement is identical across all three (it never depends on caves).
    const spg = (genOn as unknown as { stampPointGenerator: { generateForChunk(cx: number, cz: number): StampPlacement[] } })
      .stampPointGenerator;

    // ---- memoised generators (cave carving is the expensive part; never generate a chunk twice) ----
    const chunkMemo = new Map<string, Uint32Array>();
    const chunk = (g: TerrainGenerator, tag: string, cx: number, cy: number, cz: number) => {
      const key = tag + ':' + cx + ',' + cy + ',' + cz;
      let d = chunkMemo.get(key);
      if (!d) { d = g.generateChunk(cx, cy, cz); chunkMemo.set(key, d); }
      return d;
    };
    const pointsMemo = new Map<string, StampPlacement[]>();
    const points = (cx: number, cz: number) => {
      const key = cx + ',' + cz;
      let v = pointsMemo.get(key);
      if (!v) { v = spg.generateForChunk(cx, cz); pointsMemo.set(key, v); }
      return v;
    };

    const solidColumnOffsets = (p: StampPlacement): Array<[number, number]> => {
      const seen = new Set<string>();
      const out: Array<[number, number]> = [];
      for (const v of getStamp(p.type, p.variant, p.rotation).voxels) {
        if (v.weight <= 0) continue;
        const k = v.x + ',' + v.z;
        if (!seen.has(k)) { seen.add(k); out.push([v.x, v.z]); }
      }
      return out;
    };

    // Cheap breach pre-filter: in the stamps-off world, is terrain that should be solid just below the
    // surface carved to air at this column? That is exactly a cave breaking the surface here.
    const breachedAtOrigin = (worldX: number, worldZ: number): boolean => {
      const vx = Math.floor(worldX / VOXEL_SCALE), vz = Math.floor(worldZ / VOXEL_SCALE);
      const ocx = Math.floor(vx / CHUNK_SIZE), ocz = Math.floor(vz / CHUNK_SIZE);
      const sh = Math.floor(genOff.sampleHeight(worldX, worldZ));
      for (let wy = sh - 1; wy >= sh - 3; wy--) {                 // 3 voxels below surface = solid ground…
        const cy = Math.floor(wy / CHUNK_SIZE);
        const off = chunk(genOff, 'off', ocx, cy, ocz);
        const idx = (vx - ocx * CHUNK_SIZE) + (wy - cy * CHUNK_SIZE) * CHUNK_SIZE + (vz - ocz * CHUNK_SIZE) * CHUNK_SIZE * CHUNK_SIZE;
        if (!isSolid(off[idx])) return true;                     // …unless a cave carved it → breach
      }
      return false;
    };

    // Target-only solid columns of p inside tile (tcx,tcz): columns p fills that no OTHER placement
    // offered to that tile also covers — so an on/off diff there is unambiguously p's.
    const targetOnlyCols = (p: StampPlacement, tcx: number, tcz: number): Array<[number, number]> => {
      const vx = Math.floor(p.worldX / VOXEL_SCALE), vz = Math.floor(p.worldZ / VOXEL_SCALE);
      const others = points(tcx, tcz)
        .filter((q) => !(q.worldX === p.worldX && q.worldZ === p.worldZ))
        .map((q) => ({ qx: Math.floor(q.worldX / VOXEL_SCALE), qz: Math.floor(q.worldZ / VOXEL_SCALE), b: getStamp(q.type, q.variant, q.rotation).bounds }));
      const covered = (wx: number, wz: number) =>
        others.some((o) => wx >= o.qx + o.b.minX && wx <= o.qx + o.b.maxX && wz >= o.qz + o.b.minZ && wz <= o.qz + o.b.maxZ);
      const out: Array<[number, number]> = [];
      for (const [dx, dz] of solidColumnOffsets(p)) {
        const wx = vx + dx, wz = vz + dz;
        if (Math.floor(wx / CHUNK_SIZE) === tcx && Math.floor(wz / CHUNK_SIZE) === tcz && !covered(wx, wz)) {
          out.push([wx - tcx * CHUNK_SIZE, wz - tcz * CHUNK_SIZE]);
        }
      }
      return out;
    };

    // Count voxels turned air→solid by adding stamps, within tile (tcx,tcz), over the stamp's own
    // vertical band, restricted to `cols`. `add` has the stamp; `base` is the stamps-absent reference.
    const stampSolids = (
      p: StampPlacement, cols: Array<[number, number]>, tcx: number, tcz: number,
      addG: TerrainGenerator, addTag: string, baseG: TerrainGenerator, baseTag: string,
    ): number => {
      const b = getStamp(p.type, p.variant, p.rotation).bounds;
      const sh = Math.floor(genOn.sampleHeight(p.worldX, p.worldZ)) + (p.yOffset ?? 0);
      const cyLo = Math.floor((sh + b.minY - 1) / CHUNK_SIZE);
      const cyHi = Math.floor((sh + b.maxY + 1) / CHUNK_SIZE);
      let n = 0;
      for (let cy = cyLo; cy <= cyHi; cy++) {
        const add = chunk(addG, addTag, tcx, cy, tcz);
        const base = chunk(baseG, baseTag, tcx, cy, tcz);
        for (const [lx, lz] of cols) {
          for (let ly = 0; ly < CHUNK_SIZE; ly++) {
            const idx = lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE;
            if (isSolid(add[idx]) && !isSolid(base[idx])) n++;
          }
        }
      }
      return n;
    };

    // ---- find the scenario deterministically ----
    let sc: { p: StampPlacement; ocx: number; ocz: number; ncx: number; ncz: number; oCols: Array<[number, number]>; nCols: Array<[number, number]> } | null = null;
    const R = 8;
    search:
    for (let cz = 0; cz < R; cz++) {
      for (let cx = 0; cx < R; cx++) {
        for (const p of points(cx, cz)) {
          const vx = Math.floor(p.worldX / VOXEL_SCALE), vz = Math.floor(p.worldZ / VOXEL_SCALE);
          const ocx = Math.floor(vx / CHUNK_SIZE), ocz = Math.floor(vz / CHUNK_SIZE);
          if (ocx !== cx || ocz !== cz) continue;                       // count each origin once
          if (genOn.isOnPathway(p.worldX, p.worldZ)) continue;          // isolate breach (not path) suppression

          // Must overhang another tile: some solid column lands outside the origin tile.
          let ncx = ocx, ncz = ocz;
          for (const [dx, dz] of solidColumnOffsets(p)) {
            const tcx = Math.floor((vx + dx) / CHUNK_SIZE), tcz = Math.floor((vz + dz) / CHUNK_SIZE);
            if (tcx !== ocx || tcz !== ocz) { ncx = tcx; ncz = tcz; break; }
          }
          if (ncx === ocx && ncz === ocz) continue;

          if (!breachedAtOrigin(p.worldX, p.worldZ)) continue;          // cheap pre-filter
          const oCols = targetOnlyCols(p, ocx, ocz);
          const nCols = targetOnlyCols(p, ncx, ncz);
          if (oCols.length === 0 || nCols.length === 0) continue;       // need clean columns both sides

          // Confirm the generator really SUPPRESSES it at the origin once caves are on.
          if (stampSolids(p, oCols, ocx, ocz, genOn, 'on', genOff, 'off') !== 0) continue;

          sc = { p, ocx, ocz, ncx, ncz, oCols, nCols };
          break search;
        }
      }
    }

    expect(sc, 'expected a breach-suppressed, boundary-spanning stamp in the search region').not.toBeNull();
    const { p, ncx, ncz, nCols } = sc!;

    // Ground truth: with caves OFF (no breach) the stamp IS placed and fills the neighbour columns —
    // so asserting they are empty with caves on is a real suppression, not a vacuous "nothing here".
    expect(stampSolids(p, nCols, ncx, ncz, genNoCaves, 'nc', genOff, 'off')).toBeGreaterThan(0);

    // The regression: the overhang the generator suppressed at the origin must be gone in the
    // neighbour too. Pre-fix this was dozens of leaked solid voxels; post-fix it is zero.
    expect(stampSolids(p, nCols, ncx, ncz, genOn, 'on', genOff, 'off')).toBe(0);
  }, 30_000);
});
