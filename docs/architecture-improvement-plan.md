# Architecture Improvement Plan: KISS, DRY, SOLID Analysis

> Analysis Date: January 2026  
> Scope: worldify-multiplayer codebase

## Executive Summary

The codebase has a **solid foundation** with good separation between packages (shared, client, server) and a well-designed binary protocol. However, several areas need improvement to ensure future development is built on maintainable, extensible patterns.

---

## Current State Assessment

### ✅ What's Working Well

1. **Package Structure** - Clean monorepo with shared types between client/server
2. **Binary Protocol** - Well-documented message formats with encode/decode in shared
3. **Voxel Constants** - Centralized in `shared/src/voxel/constants.ts`
4. **Store Bridge Pattern** - Clean separation between React and game code
5. **Chunk Coordinate Helpers** - Single source of truth in `voxelData.ts`
6. **TerrainGenerator** - Good configuration-based approach with noise layers

### ⚠️ Areas Needing Improvement

---

## DRY Violations

### 1. **Physics Constants Duplicated** (High Priority)
**Problem:** Movement and physics constants are defined in multiple places with inconsistent values.

| Constant | Client (playerLocal.ts) | Server (roomTick.ts) | Should Be |
|----------|-------------------------|----------------------|-----------|
| `MOVE_SPEED` | 6.0 | 5.0 | Shared constant |
| `SPRINT_MULTIPLIER` | 1.6 | 1.6 | ✓ Same (but duplicated) |
| `GRAVITY` | -40.0 | N/A (client-side) | Shared constant |
| `PLAYER_HEIGHT` | 1.6 | 1.6 (via PLAYER_EYE_HEIGHT) | Shared constant |
| `JUMP_VELOCITY` | 15.0 | N/A | Shared constant |

**Fix:**
```typescript
// shared/src/protocol/physics.ts
export const MOVE_SPEED = 6.0;
export const SPRINT_MULTIPLIER = 1.6;
export const GRAVITY = -40.0;
export const PLAYER_HEIGHT = 1.6;
export const PLAYER_RADIUS = 0.25;
export const JUMP_VELOCITY = 15.0;
export const PHYSICS_STEPS = 5;
```

### 2. **Encode/Decode Wrapper Pattern** (Medium Priority)
**Problem:** Client and server have `net/encode.ts` and `net/decode.ts` that mostly just re-export shared functions with identical signatures.

Client's encode.ts:
```typescript
export function encodeInput(input: MovementInput): Uint8Array {
  return sharedEncodeInput(input);  // Just a passthrough!
}
```

**Fix:** Import directly from shared instead of creating wrapper modules. Only keep wrappers for functions that actually add platform-specific logic (like `encodeJoin` which is client-specific).

### 3. **Movement Logic Duplication** (High Priority)
**Problem:** The same movement vector calculation appears in both client and server:

```typescript
// In playerLocal.ts AND roomTick.ts:
const cos = Math.cos(this.yaw);
const sin = Math.sin(this.yaw);
const worldX = moveX * cos + moveZ * sin;
const worldZ = -moveX * sin + moveZ * cos;
```

**Fix:**
```typescript
// shared/src/util/movement.ts
export function rotateInputToWorld(
  inputX: number, inputZ: number, yaw: number
): { worldX: number; worldZ: number } {
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);
  return {
    worldX: inputX * cos + inputZ * sin,
    worldZ: -inputX * sin + inputZ * cos,
  };
}

export function normalizeInput(
  forward: boolean, backward: boolean, left: boolean, right: boolean
): { moveX: number; moveZ: number } {
  let moveX = 0, moveZ = 0;
  if (forward) moveZ -= 1;
  if (backward) moveZ += 1;
  if (left) moveX -= 1;
  if (right) moveX += 1;
  const length = Math.sqrt(moveX * moveX + moveZ * moveZ);
  if (length > 0) {
    moveX /= length;
    moveZ /= length;
  }
  return { moveX, moveZ };
}
```

---

## SOLID Violations

### 1. **Single Responsibility Principle (SRP)**

#### GameCore.ts (Violation)
**Problem:** `GameCore` handles too many responsibilities:
- Renderer management
- Player management (local + remote)
- Input loop
- Voxel terrain integration
- Network message handling
- FPS calculation
- Spectator mode logic

