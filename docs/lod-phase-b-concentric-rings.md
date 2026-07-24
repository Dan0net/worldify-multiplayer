# LOD Phase B — Concentric distance rings (design, for review)

Status: **design / not yet implemented.** This is the durable plan for moving Explore from a single
global LOD level to per-region LOD by distance. It supersedes the global retire-and-swap once built.

## 1. Where we are (Phase A + the two follow-up fixes)

- **One global level.** `VoxelWorld.currentLevel` (0..`MAX_ZOOM_LEVEL`=6). Every chunk/tile/column
  request carries it; `ChunkGrouper.root` is scaled by `2^level`. A level-L chunk samples the same
  field at a `2^L` step (`generateChunk(cx,cy,cz,level)`), so it covers `8·2^L` m.
- **Level change = whole-world retire-and-swap.** `setExploreLevel` snapshots the visible chunks into
  a retiring holder at the old scale, installs a fresh root at the new scale, and re-streams. Old
  chunks are disposed per-region as the new level covers them (`retiringResolved`), new chunks are
  staged hidden until their region's old chunk is gone (atomic swap).
- **Known limitation (the reason for Phase B).** The global swap manufactures regions the new level may
  never cover (zoom-in periphery, level-skip footprints). We resolve those with a state-based
  quiescence net (force-drop orphans once the new level goes quiet) — correct, but it's cleanup after
  the fact. The whole class disappears if LOD is per-region instead of global.

Constants: `CHUNK_SIZE=32`, `VOXEL_SCALE=0.25`, `CHUNK_WORLD_SIZE=8 m`, `MAX_ZOOM_LEVEL=6`.

## 2. The model

Assign an LOD level to each region by **distance from the stream centre**, not one global level:

- Ring 0 (innermost): level `base` (finest visible level; often 0). Rings step +1 level outward.
- A "zoom" changes `base` and/or the ring radii — it slides the rings in/out. It no longer swaps the
  whole world.
- Each region is generated + meshed at its ring's level and rendered at that level's scale.

Ring radii are in **true-world metres** (level-independent) so a region's ring membership is a pure
function of its world position and the current centre + zoom — deterministic, no history.

### Region unit
A "region" is a level-L chunk footprint: `8·2^L` m square in XZ, full height. The natural key is
`(level, cx, cy, cz)` — already what `LocalTerrainSource.rawChunk` caches on. Phase B makes that
composite key first-class through the client (grouper, geometries, columnInfo), where today `level` is
implicit-global.

## 3. Rendering: mixed-level grouper

Today `ChunkGrouper` has ONE root at one scale. Phase B needs geometry from several levels resident at
once. Two options:

- **(A) One root per active level** (a small map `level → THREE.Group` scaled `2^level`). Each level's
  chunks live under its own root. This is the smallest step from today's code — the retiring-holder
  list already proved multiple scaled roots coexist fine. Merged-group batching stays per-level.
- **(B) Single root, per-chunk scale.** More uniform but loses the cheap per-root scale and complicates
  the merged-group meshing (mixed scales in one merge). Not recommended first.

Recommendation: **(A)**. `currentLevel` becomes `baseLevel`; the grouper owns `roots: Map<level,Group>`
and shows/merges each chunk under its level's root. The retiring holders collapse into this — a chunk
leaving a ring is just a chunk whose region now belongs to a different level's root.

## 4. Transitions become local ring-swaps (this is the win)

When the centre moves or zoom changes, a band of regions crosses a ring boundary and changes level.
For each such region:

1. Request it at the new level (generate + mesh).
2. Keep the old-level geometry visible until the new-level geometry for that exact region is
   mesh-complete (drawable or confirmed-empty) — the **same coverage predicate + staged reveal** we
   already have, but scoped to one region instead of the whole view.
3. Swap atomically: dispose old-level region, reveal new-level region, same frame.

Because ring boundaries are always **inside the view** and always being streamed, every swap resolves —
there is no out-of-view-orphan and no level-skip footprint. The quiescence net becomes unnecessary
(keep it as a cheap belt-and-suspenders, but it should never fire). The "stuck chunks on fast zoom"
class is gone by construction: fast zoom just moves ring radii quickly; regions still only ever swap
one level at a time at their boundary.

## 5. The hard parts

### 5a. Cross-level seam stitching (the real cost)
At a ring boundary a coarse chunk (2 m voxels, say) abuts fine chunks (0.25 m). The shared edge has a
**T-junction**: the fine side has more vertices than the coarse side → cracks/z-fibres. Options, cheap→dear:
- **Skirts:** drop a short vertical apron at each chunk's ring-facing edge to hide the crack. Cheapest,
  standard for heightmap LOD, works for near-vertical seams; can peek on overhangs.
- **Edge-locking:** when meshing the fine side against a coarser neighbour, snap/weld the fine edge
  vertices to the coarse edge samples (constrain the surface-net on that boundary). Correct, no skirt,
  but needs the mesher to know the neighbour's level — a new margin input keyed by neighbour level.
- Our SurfaceNet + `SeamStitcher` already reconcile normals across equal-level seams; extend the margin
  contract to carry the neighbour's level and lock the boundary. This is the bulk of the work.

