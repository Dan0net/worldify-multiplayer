# Chunk-rendering "drift": rationale & prevention plan

## Why this doc exists

We fixed four terrain-rendering bugs in quick succession — seam gaps, chunks popping in/out while
walking, "see through the world" holes when orbiting, and holes at far/unapproached chunks that only
heal on approach. They looked unrelated but are the **same class of bug**. This doc names that class,
explains why the voxel pipeline keeps producing it, and records the guardrails we're putting in to stop
it. Read the **CHUNK DEPENDENCY CONTRACT** block in `shared/src/voxel/constants.ts` alongside this.

## What "drift" is

The voxel system has no single representation of the world. It has **many derived projections of the
same underlying voxel data**, each maintained by a different subsystem:

| Projection            | Owner                | Truth it approximates                     |
| --------------------- | -------------------- | ----------------------------------------- |
| `chunks` (loaded set) | `VoxelWorld`         | what voxel data is resident               |
| `reachable` (BFS)     | `VisibilityBFS`      | what is visible                           |
| render / visible set  | `ChunkGrouper`       | what is actually drawn                    |
| meshed geometry       | `ChunkMesher` / `SurfaceNet` | the surface (a function of a chunk **+ its neighbours**) |
| `visibilityBits`      | `visibility.ts`      | coarse occlusion connectivity             |
| lighting (preview/commit) | `BuildPreview` / relight | light per voxel                     |
| collision BVH         | `VoxelCollision`     | physics geometry                          |

**Drift is when two of these projections disagree.** Every bug we hit was exactly one disagreement:

- **Seam gaps (P8):** re-mesh trigger set (6 faces) ≠ actual mesh dependency (7 neighbours).
- **Popping while walking:** render set (`== reachable`) ≠ "what the player can see" — `reachable` was
  too strict a proxy, because a surface chunk's air region doesn't connect its solid-side faces and the
  BFS only seeds all six faces from the camera chunk itself.
- **Frontier / far / explore holes:** meshed geometry ≠ loaded set — a chunk meshed *before* its
  neighbour inputs existed, so its mesh is a stale function of missing inputs (a skipped high boundary).
- **P3 lighting:** preview relight set ≠ commit relight set.

Same shape every time: a projection computed from inputs that were incomplete, stale, or governed by a
slightly different rule than the projection it must agree with.

## Why *this* codebase keeps producing it

1. **Duplicated rules.** The same concept is re-encoded in several places, so changing one doesn't
   update the others. "Which neighbours does a chunk depend on?" lived in ≥4 functions
   (`expandChunkData` reads +7, `queueNeighborRemesh` invalidates −7, `addMarginSourceRequests` loaded
   +7 only, `marginSourcesReady` waited on +7). The **−side asymmetry in that list is literally the
   frontier-hole bug.** We hit the same thing earlier with "solid" (`isVoxelSolid` vs
   `VOXEL_OPAQUE_VIS` vs `SURFACE_PACKED_THRESHOLD`), which we fixed by unifying on one threshold — the
   template for the fix here.

2. **Aggressive caching + async, with no invalidation contract.** For performance, projections are
   cached and recomputed only on a trigger (`cachedReachable` recomputes on `chunkChanged ||
   visibilityDirty`; meshing runs on a worker across frames). Caching *is* deferred truth — correct only
   if every input change fires the right invalidation. There is no central rule for "when input X
   changes, which projections go stale," so a late-arriving input (a neighbour streaming in) silently
   leaves a projection wrong until something incidentally re-triggers it.

3. **Proxies used as if exact.** `reachable` is used *as* "rendered"; `loaded` is used *as* "can mesh
   completely." These are ~95% correct, so the 5% (frontier, below-surface, explore's decoupled camera)
   only shows at the edges — which is why each bug looks new but is the same proxy leaking.

### Boundary ownership (the specific asymmetry)

