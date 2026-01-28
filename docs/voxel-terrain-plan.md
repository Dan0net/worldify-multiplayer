# SurfaceNet Voxel Terrain - Implementation Plan

## Overview

Add SurfaceNet-based voxel terrain to the game, replacing the existing build system. Chunks are rendered using SurfaceNet meshing algorithm which creates smooth terrain by finding the surface at the 0-crossing of weight values.

---

## Specification

### Voxel Format

Each voxel is a **16-bit unsigned integer** with the following bit layout:

| Field      | Bits | Range       | Description                              |
|------------|------|-------------|------------------------------------------|
| Weight     | 4    | 0-15        | Maps to -0.5 to +0.5 (surface at 0)      |
| MaterialID | 7    | 0-127       | Material/texture index                   |
| Light      | 5    | 0-31        | Light level for rendering                |

```
Bit layout: WWWW MMMMMMM LLLLL
            4    7       5     = 16 bits
```

**Configurable via constants** - all bit sizes and ranges should be defined in a shared constants file.

### Chunk Dimensions

- **Chunk size**: 32×32×32 voxels
- **Voxel scale**: 0.25m per voxel
- **Chunk world size**: 8m × 8m × 8m
- **Coordinate system**: Centered at world origin (0,0,0) - negative chunk coords allowed

### World Layout

- **Initial load**: 4×4×4 chunks around the player (64 chunks total)
- **Streaming radius**: 4×4×4 chunks around player position
- **Initial terrain**: Flat surface at height Y=10 (2.5m in world units)

### Chunk Stitching

Chunks share voxel data on overlapping margins to ensure seamless mesh connections:
- Each chunk samples 1 voxel beyond its bounds from neighbors
- Margin data is copied when chunks are generated/loaded

### Collision

- Use **FastBVH** or similar spatial acceleration structure
- Build BVH from chunk mesh triangles
- Raycast and sphere/capsule collision against terrain

### Materials (Phase 1)

Simple color mapping:
| ID | Color  |
|----|--------|
| 0  | Green  |
| 1  | Red    |
| 2  | Blue   |
| 3  | Yellow |
| 4  | Cyan   |
| 5  | Magenta|
| ...| etc    |

---

## Architecture

### Folder Structure

```
shared/src/
  voxel/
    constants.ts      # Bit sizes, chunk size, voxel scale
    voxelData.ts      # Pack/unpack voxel data
    
client/src/game/
  voxel/
    VoxelWorld.ts     # Chunk manager, streaming logic
    Chunk.ts          # Single chunk: data + mesh + BVH
    SurfaceNet.ts     # Meshing algorithm
    ChunkMesh.ts      # Three.js mesh generation
    VoxelCollision.ts # BVH-based collision
    VoxelMaterials.ts # Material definitions
    VoxelDebug.ts     # Debug wireframes, chunk bounds, labels
    
server/src/
  voxel/
    VoxelWorld.ts     # Server-side chunk manager
    Chunk.ts          # Server chunk (data only, no mesh)
    ChunkGenerator.ts # Seed-based generation
```

### Data Flow

```
Phase 1 (Client-only):
  Client generates chunks → Mesh → Render → Collide

Phase 2 (Server sync):
  Server generates chunks → Send to client → Client meshes → Render → Collide
  Client sends build commands → Server validates → Server broadcasts deltas
```

---

## Staged Implementation Plan

### Stage 1: Shared Constants & Voxel Data Utils

**Goal**: Define shared constants and voxel packing/unpacking utilities.

**Files**:
- `shared/src/voxel/constants.ts`
- `shared/src/voxel/voxelData.ts`
- `shared/src/index.ts` (export new modules)

**Tasks**:
1. Define constants:
   - `CHUNK_SIZE = 32`
   - `VOXEL_SCALE = 0.25`
   - `WEIGHT_BITS = 4`, `MATERIAL_BITS = 7`, `LIGHT_BITS = 5`
   - `WEIGHT_MIN = -0.5`, `WEIGHT_MAX = 0.5`
   - `STREAM_RADIUS = 4` (chunks in each direction)
   