**Fix:** Extract into focused modules:
```
game/
  GameCore.ts          → Orchestration only
  render/
    Renderer.ts        → WebGLRenderer management, resize
  PlayerManager.ts     → Local + remote player lifecycle
  InputLoop.ts         → Input polling and sending
  GameLoop.ts          → RAF loop, deltaTime, FPS
  NetworkHandler.ts    → Snapshot/build callbacks
```

#### VoxelWorld.ts (Borderline)
Currently handles: chunk loading, unloading, generation, meshing, stats.
**Recommendation:** Keep as-is for now, but extract `ChunkStreamer` if it grows.

### 2. **Open/Closed Principle (OCP)**

#### Message Handler Switch Statement
**Problem:** `decodeMessage` uses a large switch statement. Adding new messages requires modifying this function.

```typescript
switch (msgId) {
  case MSG_WELCOME: handleWelcome(reader); break;
  case MSG_ROOM_INFO: handleRoomInfo(reader); break;
  // Adding new message = modifying this file
}
```

**Fix:** Use a handler registry pattern:
```typescript
// MessageRegistry.ts
type MessageHandler = (reader: ByteReader) => void;
const handlers = new Map<number, MessageHandler>();

export function registerHandler(msgId: number, handler: MessageHandler) {
  handlers.set(msgId, handler);
}

export function dispatch(data: Uint8Array) {
  const reader = new ByteReader(data);
  const msgId = reader.readUint8();
  const handler = handlers.get(msgId);
  if (handler) handler(reader);
  else console.warn('Unknown message:', msgId);
}

// In init:
registerHandler(MSG_WELCOME, handleWelcome);
registerHandler(MSG_SNAPSHOT, handleSnapshot);
```

### 3. **Dependency Inversion Principle (DIP)**

#### VoxelIntegration Direct Dependencies
**Problem:** `VoxelIntegration` directly instantiates `VoxelWorld`, `VoxelCollision`, `VoxelDebugManager`.

**Fix:** Accept these as constructor parameters or use factory functions:
```typescript
interface VoxelDependencies {
  world: VoxelWorld;
  collision: VoxelCollision;
  debug: VoxelDebugManager;
}

// Allows testing with mocks
```

#### StoreBridge Singleton
**Problem:** `storeBridge` is a singleton import, making testing difficult.

**Fix (Future):** Consider injecting the bridge or using a factory for testability.

### 4. **Interface Segregation Principle (ISP)**

#### VoxelDebugToggles Interface
**Status:** ✅ Already well-designed - separate toggles for each feature.

#### PlayerState Interface
**Status:** ✅ Clean, focused interface.

---

## KISS Violations

### 1. **Over-Complex Capsule Collision Result Calculation**
**Problem:** In `VoxelCollision.ts`, the collision resolution has complex vector operations that could be simplified.

```typescript
// Current: confusing subtraction then re-addition
deltaVector.sub(capsuleInfo.segment.start);
const offset = Math.max(0.0, deltaVector.length() - 1e-5);
deltaVector.normalize().multiplyScalar(offset);
```

**Fix:** Add clear comments and consider extracting to a named function:
```typescript
function calculatePushOutVector(
  originalPos: Vector3,
  newSegmentStart: Vector3,
  capsuleInfo: CapsuleInfo
): Vector3 {
  // ... with clear comments explaining the math
}
```

### 2. **Room Interface Uses `buildLog: Array<unknown>`**
**Problem:** Weakly typed - should be `BuildCommit[]`.

### 3. **Chunk Key Functions**
**Status:** ✅ Already simplified - `chunkKey(cx, cy, cz)` returns `"x,y,z"` string.

---

## Missing Abstractions

### 1. **No Physics Simulation Interface**
Client and server both do physics but have no shared abstraction.

**Recommendation:**
```typescript
// shared/src/physics/PhysicsSimulation.ts
export interface PhysicsInput {
  buttons: number;
  yaw: number;
  pitch: number;
}

export interface PhysicsState {
  x: number;
  y: number;
  z: number;
  velocityY: number;
  isGrounded: boolean;
}

export function simulateMovement(
  state: PhysicsState,
  input: PhysicsInput,
  dt: number,
  config: PhysicsConfig
): PhysicsState;
```

