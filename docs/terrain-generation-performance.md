# Terrain Generation — Performance Guide & Invariants

This is the **durable memory** of the terrain-generation performance work. Read it before touching
`shared/src/terrain/**` or adding a new terrain feature (biomes, structures, denser stamps, new noise
fields). It exists because the environment is ephemeral — knowledge only survives if it's in the repo.

Companion docs: `terrain-generation-system.md` (design/architecture), `chunk-persistence-plan.md`,
`off-thread-lighting-plan.md`.

---

## 1. How generation is structured (cost map)

One chunk is built by `TerrainGenerator.generateChunk(cx, cy, cz)` in phases:

1. **prepare** — gather + trace the worms/caverns overlapping the chunk (`prepareChunkWorms`,
   `prepareChunkCaverns`). Traces are **cached per spawn-cell** (`wormCellCache`, `cavernCellCache`).
2. **breach** — `breachedColumns`: scan the surface band to find columns a cave opens, so stamps/paths
   are suppressed over openings. **First consumer of worms** → it triggers the (cached) trace.
3. **carve** — the per-voxel double loop: height/material, pathway furniture, then `caveFillAt`
   (worm sphere test + `sampleCavern`).
4. **stamps** — `StampPlacer.applyStamps`: rasterize trees/rocks/buildings into the chunk.

Surface tiles go through `LocalTerrainSource.baselineTile` → `sampleSurface` (height + pathway material)
for every column of a 32×32 tile.

**Cost hierarchy** (cold, from the last device profile — re-measure, don't trust as gospel):
`traceWormCell` (self loop + steering noise) ≈ 30% · `sampleSurface`/pathways ≈ 22% · `applyStamps` ≈
18% · carve (cavern sampling + worm scan) · breach. **Worms dominate; pathways and stamps are the next
tier.** The worm trace is one-time-per-cell (cached); gathering it many times is cheap after the bbox
broad-phase.

---

## 2. The invariants (follow these when adding features)

These are the patterns that actually moved the needle. New terrain code should follow them by default.

1. **Struct-of-arrays, not arrays-of-objects, in hot loops.** Iterating `StampVoxel[]` (object per voxel)
   was a top device cost — pointer chase + 5 property loads per voxel. Store hot per-voxel data as
   parallel typed arrays (`Int32Array`/`Float64Array`) and pass primitives. See `getStampVoxelsByY`.
2. **Packed integer Map keys, never string keys.** `cx + ',' + cz` allocates a string and hashes it
   every lookup. Use `TerrainGenerator.cellKey`/`cellKey2` (pack ±2^16 indices into one safe integer).
   This was a measurable device win even though node hides it.
3. **Broad-phase before per-item work.** Cache a per-cell/per-object AABB and skip the whole item with
   one box test. The worm gather went from ~500k sphere tests/call to a handful of cell-box tests
   (`wormCellBBox`, folded into the trace).
4. **Memoize per column / per cell; compute shared sub-results once.** `heightCache`, `pathwayCache`
   (incl. shared `centerCell`), `placementCache`, `breachColsCache`. If several predicates sample the
   same field at the same point, compute it once (the pathway center-cell share).
5. **Noise is expensive on device (~10× a node bench).** Two levers: (a) fewer *calls* — sample
   low-frequency fields coarsely and interpolate (worm steering at stride K=16 with vector-lerp),
   sample-and-hold (radius at 2×K); (b) cheaper *calls* — drop FBm octaves where the extra octave is
   smoothed away anyway (worm steering, pathway/terrain warp are 1-octave). **Count calls in a bench;
   don't guess.**
6. **Shell-defer per-voxel noise.** Only evaluate expensive per-voxel noise where it can change the
   result — e.g. cavern wall roughness is computed only in the thin boundary shell, not for every
   interior/exterior voxel. Bound the shell so it stays byte-identical.
7. **Preallocate, don't grow/box.** `traceWormCell` writes straight into a right-sized `Float64Array`
   instead of `number[].push()`. Reuse scratch tuples (`pathWarpScratch`) instead of returning fresh
   arrays from hot helpers. Hoist constant arrays to module scope (`PATH_CARDINALS`).

---

## 3. Byte-identity guards & the re-baseline discipline

`caveReject.test.ts`, `columnMemo.test.ts`, `stampCache.test.ts` checksum a fixed chunk spread. They are
the safety net for refactors.

- A **pure optimization** (broad-phase, typed arrays, integer keys, memoization) MUST keep the checksum
  unchanged — that's the proof it's byte-identical.
- A change that intentionally **reshapes output** (coarser noise, larger step, fewer octaves, density)
  changes the checksum. That's allowed *when intended* — re-baseline all three guards to the new value
  and note why in the guard comment + commit message. Never re-baseline to hide an accidental change.

**Every new terrain feature ships with two assertions:**
1. a **checksum guard** (so future refactors are provably safe), and
2. a **visibility assertion** — "this feature produces > N voxels in a representative sample." The cavern
   spikes were invisible for their entire life precisely because nothing asserted they existed.

---

## 4. Profiling methodology (the part that's easy to get wrong)

- **Work runs in web workers.** In Chrome DevTools → Performance, workers appear as **separate thread
  lanes** below Main; expand them. Or use the Debug panel's **Gen Timing** bench, which runs the real
  `LocalTerrainSource` on the **main thread** (same code the worker runs) so the flame chart is directly
  readable. Bottom-up view, sort by self-time.
- **Node ≠ device for noise.** A node micro-bench under-weights `FastNoiseLite` ~10×, so it will show
  "no change" for octave/noise cuts that are real wins on device. Use node for **call counts** and
  **relative A/B in one run**; trust the device profile for absolute noise time.
- **Container wall-clock drifts** between sessions (shared CPU). Compare **relative** numbers (A/B in the
  same run via `git stash`), best-of-N, not absolute ms across sessions.
- The `terrainCost.bench.test.ts` harness (env-gated) prints noise-call counts by source + cold time by
  layer. Run: `BENCH=1 npx vitest run shared/src/terrain/terrainCost.bench.test.ts`.

---

## 5. Levers already applied (don't redo; know what's spent)

Byte-identical: cavern breach warp-once · worm smooth-interp trace (stride 16) · worm trace
preallocation · worm gather per-cell bbox broad-phase · integer cell keys · pathway center-cell share ·
scratch-tuple/module-const allocation cuts · stamp Y-window + flat typed-array voxels.

Reshaped (re-baselined): worm 1-octave steering · worm step 1.5 m / 120 segments · radius noise 2× stride
· 1-octave pathway & terrain domain warp.

**Remaining headroom** (not yet done): deeper stamp SDF caching (trees/rocks like buildings); pathway
edge-scan unification (share offset samples, not just centre); column-level worm gather (small, gather
iteration only); server-side parity of these in `server/`.

---

## 6. Guidance for the next features (buildings / trees / complex terrain)

- **Buildings/structures** are tall multi-chunk stamps → keep them on the flat typed-array + Y-window
  path; cache their SDF by `type:variant:rotation:seed` (already done for towers — extend to any new
  rasterized prefab). Cull candidates by cached footprint radius, never by generating the SDF.
- **Trees / denser scatter** → the scatter is XZ-only; memoize per `(cx,cz)`. Rasterize each placement's
  voxels once (flat, Y-sorted) and slice per chunk.
- **New noise fields (biomes, moisture, temperature)** → they'll be sampled per column/voxel; memoize
  per column, pick the lowest octave count that reads right, and add them to the bench's noise-source
  list so their call count is visible.
- Before merging any of the above: run the bench, keep the checksum guard green (or re-baseline
  intentionally), add a visibility assertion.