2. Implement voxel pack/unpack functions:
   - `packVoxel(weight: number, material: number, light: number): number`
   - `unpackVoxel(packed: number): { weight, material, light }`
   - `getWeight(packed: number): number`
   - `getMaterial(packed: number): number`
   - `getLight(packed: number): number`

3. Chunk coordinate helpers:
   - `worldToChunk(x, y, z): ChunkCoord`
   - `chunkToWorld(cx, cy, cz): Vector3`
   - `worldToVoxel(x, y, z): VoxelCoord`
   - `voxelIndex(x, y, z): number` (flat array index)

**Tests**: Unit tests for pack/unpack round-trip, coordinate conversions.

**Success Criteria**:
- [ ] All constants exported and importable from shared package
- [ ] `packVoxel(0.0, 5, 16)` → `unpackVoxel()` returns exact values
- [ ] Weight edge cases: -0.5 and +0.5 round-trip correctly
- [ ] `worldToChunk(8.1, 0, 0)` returns `(1, 0, 0)` (next chunk at 8m)
- [ ] `voxelIndex(31, 31, 31)` returns `32767` (last index)

---

### Stage 2: Chunk Data Structure (Client)

**Goal**: Create chunk class that holds voxel data array.

**Files**:
- `client/src/game/voxel/Chunk.ts`

**Tasks**:
1. Create `Chunk` class:
   - `data: Uint16Array` (32×32×32 = 32,768 voxels)
   - `cx, cy, cz: number` (chunk coordinates)
   - `dirty: boolean` (needs remesh flag)
   
2. Methods:
   - `getVoxel(x, y, z): number`
   - `setVoxel(x, y, z, value: number)`
   - `getWeight(x, y, z): number`
   - `fill(weight, material, light)` - fill entire chunk
   - `generateFlat(surfaceY: number)` - generate flat terrain

3. Margin sampling:
   - `getVoxelWithMargin(x, y, z, neighbors: Map<string, Chunk>): number`
   - Handles -1 and 32 coordinates by sampling from neighbors

**Success Criteria**:
- [ ] `new Chunk(0, 0, 0)` creates chunk with 32,768 voxel array
- [ ] `setVoxel(5, 5, 5, value)` → `getVoxel(5, 5, 5)` returns same value
- [ ] `generateFlat(10)` fills voxels below Y=10 with positive weight, above with negative
- [ ] `getVoxelWithMargin(-1, 5, 5, neighbors)` correctly samples from neighbor at cx-1
- [ ] Chunk correctly reports `dirty = true` after any `setVoxel` call

---

### Stage 3: SurfaceNet Meshing Algorithm

**Goal**: Implement SurfaceNet algorithm to generate mesh from chunk data.

**Files**:
- `client/src/game/voxel/SurfaceNet.ts`

**Tasks**:
1. Implement SurfaceNet algorithm:
   - For each cell (2×2×2 voxels), check if surface crosses (sign change in weights)
   - Calculate vertex position by interpolating based on weights
   - Generate quads/triangles connecting vertices
   
2. Input: Chunk data + neighbor margin data
3. Output: `{ positions: Float32Array, normals: Float32Array, indices: Uint32Array, materials: Uint8Array }`

4. Handle chunk boundaries using margin data from neighbors

**Reference**: Based on Mikola Lysenko's SurfaceNet implementation.

**Success Criteria**:
- [ ] Meshing a fully solid chunk (all weights > 0) produces no geometry
- [ ] Meshing a fully empty chunk (all weights < 0) produces no geometry
- [ ] Flat terrain at Y=16 produces a flat quad grid across the chunk
- [ ] Output arrays have matching vertex counts (positions.length/3 === normals.length/3)
- [ ] Generated normals point "outward" (away from solid, toward empty)
- [ ] Mesh vertices at chunk boundary align with neighbor chunk vertices

---

### Stage 4: Chunk Mesh Rendering

**Goal**: Convert SurfaceNet output to Three.js mesh.

