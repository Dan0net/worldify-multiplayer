/**
 * Monotonic-direction rule test for the visibility BFS (P6 / Win 2).
 *
 * The BFS culls chunks that are reachable through connected openings but only via a path that DOUBLES
 * BACK on an axis — you couldn't have seen them in a straight line from the camera. This locks that
 * in with a small hand-built visibility graph: an opaque chunk blocks the straight +X corridor, so
 * the only route to the chunk behind it is up-and-over, whose final step reverses Y. The rule must
 * cull that chunk while still admitting the up-and-over chunks themselves.
 */

import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { VISIBILITY_ALL, VISIBILITY_NONE, chunkKey } from '@worldify/shared';
import { getVisibleChunks, type ChunkProvider } from './VisibilityBFS.js';

/**
 * Minimal chunk stand-in — the BFS only reads visibilityBits.
 * `emptyAir` marks positions that are genuine open sky (traversable void); everything else missing
 * from `vis` is treated as unloaded terrain (requested, not traversed).
 */
function makeProvider(vis: Map<string, number>, emptyAir?: (cx: number, cy: number, cz: number) => boolean): ChunkProvider {
  return {
    getChunkByKey: (key: string) => (vis.has(key) ? ({ visibilityBits: vis.get(key)! } as any) : undefined),
    isPending: () => false,
    isEmptyAir: (cx, cy, cz) => emptyAir?.(cx, cy, cz) ?? false,
  };
}

describe('visibility BFS monotonic-direction rule', () => {
  it('culls a chunk reachable only by doubling back around an occluder', () => {
    // Fill a small region with fully-transparent chunks, then make (1,0,0) a solid occluder so the
    // straight +X path to (2,0,0) is blocked. The only remaining route to (2,0,0) is
    // (0,0,0)→(0,1,0)→(1,1,0)→(2,1,0)→(2,0,0); that last −Y step reverses the +Y already travelled.
    const vis = new Map<string, number>();
    for (let z = -3; z <= 3; z++)
      for (let y = -3; y <= 3; y++)
        for (let x = -3; x <= 3; x++)
          vis.set(chunkKey(x, y, z), VISIBILITY_ALL);
    vis.set(chunkKey(1, 0, 0), VISIBILITY_NONE); // opaque wall on the straight corridor

    const provider = makeProvider(vis);
    const { reachable } = getVisibleChunks(
      { cx: 0, cy: 0, cz: 0 },
      new THREE.Vector3(0, 0, 1),
      new THREE.Frustum(),
      provider,
      6, // generous radius so distance never limits the case
    );

    // Sanity: the camera chunk and its open neighbours are reachable.
    expect(reachable.has(chunkKey(0, 0, 0))).toBe(true);
    expect(reachable.has(chunkKey(0, 1, 0))).toBe(true);
    // The up-and-over chunks are reachable via a monotonic (+Y then +X) path.
    expect(reachable.has(chunkKey(1, 1, 0))).toBe(true);
    expect(reachable.has(chunkKey(2, 1, 0))).toBe(true);
    // The opaque wall itself is reached (visible) but is a dead end (no traversal through it).
    expect(reachable.has(chunkKey(1, 0, 0))).toBe(true);

    // The payoff: (2,0,0) sits directly behind the wall. Every route to it either goes straight
    // through the opaque wall (blocked) or doubles back on an axis (culled), so it must NOT render.
    expect(reachable.has(chunkKey(2, 0, 0))).toBe(false);
    // Likewise (3,0,0), further behind the wall on the same blocked axis.
    expect(reachable.has(chunkKey(3, 0, 0))).toBe(false);
  });

  it('still reaches straight-line neighbours in every axis direction from the camera', () => {
    // All-transparent: the camera seeds all 6 faces, so each axis arm expands monotonically outward.
    const vis = new Map<string, number>();
    for (let z = -3; z <= 3; z++)
      for (let y = -3; y <= 3; y++)
        for (let x = -3; x <= 3; x++)
          vis.set(chunkKey(x, y, z), VISIBILITY_ALL);

    const { reachable } = getVisibleChunks(
      { cx: 0, cy: 0, cz: 0 },
      new THREE.Vector3(0, 0, 1),
      new THREE.Frustum(),
      makeProvider(vis),
      4,
    );

    // Straight arms out to the radius in all six directions are still selected (no over-culling).
    for (const [x, y, z] of [
      [3, 0, 0], [-3, 0, 0], [0, 3, 0], [0, -3, 0], [0, 0, 3], [0, 0, -3],
    ] as const) {
      expect(reachable.has(chunkKey(x, y, z))).toBe(true);
    }
  });
});

describe('visibility BFS empty-air vs unloaded-terrain traversal', () => {
  it('traverses through genuine open sky to reach the terrain beyond (spawned high above)', () => {
    // Player is high in the air at the origin. The only loaded chunk is the ground 3 below. The
    // chunks between are open sky (isEmptyAir). The BFS must fall through the sky and reach the
    // ground — the fix for "jump into an empty chunk → everything vanishes".
    const vis = new Map<string, number>();
    vis.set(chunkKey(0, -3, 0), VISIBILITY_ALL); // the ground, loaded
    const isEmptyAir = (_cx: number, cy: number) => cy > -3; // everything above the ground is sky

    const { reachable } = getVisibleChunks(
      { cx: 0, cy: 0, cz: 0 },
      new THREE.Vector3(0, -1, 0),
      new THREE.Frustum(),
      makeProvider(vis, isEmptyAir),
      6,
    );

    expect(reachable.has(chunkKey(0, -3, 0))).toBe(true);   // reached the ground through the void
    // Terrain BELOW the ground is unloaded (not sky) and behind the loaded chunk — not traversed.
    expect(reachable.has(chunkKey(0, -5, 0))).toBe(false);
  });

  it('does NOT traverse through unloaded terrain — waits for it to load', () => {
    // Camera in loaded air; the +X neighbour is unloaded TERRAIN (missing, not sky). The BFS must
    // request it but stop there — it can't see through not-yet-loaded rock — so the loaded chunk
    // behind it is not selected until the unknown one streams in.
    const vis = new Map<string, number>();
    vis.set(chunkKey(0, 0, 0), VISIBILITY_ALL); // camera, loaded
    vis.set(chunkKey(2, 0, 0), VISIBILITY_ALL); // loaded, but behind the unloaded (1,0,0)
    // (1,0,0) is absent from vis and isEmptyAir is false everywhere → unloaded terrain.

    const { reachable } = getVisibleChunks(
      { cx: 0, cy: 0, cz: 0 },
      new THREE.Vector3(1, 0, 0),
      new THREE.Frustum(),
      makeProvider(vis),
      6,
    );

    expect(reachable.has(chunkKey(1, 0, 0))).toBe(true);   // reached (and requested), a dead end
    expect(reachable.has(chunkKey(2, 0, 0))).toBe(false);  // NOT seen through the unloaded chunk
  });
});
