/**
 * Integration: a BUILDING_TOWER is actually placed by the real generation pipeline and,
 * because it is taller than one chunk, is written correctly ACROSS vertical chunk boundaries.
 *
 * This is the property that isn't obvious from the stamp geometry alone: stamps are applied
 * per (cx,cy,cz) chunk and each chunk keeps only the stamp voxels whose global Y lands inside
 * it. A tall tower therefore relies on the same placement being returned for several stacked
 * chunks and each chunk drawing its own horizontal slice. We drive the real generator and
 * diff a stamps-on world against a stamps-off world (same seed) to isolate the tower's voxels.
 */

import { describe, it, expect } from 'vitest';
import {
  TerrainGenerator,
  StampType,
  CHUNK_SIZE,
  VOXEL_SCALE,
  getWeight,
  type StampPlacement,
} from '../index.js';

const SEED = 4242;
const isSolid = (packed: number) => getWeight(packed) > 0;

describe('BUILDING_TOWER placement across vertical chunks', () => {
  it('places a tower and writes its full height across stacked chunks, with a carved interior', () => {
    const genOn = new TerrainGenerator({ seed: SEED, enableStamps: true });
    const genOff = new TerrainGenerator({ seed: SEED, enableStamps: false });
    const spg = (genOn as unknown as {
      stampPointGenerator: { generateForChunk(cx: number, cz: number): StampPlacement[] };
    }).stampPointGenerator;

    // ---- find the first tower origin the distribution actually emits (off a pathway) ----
    let tower: StampPlacement | null = null;
    search:
    for (let cz = 0; cz < 40 && !tower; cz++) {
      for (let cx = 0; cx < 40; cx++) {
        for (const p of spg.generateForChunk(cx, cz)) {
          if (p.type !== StampType.BUILDING_TOWER) continue;
          if (genOn.isOnPathway(p.worldX, p.worldZ)) continue;
          tower = p;
          break search;
        }
      }
    }
    expect(tower, 'expected the distribution to place a BUILDING_TOWER in the search region').not.toBeNull();

    const originVX = Math.floor(tower!.worldX / VOXEL_SCALE);
    const originVZ = Math.floor(tower!.worldZ / VOXEL_SCALE);
    const terrainH = Math.floor(genOn.sampleHeight(tower!.worldX, tower!.worldZ));

    // ---- diff stamps-on vs stamps-off within the tower's footprint over the full column ----
    // Nothing else is placed within the tower's 25 m exclusion radius, so a ±20-voxel window
    // around the origin isolates the tower cleanly from other stamps.
    const FOOTPRINT = 20;
    const ocx = Math.floor(originVX / CHUNK_SIZE);
    const ocz = Math.floor(originVZ / CHUNK_SIZE);
    const cyLo = Math.floor((terrainH - 4) / CHUNK_SIZE);
    const cyHi = Math.floor((terrainH + 84) / CHUNK_SIZE); // covers a max-height (~4-floor) tower

    const addedCys = new Set<number>();
    let addedMinY = Infinity;
    let addedMaxY = -Infinity;
    let carvedCount = 0;

    for (let cy = cyLo; cy <= cyHi; cy++) {
      for (let dcz = -1; dcz <= 1; dcz++) {
        for (let dcx = -1; dcx <= 1; dcx++) {
          const cX = ocx + dcx, cZ = ocz + dcz;
          const on = genOn.generateChunk(cX, cy, cZ);
          const off = genOff.generateChunk(cX, cy, cZ);
          for (let lz = 0; lz < CHUNK_SIZE; lz++) {
            const gz = cZ * CHUNK_SIZE + lz;
            if (Math.abs(gz - originVZ) > FOOTPRINT) continue;
            for (let lx = 0; lx < CHUNK_SIZE; lx++) {
              const gx = cX * CHUNK_SIZE + lx;
              if (Math.abs(gx - originVX) > FOOTPRINT) continue;
              for (let ly = 0; ly < CHUNK_SIZE; ly++) {
                const idx = lx + ly * CHUNK_SIZE + lz * CHUNK_SIZE * CHUNK_SIZE;
                const onSolid = isSolid(on[idx]);
                const offSolid = isSolid(off[idx]);
                if (onSolid && !offSolid) {
                  addedCys.add(cy);
                  const gy = cy * CHUNK_SIZE + ly;
                  addedMinY = Math.min(addedMinY, gy);
                  addedMaxY = Math.max(addedMaxY, gy);
                } else if (!onSolid && offSolid) {
                  carvedCount++; // doorway / entrance dig-out / interior carve into terrain
                }
              }
            }
          }
        }
      }
    }

    // The tower is written into at least two stacked chunks (it is taller than one 32-voxel chunk).
    expect(addedCys.size).toBeGreaterThanOrEqual(2);

    // Its solid voxels span a tall vertical range (multiple floors + roof), not a squat footprint.
    expect(addedMaxY - addedMinY).toBeGreaterThanOrEqual(30);

    // The base is carved into the terrain (doorway / hollowed interior), i.e. it is enterable.
    expect(carvedCount).toBeGreaterThan(0);
  }, 30_000);
});