**Files**:
- `client/src/game/voxel/ChunkMesh.ts`
- `client/src/game/voxel/VoxelMaterials.ts`

**Tasks**:
1. `VoxelMaterials`:
   - Define color array for material IDs
   - Create shared `THREE.MeshStandardMaterial` or vertex-colored material
   
2. `ChunkMesh`:
   - `createMesh(geometry: SurfaceNetOutput): THREE.Mesh`
   - Build `THREE.BufferGeometry` with positions, normals, colors
   - Apply vertex colors based on material IDs
   - Return mesh positioned at chunk world position

3. Handle mesh disposal when chunk unloads

**Success Criteria**:
- [ ] Single chunk with flat terrain renders as visible green surface
- [ ] Mesh is positioned correctly at chunk world coordinates
- [ ] Material ID 0 = green, 1 = red, 2 = blue visible in rendered mesh
- [ ] No console errors about disposed geometries
- [ ] Mesh receives lighting (normals working correctly)
- [ ] `disposeMesh()` properly cleans up geometry and removes from scene

---

### Stage 5: Voxel World Manager (Client)

**Goal**: Manage chunk loading/unloading around player.

**Files**:
- `client/src/game/voxel/VoxelWorld.ts`

**Tasks**:
1. Create `VoxelWorld` class:
   - `chunks: Map<string, Chunk>` (key = "cx,cy,cz")
   - `meshes: Map<string, THREE.Mesh>`
   - `scene: THREE.Scene` reference
   
2. Initialization:
   - `init()` - Generate initial 4×4×4 chunks around origin
   - All chunks generate flat terrain at Y=10

3. Streaming:
   - `update(playerPos: Vector3)` - called each frame
   - Calculate which chunks should be loaded based on player position
   - Load new chunks that come into range
   - Unload chunks that go out of range
   - Use chunk coordinates centered at 0,0,0

4. Chunk generation:
   - `generateChunk(cx, cy, cz): Chunk`
   - For now: flat terrain generator
   - Later: seed-based procedural generation

5. Mesh management:
   - `remeshChunk(chunk: Chunk)` - regenerate mesh when dirty
   - Add/remove meshes from scene

6. Neighbor awareness:
   - When generating mesh, provide neighbor chunk data for margins
   - Queue neighbor remesh when chunk changes

**Success Criteria**:
- [ ] On init, 64 chunks (4×4×4) are created and meshed
- [ ] Flat terrain visible spanning all loaded chunks seamlessly
- [ ] Moving player +8m in X loads new chunks, unloads old ones
- [ ] No visible seams between adjacent chunks
- [ ] Chunk count stays constant as player moves (streaming works)
- [ ] Performance: chunk load/unload doesn't cause frame drops
- [ ] `getChunk(cx, cy, cz)` returns correct chunk or undefined

---

### Stage 6: Debug Rendering

**Goal**: Visual debugging tools for chunk boundaries, empty chunks, and collision meshes.

**Files**:
- `client/src/game/voxel/VoxelDebug.ts`
- `client/src/ui/DebugPanel.tsx` (add toggles)

**Tasks**:
1. Chunk boundary visualization:
   - `createChunkBoundsHelper(chunk: Chunk): THREE.LineSegments`
   - Wireframe box showing chunk extents (8m × 8m × 8m)
   - Color coding: green = has mesh, yellow = empty (no surface), red = loading

2. Empty chunk markers:
   - Small marker or translucent box for chunks with no geometry
   - Helps identify where terrain doesn't exist

3. Collision mesh wireframe:
   - `createCollisionWireframe(mesh: THREE.Mesh): THREE.LineSegments`
   - Wireframe overlay showing exact collision triangles
   - Different color from render mesh (e.g., cyan)

4. Debug toggle system:
   - `VoxelDebug.showChunkBounds: boolean`
   - `VoxelDebug.showEmptyChunks: boolean`
   - `VoxelDebug.showCollisionMesh: boolean`
   - `VoxelDebug.showChunkCoords: boolean` (text labels at chunk centers)

