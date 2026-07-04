# Worldify — Architecture & Performance Review + Refactor Plan

> Review date: 2026-07-03 · Scope: `worldify-multiplayer` monorepo
> Constraint honoured: **no code was modified**. This document is findings + a concrete, fact-checked plan.

## Context

The codebase is a React + Three.js + Zustand voxel-building multiplayer prototype with a clean `shared/client/server` split. It works well on strong hardware but:
- runs **poorly on weak high‑DPI laptops and at 4K even on a strong GPU, even at the lowest quality preset**;
- has accumulated **drift** from being built by an older, low-context agent — an unnecessary store "bridge", a messy settings/day-night layer, and a hard-to-follow voxel/meshing/culling/collision core.

The near-term direction (local-only browser prototype, mobile build controls, undo, snap-point persistence, home-screen local game, 3rd-person LoD zoom) is **not** planned in detail here per your instruction — instead the refactors below are chosen to lay clean seams for them.

Every recommendation was checked against the current code. **Important fact-check result:** the existing `docs/architecture-improvement-plan.md` is **stale** — its top items are already done (physics constants live in `shared/src/protocol/physics.ts`, movement math in `shared/src/util/movement.ts`, `GameLoop`/`PlayerManager` are extracted, and the `MessageRegistry` handler-map replaced the switch in `client/src/net/decode.ts`). Do not action that old doc; this supersedes it.

---

## 0. What is genuinely good (keep, don't touch)

- **Package split** `shared / client / server` with a well-designed binary protocol (`shared/src/protocol/*`, `net/MessageRegistry.ts`).
- **Voxel data & algorithms**: SurfaceNets meshing, the 15-bit per-chunk visibility graph (`shared/src/voxel/visibility.ts`), and the Minecraft-style cave-culling BFS (`VisibilityBFS.ts`) are efficient and effective. Grid-buffer recycling through the worker pool (`MeshWorkerPool.ts`) is a good design.
- **Collision shares render geometry** (BVH built on the existing solid mesh via three-mesh-bvh) rather than re-meshing — correct and cheap.
- **Shared day/night math** (`shared/src/scene/daynight.ts` + `constants.ts`) is the cleanest part of the settings stack.

The problems below are about *structure and per-pixel cost*, not the core algorithms.

---

## 1. Performance — the reported symptom is FILL-RATE bound (not CPU)

The symptom fingerprint — *fine on strong GPU at 1080p, bad on weak high-DPI, bad at 4K on any GPU, and **draw-distance/quality presets barely help*** — is the textbook signature of a **fragment-shader / fill-rate bottleneck**: cost scales with pixel count × per-pixel work, not with triangle/chunk count. This diagnosis drives both the fixes here and the WASM/native answer in §2.

Ranked culprits (all verified in code):

### 1.1 God-rays run on EVERY quality level, including Low — the #1 bug
`QualitySettings` (`client/src/game/quality/QualityPresets.ts:25-49`) has **no `godRaysEnabled` field**. So `applyQuality()` / `syncQualityToStore()` (`QualityManager.ts:69-147`) set bloom/SSAO but **never touch god rays**. The store default is `godRaysEnabled: true` (`store.ts:345`), so a **60-sample radial-blur** pass (`effects.ts:212-222`, `samples: 60`, half-res) renders on Ultra→Low alike. On "Low" the chain is literally `RenderPass → godRaysPass→screen`. At 4K half-res that's ~60 taps × ~2M px ≈ 120M dependent texture reads/frame on the *lowest* setting.
**Fix:** add `godRaysEnabled` to `QualitySettings`, set it per preset (ultra/high on, medium/low off), and set it in `applyQuality`+`syncQualityToStore`. The wiring already reacts (`effects.ts:263` subscription → `godRaysPass.enabled`). ~15 lines; biggest single win.

### 1.2 No render-scale below native resolution — the 4K fix
The only resolution lever is `maxPixelRatio` (`QualityManager.applyPixelRatio:151` → `Math.min(devicePixelRatio, maxRatio)`). Presets: ultra 2 / high 1.5 / medium 1 / low 1. Clamping to 1 halves a DPR-2 laptop (good) but is a **no-op at 4K** (DPR≈1 already) — nothing renders below the native 8.3M-px framebuffer.
**Fix:** introduce a real `renderScale` (e.g. 0.5–1.0) multiplier applied to `renderer.setSize(w*scale, h*scale)` + `composer.setSize` (with CSS keeping the canvas full-size so the browser upscales). Add to `QualitySettings`, the resize path (`GameCore.onResize:561`), and expose a slider. This is the standard, correct fix for a fill-rate-bound scene at high resolution and the only thing that helps 4K on any GPU. Combine with the DPR cap (they multiply).