### 2. **No Chunk Generation Strategy Pattern**
Currently `TerrainGenerator` is the only option.

**Recommendation (Future):** If multiple generation types needed:
```typescript
interface ChunkGenerator {
  generateChunk(cx: number, cy: number, cz: number): Uint16Array;
  isChunkEmpty(cx: number, cy: number, cz: number): boolean;
}
```

---

## Priority Action Items

### Immediate (Before Next Feature)

1. **Extract Physics Constants** → `shared/src/protocol/physics.ts`
   - Unify MOVE_SPEED between client/server
   - Export all physics constants from shared
   - Update imports in playerLocal.ts, roomTick.ts, room.ts

2. **Extract Movement Utilities** → `shared/src/util/movement.ts`
   - `rotateInputToWorld()` 
   - `normalizeInput()`
   - `applyMovement()`

3. **Fix Type Safety**
   - `Room.buildLog: BuildCommit[]` instead of `unknown[]`
   - Add return types to all exported functions

### Short-Term (Next Sprint)

4. **Simplify encode/decode modules**
   - Client: Remove wrapper functions that just passthrough
   - Import directly from shared where no modification needed

5. **Extract GameCore Responsibilities**
   - Create `PlayerManager` for player lifecycle
   - Create `GameLoop` for RAF/timing concerns

6. **Add Message Registry Pattern**
   - Replace switch statement with handler map
   - Makes adding new messages safer

### Medium-Term (Technical Debt Backlog)

7. **Add Integration Tests**
   - Test shared physics simulation
   - Test encode/decode round-trips

8. **Consider Dependency Injection**
   - VoxelIntegration accepting dependencies
   - StoreBridge as injectable service

---

## Updated Instructions Recommendations

Add to `copilot-instructions.md`:

```markdown
## Physics Constants (NEW)
All physics-related constants must go in `shared/src/protocol/physics.ts`:
- Player movement (MOVE_SPEED, SPRINT_MULTIPLIER, JUMP_VELOCITY)
- Physics (GRAVITY, PHYSICS_STEPS)
- Player dimensions (PLAYER_HEIGHT, PLAYER_RADIUS)

## Movement Utilities (NEW)
Use shared movement functions instead of duplicating:
- `rotateInputToWorld()` - Convert input to world direction
- `normalizeInput()` - Normalize diagonal movement

## Message Handling (UPDATED)
When adding new network messages:
1. Add message ID to `shared/src/protocol/msgIds.ts`
2. Add encode/decode to `shared/src/protocol/<feature>.ts`
3. Register handler in client/server message registry
```

---

## Architecture Diagram (Target State)

```
shared/
├── protocol/
│   ├── msgIds.ts         # All message IDs
│   ├── constants.ts      # Game constants (room limits, tick rates)
│   ├── physics.ts        # ← NEW: Physics constants
│   ├── movement.ts       # Movement encode/decode
│   ├── snapshot.ts       # Snapshot encode/decode
│   └── build.ts          # Build system encode/decode
├── util/
│   ├── bytes.ts          # ByteWriter/ByteReader
│   ├── quantize.ts       # Position/angle quantization
│   └── movement.ts       # ← NEW: Movement calculation utils
└── voxel/                # Unchanged

client/
├── game/
│   ├── GameCore.ts       # Orchestration only
│   ├── GameLoop.ts       # ← NEW: RAF, deltaTime
│   ├── PlayerManager.ts  # ← NEW: Player lifecycle
│   └── player/           # Imports from shared/protocol/physics.ts
└── net/
    ├── MessageRegistry.ts # ← NEW: Handler registration
    └── netClient.ts       # WebSocket management only

server/
├── rooms/
│   └── roomTick.ts       # Imports from shared/protocol/physics.ts
└── net/
    ├── MessageRegistry.ts # ← NEW: Handler registration
    └── wsServer.ts        # WebSocket management only
```

---

## Conclusion

The codebase is well-structured but has accumulated some technical debt through feature development. The highest-impact improvements are:

1. **Unifying physics constants** (prevents client/server desync bugs)
2. **Extracting shared movement utilities** (reduces duplication)
3. **Breaking down GameCore** (improves maintainability)

These changes will provide a solid foundation for future features like prediction/reconciliation, multiple room types, and player abilities.