5. UI integration:
   - Add checkboxes to DebugPanel for each toggle
   - Keyboard shortcuts (e.g., F1-F4)

6. Performance:
   - Debug visuals only created when enabled
   - Proper cleanup when toggled off

**Success Criteria**:
- [ ] Pressing debug key shows wireframe boxes around all loaded chunks
- [ ] Empty chunks (above terrain) show yellow/transparent markers
- [ ] Collision wireframe overlays exactly on rendered terrain mesh
- [ ] Chunk coordinate labels readable at chunk centers
- [ ] Toggling debug off removes all debug geometry from scene
- [ ] Debug rendering has minimal performance impact when disabled
- [ ] DebugPanel shows toggle states and chunk statistics

---

### Stage 7: Collision System

**Goal**: Player collision with voxel terrain.

**Files**:
- `client/src/game/voxel/VoxelCollision.ts`
- Update `client/src/game/player/playerLocal.ts`

**Tasks**:
1. Integrate FastBVH or implement simple BVH:
   - Build BVH from chunk mesh triangles
   - Rebuild when chunk remeshes
   
2. `VoxelCollision` class:
   - `buildBVH(chunk: Chunk, mesh: THREE.Mesh)`
   - `raycast(origin, direction, maxDist): Hit | null`
   - `sphereCollide(center, radius): CollisionResult`
   - `capsuleCollide(p1, p2, radius): CollisionResult`

3. World-level collision:
   - Query relevant chunks based on position
   - Aggregate collision results

4. Integrate with player movement:
   - Replace existing collision with voxel collision
   - Ground detection for gravity
   - Wall sliding