### 1.3 Procedural sky star-field is ungated and full-screen
`SkyDome.ts` fragment (`:79-135`) evaluates **5 star layers × a 3×3 cell loop = up to 45 hash/`octDecode`/`exp`/`sin` evaluations per sky pixel**, over the whole background sphere, whenever the sun is low (night/dusk). Not gated by quality at all.
**Fix:** gate star layer count (or disable stars) by quality; cap to 2 layers on low/medium. Consider baking stars to a cubemap. Guard already exists for daytime (`:192`), so daytime is fine.

### 1.4 Water shader is ungated
`WaterMaterial` fragment samples albedo (9 triplanar taps, `:205`) and calls `getWaterNormal` **twice** (`:214,:234`), each sampling **4 scrolling normal layers** = ~17 taps/px on all presets. Bounded by visible water area, not screen — secondary, but there's zero preset gating.
**Fix:** on low/medium, drop to a single normal sample (or vertex-only normals) and skip the second `getWaterNormal` call; gate via a `#define` like terrain already does.

### 1.5 Terrain triplanar is heavy but CORRECTLY gated (not the Low-preset culprit)
`sampleMaterialBlend` = 3 materials × 3 axes = **9 `sampler2DArray` fetches per map**; Ultra samples albedo+normal+ao+roughness+metalness ≈ **45 fetches/fragment** (`terrainShaders.ts:187-324`). But `#ifdef QUALITY_NORMAL/AO/METALNESS_MAPS` are all off on Low (`QualityPresets.ts:110-114`), collapsing it to 9 albedo taps. So this is a High/Ultra cost, already handled. Only further lever: a "single dominant material" path (skip the 3-material blend) on low — the shadow depth pass already does this (`terrainShaders.ts:423-451`), so the pattern exists to copy.

### 1.6 Dead render pipeline shipped in the bundle
`client/src/game/scene/postprocessing.ts` (356 lines, Three.js `examples/jsm` SSAO/UnrealBloom) is **never imported by GameCore** — only `effects.ts` (pmndrs) is (`GameCore.ts:22`). It's a stale parallel implementation.
**Fix:** delete `postprocessing.ts` (and the `updatePostProcessing` reference in `QualityManager.applyColorCorrectionEnabled:187` — route color-correction through the `effects.ts` store subscription like the others).

### 1.7 Per-frame environment re-application (CPU, minor but wasteful + a coupling smell)
`GameCore.update()` (`:403-412`) calls `updateDayNightCycle()` (which writes ~15 fields into the store) then `applyEnvironmentSettings(envState)` — pushing the **entire ~50-field environment object** onto lights/tone-mapping/sky uniforms **every frame with no diffing**, even when paused (`timeSpeed:0`). See §4.

**Net effect of 1.1 + 1.2 (+1.3):** these three are the ones that make "even lowest settings" bad. They're small, surgical edits to the quality system. Do them first.

---

## 2. WASM vs. "closer to the metal" — the honest, fact-checked answer

**Short version: neither WASM nor a native rewrite will fix the reported performance problem, because the problem is GPU fill-rate, not CPU.**

- **WASM runs on the CPU.** It speeds up CPU-bound work: SurfaceNets meshing, the lighting BFS, terrain generation, collision/BVH. You said rendering "works super well" — i.e. the CPU/meshing side is already fine. Porting meshing to WASM/Rust would add a large maintenance + build-complexity cost to optimize the part that isn't the bottleneck. **Not recommended for this symptom.** It *is* a reasonable *future* lever if you later scale to much bigger worlds / faster regen / server-side gen — but that's a different problem than "4K/weak-GPU FPS."
- **Native / "closer to the metal" (Bevy, Godot, Unity, custom):** a 4K screen is 8.3M pixels on any API or engine. An expensive fragment shader at native 4K costs the same regardless of language. Native buys you better threading and lower driver overhead (CPU wins again), not free fill-rate. It also throws away your entire React/Three/web deployment story. **Not recommended now**; it solves a problem you don't have and costs everything you've built.
- **WebGPU (the realistic in-browser upgrade):** compute shaders (meshing/lighting on GPU), better draw-call batching, modern pipeline. Worth considering *long-term*, but (a) it's a large rewrite of the render layer, and (b) **it does not change fill-rate physics** — the same pixels cost the same. It would mainly help CPU-side and batching, which again aren't your bottleneck.