The shared face between chunk `A` and its `+axis` neighbour `B` is meshed **only by `A`** (A's high
face, built from B's voxels); `B` skips its low face. So a boundary's surface belongs to the
**lower-coordinate chunk**. Consequences:

- A rendered chunk needs its **+ margin neighbours loaded** (to build its own high faces) **and** its
  **lower neighbours rendered** (they own the surface on its low faces).
- Meshing a chunk with an absent `+` neighbour **skips** that high face (`skipHighBoundary`) → a hole
  that only heals when the neighbour streams in and the chunk re-meshes. That is precisely the
  far/explore "gap that heals on approach": the neighbour's voxels simply weren't loaded, so the
  boundary could not be built, and approaching is what finally delivered them.

## What we changed (guardrails #1 and #2)

### #1 — One source of truth for the dependency graph

`shared/src/voxel/constants.ts` now carries a **CHUNK DEPENDENCY CONTRACT** doc block naming the four
consumers that must all derive from the same offset tables:

1. **READ** (mesh input) — `expandChunkData` reads `POSITIVE_MARGIN_OFFSETS_7` as the high-side margin.
2. **WAIT** (mesh readiness) — a chunk defers meshing until its `POSITIVE_MARGIN_OFFSETS_7` resolve.
3. **INVALIDATE** (re-mesh) — a changed chunk re-meshes its `NEGATIVE_MARGIN_OFFSETS_7` consumers.
4. **LOAD / RENDER** (coverage) — loading stays one ring ahead of rendering (`render ⊆ load − 1 ring`),
   using `FACE_OFFSETS_6` for the dilation.

We also removed a freshly-introduced duplicate of `FACE_OFFSETS_6` (a mini-instance of the very drift
this is meant to prevent) and routed the render/load dilation through the existing shared constant.

### #2 — Completeness-gated rendering (`render = load − 1 ring`)

- **Mesh completeness is now tracked.** `RemeshPipeline` records, per chunk, whether its applied mesh
  skipped any high boundary (`skipHighBoundary` true on any axis → **incomplete**). Exposed as
  `isMeshComplete(key)`; cleared on re-mesh and on `forget(key)` at unload.
- **The render gate refuses incomplete meshes.** `VoxelWorld.isRenderable` returns false for a chunk
  whose mesh has a skipped high face, so a holed mesh is never drawn. It self-heals when the neighbour
  streams in and it re-meshes complete. This makes the visible frontier sit **one ring inside** the
  loaded region: the outermost (margin-shell) chunks are incomplete and hidden, so the edge of the
  drawn world is a clean boundary against background instead of a see-through seam in the middle.
- **The load set now dilates the render set on all sides.** `addMarginSourceRequests` requests both the
  `+` margin sources (so a rendered chunk can build its own high faces) **and** the `−` face neighbours
  (which own the surface on its low faces, per boundary ownership), so loading stays a ring ahead of
  rendering symmetrically.
- The one-ring **visibility dilation** from the previous fix (draw `reachable` plus its face-ring) is
  kept — it's the second gate in `isRenderable` and is what stopped the walk-around popping.

Net effect: instead of "hole in the terrain until you approach," the loaded region shows only complete
geometry and grows outward with a clean edge as data streams in.

## Verification

- `npm run build` (shared + client + server) clean; `npm run test:run` 13/13 pass.
- The render gate lives in `VoxelWorld`, which transitively imports the game store (needs `window`) and
  can't be unit-tested in the node/no-jsdom env — verified via build + in-app.
- Manual: walk over surface boundaries (no popping), orbit in explore (clean edge, no interior
  see-through holes), move toward an unapproached region (edge extends, no mid-terrain holes).

## Known residual & remaining guardrails

- **`−` edge sliver at the absolute load boundary.** Because boundary surface belongs to the lower
  chunk, the very outermost `−` ring's low faces are owned by a chunk one further out that isn't loaded.
  With the load ring now dilating on all sides this is pushed to the edge of the loaded region (beyond
  the render frontier) and is a sub-voxel sliver rather than a chunk-sized hole. Fully removing it would
  require symmetric double-margin meshing (each chunk meshes both its high and low boundaries, accepting
  coincident boundary geometry) — a larger change, tracked as future work.

### Guardrail #4 — dev-mode invariant assertions ✅ (shipped)

`VoxelWorld.assertChunkInvariants()` runs after each visibility update, gated on `import.meta.env.DEV`
(the whole body is stripped from production). It asserts the cross-projection invariants directly and
`console.error`s (loud, non-fatal) on a violation: no meshed geometry without a loaded chunk, no
preview chunk without loaded data, and each `pending*` set in lockstep with its stale-expiry time map.
This turns the *next* drift bug into a logged assertion in the frame it occurs instead of a visual
artifact found weeks later. Extend it with more invariants as new ones are identified.

### Guardrail #5 — explicit per-chunk mesh lifecycle ✅ (incremental step shipped)

`Chunk.phase: ChunkPhase` (`Loaded → MeshedComplete | MeshedIncomplete`) is now the **single source of
truth** for mesh completeness, set by `RemeshPipeline` when a mesh applies. This replaced the separate
`incompleteChunks` Set that lived in `RemeshPipeline` with its hand-maintained *forget-on-unload*
contract — the phase now dies with the `Chunk`, so it can't leak (drift point #2 closed). `isMeshComplete`
/ `isRenderable` read the phase.

Remaining consolidation (future work): fold the `dirty`↔`queue` pair and the `pending`/`loaded` keysets
into the same lifecycle field so `requested → loaded → meshable → meshed → renderable` is fully explicit
rather than inferred from scattered `Map`/`Set` membership. Deferred as higher-risk (touches the pending/
queue/dirty machinery); the phase field + assertions are the safe first step.

### Not drift (reclassified)

`columnInfo` is keyed per **column** (`tx,tz`), not per chunk, and holds immutable height metadata — a
chunk unloading while its column persists is correct caching, not divergent-lifetime drift. Left as-is.

### Still open

3. **Derive projections, don't co-maintain them.** One function `worldState → { loadSet, renderSet }`
   that encodes the invariants (`render ⊆ meshed-complete ⊆ loaded-with-margins ⊆ loaded`), instead of
   three subsystems each independently deciding. (P3 proved this works by collapsing preview+commit
   lighting into one job.)