**Success Criteria**:
- [ ] BVH builds successfully from chunk mesh
- [ ] Raycast from above terrain hits surface at correct Y position
- [ ] Raycast through empty space returns null
- [ ] Player standing on terrain doesn't fall through
- [ ] Player can walk up gentle slopes
- [ ] Player collides with terrain walls (can't walk through hills)
- [ ] Collision works correctly at chunk boundaries
- [ ] Debug wireframe (Stage 6) matches collision behavior exactly

---

### Stage 8: Integration & Cleanup

**Goal**: Wire everything together, remove old build system.

**Files**:
- `client/src/game/createGame.ts`
- `client/src/game/GameCore.ts`
- Remove/deprecate build system files

**Tasks**:
1. Initialize `VoxelWorld` in game setup
2. Add to game update loop
3. Connect collision to player controller
4. Remove old build pieces, territory, etc.
5. Update camera/lighting if needed for terrain

**Success Criteria**:
- [ ] Game starts with voxel terrain visible
- [ ] Player spawns above terrain and lands on surface
- [ ] Player can walk around on terrain
- [ ] Old build system code removed or disabled
- [ ] No console errors related to old systems
- [ ] Camera follows player over terrain correctly
- [ ] Lighting looks correct on terrain surface

---

### Stage 8: Server-Side Chunk Management

**Goal**: Server generates and stores chunk data.

**Files**:
- `server/src/voxel/Chunk.ts`
- `server/src/voxel/VoxelWorld.ts`
- `server/src/voxel/ChunkGenerator.ts`

**Tasks**:
1. Port shared chunk data structure to server
2. Server `VoxelWorld`:
   - Generate chunks on demand
   - Store active chunks in memory
   - Track which chunks each player has received

3. `ChunkGenerator`:
   - `generate(cx, cy, cz, seed): Uint16Array`
   - For now: flat terrain
   - Later: use room ID as seed for procedural generation
**Success Criteria**:
- [ ] Server can create and store chunks in memory
- [ ] `ChunkGenerator.generate()` produces identical data to client generator
- [ ] Server tracks which chunks exist per room
- [ ] Server can retrieve chunk by coordinates
- [ ] Memory usage stays bounded (chunks cleaned up when room closes)
---

### Stage 9: Chunk Network Protocol

**Goal**: Define protocol for sending chunk data to clients.

**Files**:
- `shared/src/protocol/chunk.ts`
- `shared/src/protocol/msgIds.ts`
- `server/src/net/encode.ts`
- `client/src/net/decode.ts`

**Tasks**:
1. Define message types:
   - `CHUNK_DATA` - full chunk data (cx, cy, cz, compressed data)
   - `CHUNK_UNLOAD` - tell client to unload chunk
   
2. Compression:
   - RLE or similar for chunk data (lots of empty/solid regions)
   - Consider delta compression for updates

3. Encode/decode functions
**Success Criteria**:
- [ ] `CHUNK_DATA` message ID added to protocol
- [ ] Chunk data round-trips through encode/decode without data loss
- [ ] Compression reduces flat terrain chunk from 64KB to <1KB
- [ ] Decode produces identical Uint16Array to original
- [ ] Message format documented in protocol file
---

### Stage 10: Client-Server Chunk Sync

**Goal**: Client receives chunks from server instead of generating locally.

**Files**:
- `server/src/rooms/room.ts`
- `server/src/ws/wsServer.ts`
- `client/src/net/netClient.ts`
- `client/src/game/voxel/VoxelWorld.ts`

**Tasks**:
1. Server tracks player positions
2. Server sends chunks as players move into new areas
3. Client receives and meshes chunks from server
4. Client requests chunks it needs (or server pushes proactively)
5. Handle chunk data on join (send all visible chunks)
**Success Criteria**:
- [ ] Client connects and receives initial 64 chunks from server
- [ ] Terrain renders identically to client-only mode
- [ ] Moving player triggers server to send new chunks
- [ ] Client correctly unloads chunks when server sends CHUNK_UNLOAD
- [ ] Multiple clients in same room see identical terrain
- [ ] Chunk data arrives before player can walk into unloaded area
- [ ] Network bandwidth reasonable (monitor in debug panel)
- [ ] Client handles chunk messages during gameplay without stuttering
---

## Future Work (Separate Projects)

- **Terrain Editing**: Client sends build commands, server validates and broadcasts
- **Procedural Generation**: Seed-based terrain using room ID
- **LOD System**: Lower detail meshes for distant chunks
- **Texture Materials**: Replace vertex colors with texture atlas
- **Chunk Persistence**: Save/load modified chunks to database
- **Occlusion Culling**: Don't render chunks hidden by terrain

---

## Dependencies

**NPM Packages to evaluate**:
- `fast-bvh` or `three-mesh-bvh` for collision
- Consider `pako` or `lz4js` for chunk compression

---

## Testing Checkpoints

| Stage | Checkpoint |
|-------|------------|
| 1 | Voxel pack/unpack unit tests pass |
| 2 | Can create chunk, set/get voxels |
| 3 | SurfaceNet generates geometry for test data |
| 4 | Can see rendered chunk mesh in scene |
| 5 | 64 chunks render, stream as player moves |
| 6 | Debug wireframes toggle on/off, show chunk bounds |
| 7 | Player walks on terrain, doesn't fall through |
| 8 | Old build system removed, game runs on voxels |
| 9 | Server generates identical chunks to client |
| 10 | Chunk data serializes/deserializes correctly |
| 11 | Client receives terrain from server on join |

---

## Estimated Timeline

| Stage | Effort |
|-------|--------|
| 1 - Constants & Utils | 0.5 day |
| 2 - Chunk Data | 0.5 day |
| 3 - SurfaceNet | 1-2 days |
| 4 - Mesh Rendering | 0.5 day |
| 5 - World Manager | 1 day |
| 6 - Debug Rendering | 0.5 day |
| 7 - Collision | 1-2 days |
| 8 - Integration | 0.5 day |
| 9 - Server Chunks | 0.5 day |
| 10 - Network Protocol | 1 day |
| 11 - Client-Server Sync | 1 day |

**Total**: ~8-11 days

---

## Notes

- All chunk coordinates use integers (can be negative)
- Chunk key format: `"${cx},${cy},${cz}"`
- Player spawns at Y=10 + small offset (above terrain surface)
- Consider Web Workers for meshing if performance is an issue
