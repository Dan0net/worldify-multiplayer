# Voxel Lighting Implementation Plan

## Overview
Two-channel Minecraft-style voxel lighting. **Sky light** (sun exposure) and **block light** (emitters like lava/torches) are computed separately client-side into temp buffers, then combined in the shader with a time-of-day uniform so underground block light stays consistent across the day/night cycle.

## Key Decisions
- **Light is NOT packed into the 16-bit voxel** — server sends `WWWW MMMMMMM 00000` (5 light bits unused on wire, reserved for future use)
- **Sky light**: single `Uint8Array(32³)` per chunk, range 0–31
- **Block light**: three `Uint8Array(32³)` per chunk — `blockR`, `blockG`, `blockB`, range 0–31 each. Three independent BFS passes, one per channel.
- **Vertex attributes**: `float skyLight` + `vec3 blockLightColor` (RGB, 0–1)
- **Shader combines**: `vec3 light = max(vec3(vSkyLight * skyBrightness), vBlockLightColor)` where `skyBrightness` is driven by day/night (1.0 noon → 0.15 midnight)
- **Attenuation by 1 per voxel step** per channel — red/green/blue attenuate independently, preserving emitter hue while dimming intensity
- **Client-side compute before meshing** — light runs in `ingestChunkData()`, before remesh queue
- **Only on committed builds** — preview meshes skip light recalculation
- **Unknown chunk above?** If `cy >= maxCy` (from tile data), assume full sunlight from above. Otherwise assume dark, relight downward when chunk above loads.

## Block Light Color
Emitters define RGB emission in `pallet.json`: e.g. torch `[24, 20, 12]`, lava `[24, 18, 5]`, blue crystal `[4, 8, 24]`.
Three independent BFS passes (one per R/G/B channel) propagate each component separately, decrementing by 1 per step. This naturally preserves hue while dimming — a torch `[24,20,12]` at 10 voxels out becomes `[14,10,2]`, still warm but dimmer. Temp memory: 3 × 32KB = 96KB per chunk, freed after meshing.

## Phase 1: Light Attribute Pipeline + Debug View
Pipe light from voxel data → vertex attribute → shader debug mode.

1. `SurfaceNet.ts` — Output `skyLights: Float32Array` (1/vertex) + `blockLightColors: Float32Array` (3/vertex RGB). Max of non-solid 2x2x2 corners per channel.
2. `MeshGeometry.ts` — Add both to `ExpandedMeshData`, flow through `expandGeometry()`.
3. `meshWorker.ts` + `MeshWorkerPool.ts` — Transfer both buffers.
4. `ChunkMesh.ts` — Set `skyLight` (float) and `blockLightColor` (vec3) attributes.
5. `terrainShaders.ts` — `uniform float skyBrightness`. Combine: `vec3 light = max(vec3(vSkyLight * skyBrightness), vBlockLightColor)`.
6. `store.ts` — Debug modes for sky light and block light color separately.

## Phase 2: Sunlight Column Propagation
Fill sky-exposed air voxels with skyLight=31 into the temp `Uint8Array`.

1. **`shared/src/voxel/lighting.ts`** — `computeSunlightColumns()` writes to a separate `skyLight` buffer (not packed voxel data).
   - Per (lx,lz) column scan from ly=31 downward
   - Non-opaque → skyLight=31, opaque → stop column
   - Uses `lightFromAbove` from chunk above (or null = full sun)
2. `VoxelWorld.ts` — Call in `ingestChunkData()` before remesh. Re-light chunk below when new chunk loads.

## Phase 3: Sunlight Horizontal BFS
Sky light spreads sideways from lit voxels, attenuating by 1 per step.

1. `shared/src/voxel/lighting.ts` — `propagateSkyLight(data, skyLight)`: BFS on the `skyLight` buffer only.
2. Runs after `computeSunlightColumns()`.

## Phase 4: Block Light RGB Emission + BFS
Three independent BFS passes for colored block light.

1. `pallet.json` — Per-material `"emission": [R, G, B]` (0–31 per channel).
2. `shared/src/materials/` — `MATERIAL_EMISSION_RGB_LUT: Uint8Array(128*3)`.
3. `lighting.ts` — `computeBlockLightRGB(data): {blockR, blockG, blockB}` (three `Uint8Array(32³)`). Seed emitters with their R/G/B values, run BFS per channel (reuse same propagation logic), decrement by 1 per step.
4. SurfaceNet reads all three buffers, outputs `vec3 blockLightColor` per vertex.

## Phase 5: Shader Integration
- `vec3 light = max(vec3(vSkyLight * skyBrightness), vBlockLightColor); outgoingLight *= light;`
- Outdoor terrain: skyLight=1.0 at noon, block light negligible
- Underground: block light RGB dominates, consistent across day/night
- `DayNightCycle.ts` pushes `skyBrightness` uniform (1.0 noon → 0.15 midnight)

## Phase 6: Build-Triggered Relighting
In `applyBuildCommit()` (not preview): clear sky + blockRGB buffers in affected chunks, re-run columns + BFS, remesh.

## Phase 7: Remove Light Bits from Voxel Packing (Optional)
Reclaim the 5 `LLLLL` bits from the 16-bit packed voxel for more weight or material precision. Requires updating `packVoxel()`/`unpackVoxel()`, constants, and all consumers.
