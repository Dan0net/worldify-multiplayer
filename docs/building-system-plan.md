# Building System Implementation Plan for worldify-multiplayer

## Overview

Based on analysis of worldify-app's building system, here's how it works:

**worldify-app Building Flow:**
1. **Builder.ts** handles input/UI, raycasting, and coordinates the build operation
2. **BuildPresets.ts** defines shape types (cube, sphere, cylinder, prism) and modes (add, subtract, paint, fill)
3. **ChunkCoordinator.drawToChunks()** finds affected chunks and calls `chunk.draw()` on each
4. **Chunk.draw()** iterates over voxels in bounding box, applies SDF shape functions, and modifies the temp mesh (preview) or real mesh (placing)
5. **ChunkMesh** has `drawGridAdd/Subtract/Paint/Fill` functions that modify the packed grid data
6. When `isPlacing=true`, collision meshes are updated and chunk is saved

**Key patterns:**
- **Temp mesh preview**: Shows changes in real-time without modifying actual data
- **SDF (Signed Distance Functions)**: Used to calculate which voxels are inside/outside shapes
- **Inverse rotation**: Shapes can be rotated; voxel positions are inverse-rotated to check against axis-aligned SDFs

---

## Implementation Plan

### Phase 1: Shared Drawing Functions (`shared/src/voxel/`)

#### 1.1 Create `shared/src/voxel/shapes.ts` - Pure SDF shape functions
```typescript
// SDF functions for sphere, cube, cylinder, prism
// Input: local position (relative to shape center, inverse-rotated)
// Output: signed distance (negative = inside, positive = outside)
```

#### 1.2 Create `shared/src/voxel/buildTypes.ts` - Build configuration types
```typescript
export enum BuildMode { ADD, SUBTRACT, PAINT, FILL }
export enum BuildShape { CUBE, SPHERE, CYLINDER, PRISM }

export interface BuildConfig {
  shape: BuildShape;
  mode: BuildMode;
  size: { x: number; y: number; z: number };
  material: number;
  thickness?: number;  // For hollow shapes
  closed?: boolean;    // Open top/bottom for hollow
  arcSweep?: number;   // Partial arc in radians
}
```

#### 1.3 Create `shared/src/voxel/drawing.ts` - Core drawing logic
```typescript
// drawToChunk(chunk, center, rotation, bbox, config): boolean
// - Iterates over bounding box voxels
// - Applies SDF + mode to modify chunk.data
// - Returns true if any voxels changed

// applyAdd/applySubtract/applyPaint/applyFill functions
// (equivalent to ChunkMesh.drawGridAdd/Subtract/Paint/Fill)
```

#### 1.4 Update `shared/src/voxel/Chunk.ts`
- Add `draw()` method that uses the drawing functions
- Add `copyToTemp()`/`copyFromTemp()` for preview support
- Add `tempData: Uint16Array | null` for preview buffer

---

### Phase 2: Network Protocol (`shared/src/protocol/`)

#### 2.1 Message IDs (in `buildMessages.ts`)
```typescript
// Client → Server
export const MSG_VOXEL_BUILD_INTENT = 0x06;   // Player clicks to build
export const MSG_VOXEL_CHUNK_REQUEST = 0x07;  // Request full chunk data

// Server → Client
export const MSG_VOXEL_BUILD_COMMIT = 0x87;   // Echoes intent to all clients
export const MSG_VOXEL_CHUNK_DATA = 0x88;     // Full chunk for streaming/resync
```

#### 2.2 VOXEL_BUILD_INTENT (Client → Server)
Sent when player clicks to commit a build. Contains:
- Center position (Vec3)
- Rotation (Quaternion)
- BuildConfig (shape, mode, size, material, optional thickness/arcSweep)

#### 2.3 VOXEL_BUILD_COMMIT (Server → Client)
Server validates the build, applies it, then echoes the intent to ALL clients:
- Build sequence number (for ordering)
- Player ID
- Result code (success, too_far, no_permission, collision, invalid_config, rate_limited)
- Original intent data (if success)

Clients apply the build locally using shared drawing functions. This ensures determinism.

#### 2.4 VOXEL_CHUNK_DATA (Server → Client)
Full chunk voxel data. Used for:
- New players joining (chunks they can see)
- Existing players streaming new chunks into view
- Resync if client gets out of order

Contains:
- Chunk coordinates
- Last build sequence applied to this chunk
- Raw voxel data (32×32×32×2 = 65536 bytes)

#### 2.5 VOXEL_CHUNK_REQUEST (Client → Server)
Client requests full chunk data for a specific chunk coordinate.

---

### Phase 3: Client Build System (`client/src/game/build/`)

