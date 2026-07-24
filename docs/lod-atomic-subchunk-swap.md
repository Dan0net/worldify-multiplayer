# LOD atomic sub-chunk swap (design, for review)

Status: **design / not yet implemented.** Goal: a level-change swap that is simultaneously
**strict no-overlap** (never two levels drawn in the same world region), **no-blank** (never zero
levels drawn in a covered region), and **atomic per region** (old removed the same frame new appears).
No generator change → byte-identity + `lodZoom` guards stay green.

## Why the current swap can't hit all three

The retire-and-swap unit today is a **whole old chunk** (`retiringHolders[].entries[] = {meshes, box}`),
disposed all-or-nothing, with new chunks staged-hidden until *no* retiring entry overlaps them. Two
consequences fight each other:

- **Require drawn geometry to dispose** (gap-free): a coarse old chunk covers many new columns; one
  laggard/occluded column keeps the whole old chunk alive, which keeps every ready new chunk overlapping
  it hidden → "stuck old + new not displaying."
- **Dispose on "not expected"** (the reachability gate): right after a level flip almost nothing is
  loaded, so the BFS `cachedReachable` set is tiny and most of the view reads as "abandoned" → old
  disposed before new streams in → **blank**.

Root issue: **the swap granularity (a whole old chunk) is coarser than the unit that actually becomes
ready (a column).** Fix the granularity and the strict "require drawn" rule stops causing stuck.

## The model: column-granular atomic swap

Swap grid = the **new level's chunk columns** `(cx,cz)` (full vertical band). Each column swaps
independently and atomically.

- **Retiring geometry is bucketed into new-level columns**, not held as whole old chunks. When old is
  *coarser* than new (zoom in), a cloned old chunk mesh is **split** into the new-level column tiles it
  covers (2-D XZ bucketing, full height kept). When old is *finer or equal* (zoom out / same), each old
  clone already fits inside one new column — no split, just key it by that column. Result:
  `retiringColumns: Map<colKey, THREE.Mesh[]>` (clones baked to true-world coords in one scale-1 group).
- **A new chunk is staged hidden** iff its column `(cx,cz)` has retiring geometry; shown immediately
  otherwise (periphery needs no swap).
- **Per-frame reconcile, per column:** a column is READY when every cell in its vertical band is either
  air, or has a completed mesh (drawn geometry, or meshed-empty) — i.e. the gap-free predicate, applied
  per column. When a retiring column becomes READY: **same frame**, dispose that column's retiring
  meshes AND reveal that column's staged new chunk(s). Exactly one level drawn in the column before
  (old) and after (new) — never both (strict), never neither (no blank). Columns are independent, so a
  laggard in column A never blocks the A-ready swap of column B (fixes the stuck).

Because the swap is keyed on the new column being *drawn or confirmed-empty* — not on "expected" — it
never disposes ahead of a visible replacement (fixes the blank), and because it's per-column it doesn't
wait on unrelated laggards (fixes the stuck).

## Liveness — a column whose new content never draws

Per-column "require drawn" still needs an escape for columns the new level never fills (occluded, or
you zoomed away). Three state-based guards, no wall-clock:

1. **Out of view:** a retiring column beyond the new view radius → dispose (you left it behind). Uses
   the current Chebyshev test, now per column.
2. **Force-cover:** for every retiring column still alive, ensure the new level actually *requests* it
   (add to the load frontier), so occlusion culling can't strand it unmeshed forever. Bounded — the
   retiring set is bounded by the view.
3. **Idle quiescence net** (keep): once streaming settles, dispose any leftover retiring columns
   (catches deferred-mesh). State-based, already implemented.

A column that meshes **empty** (genuinely air/underground) counts as READY → its old is disposed and
nothing is drawn there, which is the correct strict state (one level = the empty new one).

## The one new operation: split a clone into column tiles

Input: a cloned old-chunk `BufferGeometry` (positions already in true-world) + the new column grid
`step = CHUNK_WORLD_SIZE * 2^newLevel`. Bucket triangles by the new column containing each triangle's
XZ centroid; emit one geometry per non-empty column. Cost O(triangles) per retiring chunk, done once at
retire. For a 1-level zoom-in a coarse chunk covers 2×2 = 4 columns; a 2-level skip 4×4 = 16; bounded by
the level jump. Cap the split depth (e.g. ≤2 levels finer) on huge skips and accept coarser-but-still-
strict granularity beyond that, so a 0→6 jump can't explode into thousands of tiles.

## Multi-level sweeps

Retiring becomes a single column-keyed map (no per-level holder list). A further level change re-buckets
the current outgoing geometry (the previous "new", now old) into the newer column grid. Bounded by view
size. Optimization if per-transition re-bucketing is too costly on a fast sweep: **lazy split** — keep a
retiring clone whole until a new chunk for one of its columns arrives, then split only that clone. Defers
split cost to when a swap is actually imminent.

## Rendering / perf notes

- Retiring column tiles are many small meshes. Merge the tiles of a column into one mesh at split time
  to keep draw calls down; the live grouper already batches the new side.
- A small `polygonOffset` is NOT needed — strict swap means old and new never draw the same column
  simultaneously, so there's nothing to z-fight.
- Watch allocation churn from splitting during fast sweeps; the lazy-split + per-column merge bound it.

## Invariant check

- **No overlap:** old for a column is removed the exact frame new for that column is shown; split
  granularity means we can remove exactly the swapped column, never a superset.
- **No blank:** a column's old stays until its new is drawn-or-empty; a column is never empty mid-swap.
- **Atomic:** dispose-old + reveal-new for a column happen in one reconcile pass.
- **No stuck:** columns are independent (no laggard cross-block); out-of-view + force-cover +
  quiescence guarantee every retiring column resolves.

## Build order

1. **Column-keyed retiring map + per-column staging/reveal**, WITHOUT splitting (assign each old clone
   to the column of its origin). Equal-level + zoom-out already correct here; verify no regression.
2. **Clone splitting for zoom-in** (old coarser than new) → per-column disposal of coarse old. Verify
   strict no-overlap + no-blank + no-stuck on a slow zoom-in.
3. **Liveness:** out-of-view per column + force-cover retiring columns; keep the quiescence net.
4. **Fast multi-level sweep:** re-bucket on transition (or lazy-split); per-column merge; cap split depth.
5. **Verify:** `npm run build` + `npm run test:run` (byte-identity + `lodZoom` green — no generator
   change); real-browser fast multi-level sweep on the landform+caves world — no blank frame, no
   overlap, no stuck column; memory bounded.

## Relationship to Phase B (concentric rings)

This is the correct transition primitive for Phase B too: rings are just per-region target levels, and a
region crossing a ring boundary is exactly a per-column atomic swap. Building column-granular atomic swap
now is a direct stepping stone — Phase B replaces "global level + retire on change" with "per-column
target level + swap on change," reusing this machinery.
