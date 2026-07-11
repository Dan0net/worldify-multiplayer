# Off-thread lighting plan + worker-offload inventory

Status: **planned, not implemented.** Captured for a future pass.

## Why

Voxel lighting is the last heavy compute still on the main thread. It runs
synchronously in `VoxelWorld.computeChunkSunlight` (engine: `shared/src/voxel/lighting.ts`)
and *multiplies* — `ingestChunkData` relights up to 7 chunks per arrival,
`receiveSurfaceColumnData` relights a whole column in one burst, and
`relightModifiedChunk` (edits) relights self + above + 4 horizontal + the entire
loaded column below. Measured cost is ~1 ms sustained while streaming (higher on
column-load burst frames — check the `lighting` row in the debug overlay, which is
now a true per-frame total).

## The coupling that shapes the design

Meshing consumes **already-lit** data: `expandChunkToGrid` copies lit voxels into the
34³ grid the mesh worker meshes. So lighting must finish *before* meshing, and moving
it off-thread makes neighbour light re-settle **asynchronously** (a cascade). Remesh
must be enqueued only *after* lit data lands back in `chunk.data`.

## Design — dedicated lighting worker

Not folded into the mesh worker: the lit 32³ must return to the main thread anyway
(physics, raycast, persistence, seam cascade all read `chunk.data`). Mirror
`MeshWorkerPool` (transferables, buffer pool, in-flight dedup, priority queue).
Composes with the seam stitcher unchanged: `light → mesh → applyResult → stitch → merge`.

- **Payload:** own 32³ (64 KB, transferred + recycled) + `lightFromAbove` row (1 KB) +
  6 neighbour **boundary planes** (32×32 each, 12 KB) — not full neighbours, because
  border-light injection reads only 1-deep faces. ≈78 KB in, 64 KB out.
- **Shared engine reuse (`lighting.ts`):** add `injectBorderLightFromFaces` (compact
  1024-plane variant of `injectBorderLight`), `extractBoundaryPlane`, and a worker
  entry composing column pass → `seedColumnFrontiers` → face-slice inject →
  `propagateLight`. Keep `computeAndPropagateLight` for the sync edit fast-path. The
  module globals (`bfsQueue`, `litBottom`) are per-worker-safe (one message runs to
  completion); add a `bfsQueue`-overflow assertion.

### Phases

0. **Confirm the win.** The `lighting` metric already shows real per-frame cost.
   Capture the column-burst number as the baseline. If it never exceeds ~1–2 ms even
   on bursts, don't do this — the async cascade complexity isn't justified.
1. **Worker + streaming only.** Split `computeChunkSunlight` → `…Sync` (kept) +
   `dispatchChunkLighting`. Route single-chunk arrivals async; enqueue remesh from the
   lighting-completion callback. Safest first target (off-camera, latency-tolerant).
2. **Column job + cascade.** One top-down `LightColumnRequest` (a per-chunk fan-out
   breaks top-down sunlight ordering). Neighbour re-settle via a **signature-diff
   cascade** — relight a neighbour only when its shared boundary-plane hash changed;
   terminates because horizontal light attenuates within ~1 chunk, plus a depth cap
   (~4) and a per-burst counter. Distance-prioritise so near-player chunks light first.
3. **Edit fast-path.** Keep the modified chunk + 6 immediate neighbours **synchronous**
   (zero-flash placed block); send the deep below-column + outer ring async. Undo
   inherits it. Guard stale results via `chunk.lastBuildSeq`; never transfer
   `chunk.data` (copy in/out of a pooled buffer); dedup vs remesh via `isInFlight`.
4. **Tune.** Worker count, dispatches/frame, priority sort.

**Fold in:** `computeVisibility` + `computeFaceSurfaceMask` (pure `Uint16Array`→bits
scans, currently synchronous in `ingestChunkData`, no THREE access) move into the same
worker pass — the rest of the per-chunk ingest cost.

### Risks
Async breaks top-down column ordering → the single column job (Phase 2) is the fix;
cascade non-termination → signature gate + depth cap + per-burst warn; light "waves"
on fast flight → distance-priority the queue; stale lit data clobbering a fresh edit →
`buildSeq` guard + in-flight dedup.

---

## Worker-offload inventory — what else can move

**Already off-thread:** SurfaceNets meshing (`meshWorker`), local terrain generation
(`terrainWorker`).

**Worth moving (pure typed-array, no THREE):**
- **Lighting** — the plan above.
- **`computeVisibility` + `computeFaceSurfaceMask`** — fold into the lighting worker.
- **Grouper world-space position bake** — bake world-space positions in the mesh
  worker (`expandGeometry` + chunk origin) so the group merge is a pure memcpy and the
  bake leaves the main thread. **Only if** the `grouper` / `Reallocs/f` counters show
  the bake (not GPU upload / reallocation) dominates — the time-budget + conditional-
  dirty changes already removed the felt grouper jank, so this is a measured follow-up.
  Verified touch-points: collider uses `matrixWorld` (identity-position stays
  consistent); seam stitcher matches in world space.

**Cannot move (touch THREE / the scene graph — stay on the main thread):**
`updateMeshVisibility` (toggles `THREE.Mesh.visible`), grouper scene add/remove +
`BufferGeometry` + GPU upload, collider BVH builds (`computeBoundsTree` on THREE
meshes — already per-frame budgeted; three-mesh-bvh has an async path but that's a
separate heavier project), and `SeamStitcher.flush` (writes live geometry attributes).