#### 3.1 Create `BuildPreview.ts` - Real-time preview as player moves
- Uses temp chunk data (doesn't modify real chunks)
- Updates on every frame when building mode is active
- Raycasts to find build position
- Calls `drawToChunk()` with `isPreview=true`

#### 3.2 Create `Builder.ts` - Main build controller
```typescript
class Builder {
  private config: BuildConfig;
  private previewChunks: Set<string>;  // Chunks showing preview
  
  update(playerPos, cameraDir): void  // Update preview
  place(): void                        // Send BUILD_INTENT to server
  cancel(): void                       // Clear preview
  setShape/setMode/setMaterial/etc.
}
```

#### 3.3 Modify `VoxelWorld.ts`
- Add `applyBuild(intent: VoxelBuildIntent)` - applies build using shared drawing functions
- Add `showPreview(center, rotation, config)` using temp buffers
- Add `clearPreview()` to restore from temp buffers
- Handle `VOXEL_BUILD_COMMIT`: apply the echoed intent locally
- Handle `VOXEL_CHUNK_DATA`: replace/create chunk with server data

#### 3.4 Create `BuildMarker.ts` - Visual indicator for build target
- Wireframe representation of current shape
- Snapping indicators (grid, surface normal)

---

### Phase 4: Server Build Handling (`server/src/rooms/`)

#### 4.1 Create `BuildHandler.ts`
```typescript
class BuildHandler {
  handleBuildIntent(player, intent): void {
    // 1. Validate player can build (distance, permissions, rate limit)
    // 2. Apply build to server chunk data using shared drawing functions
    // 3. Track which chunks were modified (for streaming)
    // 4. Broadcast VOXEL_BUILD_COMMIT with the original intent to all players
    // 5. Update server-side collision for physics validation
  }
}
```

#### 4.2 Modify Room to maintain voxel state
- Store modified chunks with `lastBuildSeq` per chunk
- Handle `VOXEL_BUILD_INTENT` messages
- Handle `VOXEL_CHUNK_REQUEST` - send full chunk data to requesting client
- Serialize/deserialize for persistence

---

### Phase 5: Collision Updates

#### 5.1 Client collision (`client/src/game/voxel/VoxelCollision.ts`)
- Already exists for terrain
- Add `rebuildCollision(chunkKey)` after confirmed builds

#### 5.2 Server collision (new `server/src/voxel/`)
- Port VoxelCollision for server-side physics validation
- Prevent building inside solid terrain / other players

---

## File Structure Summary

```
shared/src/voxel/
├── buildTypes.ts      # BuildMode, BuildShape, BuildConfig
├── shapes.ts          # SDF functions (sphere, cube, cylinder, prism)
├── drawing.ts         # drawToChunk, apply functions
├── Chunk.ts           # Add draw(), tempData support
└── index.ts           # Export all

shared/src/protocol/
├── buildMessages.ts   # Binary encode/decode for build messages
└── msgIds.ts          # Already has build message IDs

client/src/game/build/
├── Builder.ts         # Main controller
├── BuildPreview.ts    # Real-time preview
├── BuildMarker.ts     # Visual wireframe indicator
└── index.ts

server/src/rooms/
├── BuildHandler.ts    # Validate and apply builds
└── room.ts            # Wire up build handling
```

---

## Implementation Order

1. **Phase 1** (shared drawing) - Foundation, needed by both client and server
2. **Phase 3.1-3.2** (client preview/builder) - Test drawing locally without network
3. **Phase 2** (network protocol) - Define messages
4. **Phase 4** (server handling) - Server-authoritative builds
5. **Phase 3.3-3.4** (client integration) - Connect to VoxelWorld
6. **Phase 5** (collision) - Physics updates after builds

---

## Key Design Decisions

1. **Drawing functions in shared** - Same code on server and all clients ensures determinism
2. **Temp buffer for preview** - Non-destructive preview that can be instantly reverted
3. **Server-authoritative** - Client sends intent, server validates and broadcasts result
4. **Echo intent, not patches** - Server broadcasts the original intent; clients apply it locally using shared drawing code. This is simpler and ensures all clients produce identical results.
5. **Full chunk sync for streaming** - When clients need chunk data (new player, streaming into view, resync), send full chunk with `lastBuildSeq`. No need for complex delta tracking.
6. **Sequence numbers** - `buildSeq` ensures ordering; clients can detect if they missed a build and request chunk resync
7. **Error codes** - Server returns specific rejection reasons (too_far, no_permission, collision, rate_limited)

---

## Reference: worldify-app Key Files

| Component | File | Key Functions |
|-----------|------|---------------|
| Builder controller | `src/builder/Builder.ts` | `draw()`, `place()`, `raycast()`, `project()` |
| Build presets | `src/builder/BuildPresets.ts` | `BuildPreset`, `BuildPresetMode`, `BuildPresetShape` |
| Chunk coordinator | `src/3d/ChunkCoordinator.ts` | `drawToChunks()`, `clearDrawToChunks()` |
| Chunk drawing | `src/3d/Chunk.ts` | `draw()`, `drawSphere/Cube/Cylinder/Prism()` |
| Grid modification | `src/3d/ChunkMesh.ts` | `drawGridAdd/Subtract/Paint/Fill()` |
| Utility functions | `src/utils/functions.ts` | `packGridValue()`, `unpackGridValue()`, `clamp()` |
