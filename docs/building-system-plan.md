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

**Priority:** Visual feedback first (marker + UI), then voxel modification.

---

#### Stage 3.1: Build Presets (`shared/src/voxel/buildPresets.ts`)

Define `BuildPreset` interface and `DEFAULT_BUILD_PRESETS` array.

- `id` (0-9), `name`, `config` (BuildConfig), `align` (CENTER | BASE | SURFACE)
- Preset 0 = "None" (disabled)
- Export from shared so server can validate

---

#### Stage 3.2: Store & Bridge Updates

**Extend existing `store.ts`** - add build state:
- `buildPresetId: number`, `buildRotation: number` (0-7 = 0°-315°)

**Extend existing `bridge.ts`** - add build accessors:
- `get/set buildPresetId`, `get/set buildRotation`

No new files - extend what exists.

---

#### Stage 3.3: Input Handling (Extend `Controls`)

**Extend existing `client/src/game/player/controls.ts`** - don't create new file.

Add to existing `onKeyDown`:
- `Digit1`-`Digit9` → select preset 1-9
- `Digit0` → select preset 0 (disable)
- `KeyQ` → rotate -1
- `KeyE` → rotate +1

Add `onWheel` handler → rotate ±1

Add `onClick` handler → call `Builder.place()` if preset active

Expose via bridge, not direct coupling.

---

#### Stage 3.4: Build Marker (`client/src/game/build/BuildMarker.ts`)

Single class for wireframe indicator.

- Creates Box/Sphere/Cylinder wireframes (Three.js)
- `update(camera, collisionMeshes)` - raycast and position
- `setPreset(preset)` - switch wireframe shape/size
- `setRotation(steps)` - apply Y rotation
- Color: green = valid, red = too far

No state management - pure rendering. Gets data from Builder.

---

#### Stage 3.5: Builder (`client/src/game/build/Builder.ts`)

Single coordinator class. Minimal responsibilities:

- Owns BuildMarker instance
- `update(camera, collisionMeshes)` - called from GameCore loop
- `selectPreset(id)` - updates store via bridge
- `rotate(direction)` - updates store via bridge  
- `place()` - sends network message (later: optimistic apply)
- Reads state from bridge, doesn't duplicate it

---

#### Stage 3.6: Build UI (`client/src/ui/BuildToolbar.tsx`)

React component reads from store (not bridge).

- Shows preset name, mode icon, rotation
- Hides when preset 0
- Hotkey hints

---

#### Stage 3.7: Voxel Preview (LATER)

Only after marker works. Extends ChunkMesh:

- `tempData` buffer for non-destructive preview
- Visual mesh from tempData, collision mesh unchanged
- BuildPreview class coordinates preview rendering

---

#### Stage 3.8: Optimistic Apply (LATER)

On place, apply to real data before server confirms.

- Track pending builds for rollback
- Request resync on rejection

---

### Phase 4: Server Build Handling (`server/src/rooms/`)

#### 4.1 Create `BuildHandler.ts`

Responsibilities:
- Validate player can build (distance, permissions, rate limit)
- Apply build to server chunk data using shared drawing functions
- Track modified chunks for streaming
- Broadcast VOXEL_BUILD_COMMIT to all players
- Update server-side collision
```

#### 4.2 Modify Room to maintain voxel state
- Store modified chunks with `lastBuildSeq` per chunk
- Handle `VOXEL_BUILD_INTENT` messages
- Handle `VOXEL_CHUNK_REQUEST` - send full chunk data to requesting client
- Serialize/deserialize for persistence

---

### Phase 5: Collision Updates

#### 5.1 Client collision (`client/src/game/voxel/VoxelCollision.ts`)
- Already exists - add `rebuildCollision(chunkKey)` after confirmed builds

#### 5.2 Server collision
- Port VoxelCollision for server-side physics validation
- Prevent building inside solid terrain / other players

---

## File Structure Summary

```
shared/src/voxel/
├── buildTypes.ts      # BuildMode, BuildShape, BuildConfig (exists)
├── buildPresets.ts    # BuildPreset, DEFAULT_BUILD_PRESETS (new)
├── shapes.ts          # SDF functions (exists)
├── drawing.ts         # drawToChunk (exists)
└── Chunk.ts           # tempData support (extend)

client/src/game/player/
└── controls.ts        # Extend with build keys (exists)

client/src/game/build/
├── Builder.ts         # Coordinator (new)
└── BuildMarker.ts     # Wireframe indicator (new)

client/src/state/
├── store.ts           # Add buildPresetId, buildRotation (extend)
└── bridge.ts          # Add build accessors (extend)

client/src/ui/
└── BuildToolbar.tsx   # Build UI (new)

server/src/rooms/
└── BuildHandler.ts    # Validate and apply (new)
```

---

## Implementation Order

### Phase 1: Shared Foundation (Done)
1. ✓ `buildTypes.ts`, `shapes.ts`, `drawing.ts`

### Phase 3: Client Build System

**Visual feedback first:**
1. `buildPresets.ts` - Define presets in shared
2. Extend `store.ts` + `bridge.ts` - Build state
3. Extend `controls.ts` - Build input handling
4. `BuildMarker.ts` - Wireframe at raycast hit
5. `Builder.ts` - Coordinator
6. `BuildToolbar.tsx` - UI

**Voxel modification (later):**
7. Extend `ChunkMesh.ts` - Visual/collision mesh separation
8. Extend `Chunk.ts` - tempData buffer
9. Optimistic apply in VoxelWorld

### Phase 2 & 4: Network + Server (After client works locally)

---

## Key Design Decisions

1. **Extend existing files** - Don't create new files when extending works (DRY)
2. **Single responsibility** - Controls handles input, Builder coordinates, Marker renders
3. **State via bridge** - Game code reads/writes store through bridge only
4. **Shared presets** - Both client and server reference same preset definitions
5. **Visual first** - Wireframe marker works before voxel modification
6. **Temp buffer isolation** - Preview never affects collision raycast

---

## Reference: worldify-app Key Files

| Component | File |
|-----------|------|
| Builder controller | `src/builder/Builder.ts` |
| Build presets | `src/builder/BuildPresets.ts` |
| Chunk drawing | `src/3d/Chunk.ts` |
| Grid modification | `src/3d/ChunkMesh.ts` |
