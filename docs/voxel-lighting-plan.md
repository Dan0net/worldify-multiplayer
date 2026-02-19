# Voxel Lighting Implementation Plan

## Overview
Minecraft-style voxel lighting using the existing 5-bit light field (0-31). Sunlight propagates down from sky, lava emits block light. Single channel: `max(sun, block)`. Client-side only — server sends light=0.

## Key Decisions
- **5 packed bits** (existing `LLLLL` field), range 0-31
- **Max sampling** at vertices — SurfaceNet takes max light of non-solid 2x2x2 corners
- **Attenuation by 1 per voxel step** — simple decrement, no doubling
- **Client-side compute before meshing** — light runs in `ingestChunkData()`, before remesh queue
- **Only on committed builds** — preview meshes skip light recalculation
- **Unknown chunk above?** If `cy >= maxCy` (from tile data), assume full sunlight from above. Otherwise assume dark, relight downward when chunk above loads.

## Phase 1: Light Attribute Pipeline + Debug View
Pipe light from voxel data → vertex attribute → shader debug mode.

1. `SurfaceNet.ts` — Add `lights: Float32Array` to output. For each vertex, max light of non-solid corners in 2x2x2 cell.
2. `MeshGeometry.ts` — Add `lightLevels: Float32Array` (1 per vertex) to `ExpandedMeshData`, flow through `expandGeometry()`.
3. `meshWorker.ts` + `MeshWorkerPool.ts` — Transfer `lightLevels` buffer.
4. `ChunkMesh.ts` — Set `lightLevel` attribute on `BufferGeometry`.
5. `terrainShaders.ts` — `attribute float lightLevel` / `varying float vLightLevel`. Debug mode: `gl_FragColor = vec4(vec3(vLightLevel), 1.0)`.
6. `store.ts` — Add 'VoxelLight' to `TERRAIN_DEBUG_MODE_NAMES`, bump cycle modulus.

## Phase 2: Sunlight Column Propagation
Fill sky-exposed air voxels with light=31.

1. **NEW** `shared/src/voxel/lighting.ts` — `computeSunlightColumn(chunk, chunkAboveData?, isAboveSkyExposed?)`:
   - Per (lx,lz) column scan from ly=31 downward
   - If chunk above loaded: continue sunlight if bottom voxel of chunk above was sunlit
   - If chunk above NOT loaded AND `cy >= maxCy`: assume sunlit from above
   - If chunk above NOT loaded AND `cy < maxCy`: assume dark from above
   - Non-opaque voxel → light=31, opaque → stop column
2. `VoxelWorld.ts` — Call `computeSunlightColumn()` in `ingestChunkData()` before remesh queue. When a new chunk loads, re-light the chunk below and mark it for remesh.

## Phase 3: Sunlight Horizontal BFS
Light spreads sideways from lit voxels into adjacent non-opaque voxels, attenuating by 1 per step.

1. `shared/src/voxel/lighting.ts` — `propagateLight(data)`:
   - Single-chunk BFS from all voxels with light>0 into 6-face-adjacent non-opaque voxels
   - Each step decrements light by 1; only updates if new value > existing
   - No cross-chunk propagation yet (keeps it simple)
2. `VoxelWorld.ts` — Call `propagateLight()` after `computeSunlightColumns()` in `computeChunkSunlight()`.

## Phase 4: Lava Light Emission
1. `shared/src/materials/` — `isEmitting(id)`, lava(50) emits level ~24
2. `pallet.json` — Add `"emitting": { "50": 24 }`
3. `lighting.ts` — Seed BFS from emitting voxels alongside sunlight

## Phase 5: Shader Integration
Use `vLightLevel` to attenuate scene lighting in the PBR output.
- `totalIrradiance *= vLightLevel` — dims sun/hemisphere in caves
- Outdoor terrain renders identically to current (lightLevel=1.0)

## Phase 6: Build-Triggered Relighting
In `applyBuildCommit()` (not preview): clear light in affected chunks, re-run column + BFS, remesh.