**Recommendation:** treat performance as a shader/resolution problem, not a runtime problem. Ship §1.1–1.4 first; they will very likely resolve the weak-laptop and 4K symptoms with a few dozen lines. Revisit WASM only for future world-scale/CPU goals, and WebGPU only as a deliberate long-horizon rewrite — not as a perf fix.

---

## 3. State: retire the store "bridge"

`client/src/state/bridge.ts` (584 lines) is a hand-written **1:1 mirror** of the Zustand store: ~120 members, the vast majority trivial forwarders (`get qualityLevel(){return getState().qualityLevel}`, `setFov(f){getState().setFov(f)}`, …). Its stated contract — "all non-React code must use the bridge; React uses the hook" — is **not enforced and not followed**: game modules read the store directly (`DayNightCycle.ts:129`, `Lighting.ts`, `SkyDome.ts`, `effects.ts:252`) and UI files use the bridge (`DebugPanel.tsx`, `MapPanel.tsx`, `SpectatorOverlay.tsx`), the opposite of the rule. Every new store field must be edited in **both** files → guaranteed drift. It also has broken typing (`setEnvironment`'s conditional type resolves to `never`, `:453`) and mixes 5 unrelated roles.

Only three things actually justify code beyond the store:
1. **Non-reactive high-frequency map data** kept out of Zustand to avoid re-renders (`_mapPlayerPosition`, `_mapOtherPlayers`, `:30-51,131-144`) — legitimate.
2. **Rate-limited debug-stats** (10 Hz, the only method that rate-limits, `:177-183`).
3. **Side-effecting setters** that also push to shaders (`setMaterialSettings`/`setWaterSettings` call `apply*ToShaders`, `:362-399`) and the `clearChunksCallback` registry.

**Plan (`bridge.ts` → delete):**
- Game (non-React) code calls `useGameStore.getState()` / `useGameStore.setState()` directly — Zustand fully supports imperative access. Replace `storeBridge.x` reads with `getState().x` (mechanical, ~171 refs across 18 files).
- Move the genuinely non-reactive frame data into a tiny dedicated module `client/src/state/transient.ts` (plain object for map positions + the debug-stats rate limiter). ~40 lines, single responsibility.
- Move shader side-effects out of setters into **store subscriptions** (the pattern `effects.ts:252-270` already uses): a `subscribeMaterialSettings()` / `subscribeWaterSettings()` in `TerrainMaterial`/`WaterMaterial` init. Then UI just calls the store; shaders react. Removes the "setter with a hidden side effect" coupling.
- Keep the `clearChunks` callback as a small explicit registry or pass it into `VoxelIntegration` (DI) rather than parking it on a global god-object.

Result: one source of truth (the store), no mirror to keep in sync, side-effects reactive and local.

---

## 4. Settings & day-night: split the god-object, stop the per-frame round-trip

**Problem A — `EnvironmentSettings` is a ~50-field grab-bag** (`store.ts:96-164`) spanning day/night time, sun/moon/hemisphere lighting, shadows, tone mapping, post-processing intensities, color correction, and voxel light fill. Low cohesion; everything that touches lighting touches this blob → the "time-of-day couples with everything" feeling.

**Problem B — the per-frame store round-trip.** `DayNightCycle.updateDayNightCycle()` (`:128-201`) reads `environment`, derives ~12 values from `timeOfDay`, and writes them **back into the store every frame** via `setEnvironment(updates)`; then `GameCore` immediately reads them back and `applyEnvironmentSettings()` pushes the **whole blob** to THREE lights + sky uniforms + renderer every frame (`GameCore.ts:410-411`). The store is being used as a per-frame message bus with a frame of latency, and the derived values (sunColor, moonIntensity, hemisphere colors…) are shadow copies of what the lights already are.

**Problem C — three reactivity mechanisms for one settings object:** poll-and-push every frame (env/lighting), full store subscription with manual field-diffing (`effects.ts:252`), and a dedicated single-field subscription (shadow blur, `Lighting.ts:146`). No convention.

**Problem D — duplication:** `formatTimeOfDay` defined identically in `DayNightCycle.ts:208` and `Lighting.ts:540`; hemisphere sky uses `getPhaseColorGradient` while ground uses `getPhaseColor` for the same time.

**Plan:**
- **Split `EnvironmentSettings` into cohesive slices** in the store: `time` (`{enabled, timeOfDay, timeSpeed}`), `lighting` (sun/moon/hemisphere manual overrides + auto flags), `postFx` (ssao/bloom/godrays/colorCorrection intensities — currently split awkwardly between top-level flags and `environment.*`), `toneMapping`, `voxelLightFill`. Keep them as separate keys on `GameState` so a UI panel or subsystem subscribes only to its slice.
- **Make lighting a subscriber, not a per-frame push.** `DayNightCycle` should compute derived sun/moon/hemisphere values and apply them **directly to the THREE objects** (it already calls `updateShadowCaster` directly, `:174`) — the store holds only the *inputs* (`timeOfDay`, `timeSpeed`, auto flags, manual overrides), not the per-frame *outputs*. `applyEnvironmentSettings` becomes an **on-change** subscriber (diff-driven) for the static config (skybox, tone mapping, manual overrides), not a per-frame call. This removes the round-trip and the coupling: time-of-day drives lights through one owner, and unrelated settings stop being re-applied every frame.
- **One reactivity convention:** settings that change occasionally → store subscription with a small diff (the `effects.ts` pattern); values that change every frame (the animated sun) → owned by their subsystem, never round-tripped through the store.
- De-dupe `formatTimeOfDay` into `shared/src/scene/daynight.ts`; align hemisphere ground/sky to the same blend fn.

**Fix the drifted test:** `store.test.ts:12-36` resets the store with a stale shape (`gameMode:'explore'` string vs the `GameMode` enum; a partial `build` object missing `snapPoint/snapGrid/menuOpen/presetConfigs/presetMeta`; `useServerChunks:false` vs default `true`). Update it to the real interfaces or derive the reset from `DEFAULT_*`.

---

## 5. Quality system: collapse the triplication

Quality state exists in **three** places kept in sync by hand:
1. `QUALITY_PRESETS` (canonical, `QualityPresets.ts:51`),
2. `QualityManager.currentSettings` (live applied copy, `QualityManager.ts:41`),
3. flat quality fields on the Zustand store (`store.ts:339-355`),

with `syncQualityToStore` (`:129-147`) hand-copying **13 fields** into the store — add a field to `QualitySettings` and forget this list, and the store silently goes stale. `shadowMapSize` is even written to two homes at once (`applyQuality:75-76`). Routing is inconsistent (bloom/ssao/msaa via store; colorCorrection via a direct `updatePostProcessing` into now-dead code).

**Plan:**
- Make **the store the single home** for the active `QualitySettings` object (one key `quality: QualitySettings`), seeded from `QUALITY_PRESETS[level]`. Drop the 16 flat fields and `QualityManager.currentSettings`.
- `applyQuality(level)` = `setState({ quality: {...QUALITY_PRESETS[level], visibilityRadius: custom ?? preset} })`. Everything else becomes **subscribers** to `quality`: renderer (pixelRatio, renderScale, shadows), `effects.ts` (ssao/bloom/godrays/msaa), `TerrainMaterial` (shader defines, anisotropy), `VoxelWorld` (visibility radius). No hand-copy, no third mirror.
- Add the two new levers from §1: `godRaysEnabled` and `renderScale` to `QualitySettings` and every preset.

---

## 6. Voxel core: tame the god-object and the tri-modal geometry

The algorithms are good; the **ownership and responsibility boundaries** are what make it hard to follow.

### 6.1 `VoxelWorld.ts` (1167 lines) is a god-object — extract three collaborators
It fuses: chunk store, a **network request state machine** (3 pending sets + 3 timestamp maps + stale expiry + NACK, `:77-88,235-266,622-651,829`), two-phase tile→chunk streaming, **lighting orchestration**, visibility BFS caching, unloading, and **build-op application + deferral**. Extract (mechanical moves, no algorithm change):
- **`ChunkRequestManager`** — all pending/timestamp/stale/NACK/request-encoding logic. This is also the seam for §8 local-only (see below).
- **`LightingCoordinator`** — `computeChunkSunlight` + the neighbor relight cascade that is **copy-pasted** between `ingestChunkData:724-748` and `executeBuildOperation:1035-1067`. De-dupe into one method.
- **`BuildApplier`** — `applyBuildOperation`/`executeBuildOperation`/`drainDeferredBuildOps`. This is also the natural home for an **undo command stack** later (§8).

### 6.2 `ChunkGrouper.ts` (813 lines) — extract the build-preview state machine
Its real job (bucket 4³ chunks → one merged, world-baked BufferGeometry per layer per group → fewer draw calls) is ~150 lines. The bloat is a **build-preview "suppression" state machine** (~1/3 of the file: `previewSuppressed`, `suppressionPending`, `suppressGroup/restoreGroup/applySuppression/…`, `:296-544`) that is a *BuildPreview concern leaked into the grouper*, plus a parallel "standalone mesh" pop-in path. Extract the suppression machinery into a `BuildPreviewController` that drives the grouper through a small API; keep buffer-growth/bounds management in the grouper.

### 6.3 Tri-modal geometry ownership is the single biggest "hard to follow" cause
A chunk's geometry exists simultaneously as: `ChunkGeometry.mainMeshes` (per-chunk, feeds collision), a grouper **standalone** mesh (pop-in avoidance), and a grouper **merged** group mesh (steady state). Which is "in the scene" depends on `group.merged`/`previewSuppressed`. Document this explicitly and, ideally, make the standalone path a clearly-named transitional state owned by the grouper so readers can trace "what's actually rendered."

### 6.4 Lighting + visibility run on the MAIN thread inside ingestion
`ingestChunkData` runs `computeAndPropagateLight` (O(n³) BFS) and `computeVisibility` on the main thread, and re-lights neighbors on every arrival — while the worker only does SurfaceNets + geometry expansion (`meshWorker.ts:47-52`). So the cheap-but-parallel part is offloaded and the expensive BFS stays on the main thread, coupling "receive data" to "compute lighting" and making correctness depend on arrival order (hence the reversal in `receiveSurfaceColumnData:812-817`). **Recommendation:** move lighting into the worker alongside meshing (it already has the neighbor grid), or at least off the ingestion hot path. Structural + perf win; do it *after* the extractions in 6.1 so ownership is clear.

### 6.5 Smaller drift to clean up
- **Duplicated coordinate math:** open-coded `key.split(',').map(Number)` in `VoxelWorld.ts:491,501,512` and `ChunkGrouper.ts:551` despite `parseChunkKey` (`voxelData.ts:307`); `Math.floor(pos/CHUNK_WORLD_SIZE)` in `VoxelCollision.ts:177` / `RemeshPipeline.ts:94` despite `worldToChunk`; grid-index↔coord decoded twice in `VisibilityBFS.ts:105-120,188-195`. Route all through the shared helpers.
- **Dead frustum plumbing:** `VisibilityBFS.getVisibleChunks` takes `_frustum`/`_cameraDir` but they're **unused** (frustum cull commented out, `:269-279`); `VoxelWorld` still computes and threads them (`:335-336`). Remove the dead parameters or reinstate the feature.
- **Latent bug:** `VisibilityBFS` sizes its typed-array queues from the compile-time `VISIBILITY_RADIUS`, but the world uses a **dynamic** `_visibilityRadius` (`VoxelWorld.ts:217`). If runtime radius ever exceeds the constant, the pre-allocated grid silently under-sizes. Size the buffers from the dynamic max, or clamp+assert.
- **SurfaceNet subarray-view contract:** `meshVoxelsSplit` returns shared mutable views into module pools valid only until the next call (`:549-598`) — safe only single-threaded in the worker. Add a loud comment / guard so no future main-thread caller trips it.

---

## 7. Recommended target structure (delta from today)

```
client/src/state/
  store.ts            # single source of truth; sliced settings (time/lighting/postFx/quality/...)
  transient.ts        # NEW: non-reactive frame data (map positions) + debug-stats rate limiter
  (bridge.ts)         # DELETED — call useGameStore.getState()/setState() directly
client/src/game/scene/
  DayNightCycle.ts     # owns animated lights; store holds inputs only, no per-frame writeback
  Lighting.ts          # applyEnvironmentSettings becomes on-change subscriber, not per-frame
  effects.ts           # + godRays gated by quality; colorCorrection routed here
  (postprocessing.ts) # DELETED — dead duplicate pipeline
  SkyDome.ts           # star layers gated by quality
client/src/game/quality/
  QualityPresets.ts    # + godRaysEnabled, + renderScale on every preset
  QualityManager.ts    # thin: setState({quality}); subsystems subscribe. No currentSettings mirror, no syncQualityToStore
client/src/game/voxel/
  VoxelWorld.ts        # orchestration only
  ChunkRequestManager.ts  # NEW: pending/stale/NACK/request encoding  (also the local-only seam)
  LightingCoordinator.ts  # NEW: dedup'd relight cascade (ideally move into worker)
  BuildApplier.ts         # NEW: build ops + deferral (undo-stack seam)
  ChunkGrouper.ts         # merging + buffers only
  BuildPreviewController.ts # NEW: extracted suppression/standalone state machine
```

Everything above is refactor/extraction of existing code plus two small perf levers — no algorithm rewrites.

---

## 8. Seams these refactors open for your roadmap (not planned in detail — just why the shape helps)

- **Local-only prototype:** the foundation partly exists (`useServerChunks` flag + client `generateChunk` via the shared `TerrainGenerator`). Extracting **`ChunkRequestManager`** (6.1) lets you define a `ChunkSource` interface with `ServerChunkSource` vs `LocalChunkSource` (generate + persist to IndexedDB) implementations — `VoxelWorld` stops caring where chunks come from. A local persistence layer here is also where **snap-point storage on reload** lives.
- **Undo:** routing build ops through **`BuildApplier`** (6.1) makes an undo command stack a natural addition (each op already returns modified chunk keys).
- **Mobile build controls (tap+drag the cast point):** decoupling input from the desktop pointer-lock look (currently `controls.ts` + `Builder.update`) into an input-source abstraction lets a touch source drive the cast point independently of camera look.
- **3rd-person LoD zoom:** the grouper/mesher already merge per-group geometry; a coarse-LoD mesher variant (larger voxel step, single dominant material — the depth-pass pattern in `terrainShaders.ts:423`) plugged into the same grouper is the path. The render-scale lever (§1.2) and quality-as-store-slice (§5) make a distinct "map mode" quality profile trivial.

None of these should be built until §1 and §3–§6 land; they're the reason to prefer these seams.

---

## 9. Prioritized roadmap

**P0 — performance (small, high impact, do first):**
1. Gate god rays by quality (§1.1).
2. Add `renderScale` and wire it into resize/composer (§1.2).
3. Gate sky star layers (§1.3) and water samples (§1.4) by quality.
4. Delete dead `postprocessing.ts` (§1.6).

**P1 — state clarity (unlocks everything else):**
5. Delete `bridge.ts`; move to direct store access + `transient.ts` + shader subscriptions (§3).
6. Collapse quality triplication to a single store slice (§5).

**P2 — settings de-coupling:**
7. Split `EnvironmentSettings` into slices; make lighting a subscriber, kill the per-frame round-trip; fix `store.test.ts` (§4).

**P3 — voxel structure (largest, do last, incrementally):**
8. Extract `ChunkRequestManager`, `LightingCoordinator` (dedup cascade), `BuildApplier` from `VoxelWorld` (§6.1).
9. Extract `BuildPreviewController` from `ChunkGrouper` (§6.2).
10. Route coord math through shared helpers; remove dead frustum params; fix the visibility-buffer sizing bug (§6.5).
11. (Optional/perf) move lighting BFS into the worker (§6.4).

Each item is independently shippable and testable.

---

## 10. Verification

- **Perf (P0):** run the app (`npm run dev`), open the debug panel (FPS + `PerfSnapshot.render`/`drawCalls`). Confirm on Low that god rays are off; measure FPS at 1080p vs a forced 4K (or DPR-emulated) window before/after `renderScale`. Target: Low preset at 4K should be fill-rate-flat as `renderScale` drops. Use the existing `PerformanceStats` overlay; no new tooling needed.
- **Refactors (P1–P3):** the repo has strong vitest coverage for the voxel/build/spawn paths (`SurfaceNet.test.ts`, `Chunk*.test.ts`, `VoxelWorld.test.ts`, `SpawnBuildIntegration.test.ts`, `buildMessages.test.ts`, etc.). Run `npm run test:run` after each extraction — behaviour is unchanged, so tests must stay green. Update `store.test.ts` to the real shapes as part of §4.
- **Regression sweep:** manually verify day/night still animates and lights update, build preview/commit still works, chunk streaming + culling behave on movement, and collision is unchanged — these are the surfaces the refactors touch.