Recommendation: ship **skirts** first (unblocks rings visually), then invest in edge-locking.

### 5b. columnInfo / isEmptyAir per level
`columnInfo` (vertical band per column) is currently keyed `"cx,cz"` at the global level. Per-region LOD
needs it keyed by `(level, cx, cz)`. Fix #2 already made coarse `sampleSurface` level-correct, so the
per-level heights are now trustworthy — Phase B keys the map by level and picks the ring's level per
column.

### 5c. Memory + streaming budget
Several LODs resident at once. Bounded by ring widths: keep each ring a few chunks thick, so total
resident ≈ `Σ_rings (ring_area_in_chunks)`, comparable to today's single-level view. The per-level
worker cache keys already include level (`rawChunk` key), so generation dedups correctly. Budget the
per-frame ring-swap work like the existing remesh budget.

### 5d. Which field drives ring level
Pure distance from centre is the baseline. Later refinements (screen-space error, camera pitch so the
horizon gets coarser faster) are drop-in replacements for the `distance → level` function — keep that a
single pure function so it's tunable without touching the swap machinery.

## 6. Build order

1. **Key geometry/columnInfo by level** (data-model change; grouper `roots: Map<level,Group>`). Behaves
   identically to today when only one level is active — no visual change, pure refactor. Verify level 0
   byte-identical + existing zoom still works. **DONE** — commits: Step 1 (multi-root grouper), Step 2a
   (per-chunk `level` threaded end-to-end), Step 2b-1 (per-level chunk/geometry/columnInfo stores in
   `VoxelWorld`, active-level refs swapped by `activateLevel`).
2. **Distance→level ring function + per-region reconcile** reusing the coverage predicate + staged
   reveal at region scope. Rings visible; seams cracked (accept temporarily). Retire-and-swap deleted.
   Split into:
   - **2a — ring schedule (pure fn).** `client/.../ringLevel.ts`: `ringLevel(distanceMeters, baseLevel)`
     + `ringOuterRadius(level, baseLevel)`, radii in true-world metres, unit-tested. Isolated from the
     swap machinery (§5d) so it's tunable without touching streaming. **DONE.**
   - **2b — streaming flip (the visible change). DONE** — `client/.../CoarseRingStreamer.ts`, wired into
     `VoxelWorld.update` (Explore only). Realized as an **additive, isolated** design rather than the
     pure per-level rewrite, to keep the change low-blast-radius and revertible on a blind commit:
       - The **base (finest) level is untouched** — VoxelWorld still streams it with the full occlusion
         BFS + retire-and-swap over its own disk. Play mode and level-0 output are unaffected.
       - Coarser rings (base+1 .. base+`NUM_COARSE_RINGS`) are streamed BEYOND the base disk by
         `CoarseRingStreamer` as simple always-visible surface-shell **annuli**. Each coarse level owns
         its OWN chunk/geometry/columnInfo maps + `RemeshPipeline` + `ChunkGrouper` (a `CoarseLevelRig`),
         so the base level's bare-keyed structures never collide with a coarse level's overlapping coords.
       - The **collision + async hazards dissolve** under isolation: the mesh-worker pool is shared but
         routes results by unique dispatch id (closure-bound to the right rig), so a same-bare-key clash
         only serialises a dispatch; generation callbacks are guarded by a per-rig epoch bumped on
         teardown; the global mesher open-sky predicate is re-asserted per level immediately before that
         level meshes (base predicate re-applied before base `process`).
       - "Wave from centre out": a coarse ring only begins once the next-finer resident ring is quiet.
       - Ring radii come from `ringLevel.ts`. Boundaries are left as a thin **gap/crack** (coarse chunks
         sit fully outside the inner radius) rather than z-fighting overlap — the accepted artifact.
       - **Deviations from the original plan, still open:** whole-world retire is NOT deleted (kept for
         the base level's own transitions); rings are **local-worlds only** (server Explore = base only);
         coarse chunks get no cross-chunk seam normal reconciliation (distant, cosmetic). Revisit if the
         additive design proves insufficient — the pure per-level-streaming rewrite (per-level BFS +
         level-addressed ingest, deleting whole-world retire) remains the long-term target.
       - Needs the on-device glance (swiftshader in-container ~1–2 FPS — not verifiable here).
3. **Skirts** at ring boundaries → cracks hidden.
4. **Edge-locking** (extend the margin/seam contract with neighbour level) → true crack-free seams;
   drop skirts if fully covered.
5. Retune ring radii per device; optional screen-space-error driver.

Each step: `npm run build` + `npm run test:run` (byte-identity + `lodZoom` guards green — Phase B must
not change level-0 output) and a real-browser landform+caves zoom check.

## 7. What carries over from the interim hardening (no throwaway work)

- `retiringResolved`'s "mesh-complete = drawn OR empty" coverage rule → the per-region swap gate.
- The staged-hidden + atomic-reveal machinery → the per-region reveal.
- Fix #2 (level-correct coarse `sampleSurface`) → trustworthy per-level `columnInfo`.
- The quiescence net → belt-and-suspenders that should never fire once swaps are local.
