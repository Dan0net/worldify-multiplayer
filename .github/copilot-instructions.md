# Worldify Multiplayer - AI Coding Instructions

> **Principles**: Follow KISS, DRY, SOLID.

## Architecture Overview

**Monorepo with 3 packages** linked via npm workspaces:
- `shared/` → Types, constants, binary protocol, voxel utilities (used by both)
- `client/` → React UI + Three.js game engine (Vite)  
- `server/` → Node.js WebSocket server with room management

**Data flow**: React UI ↔ Zustand store ↔ GameCore ↔ WebSocket ↔ Server rooms

## Critical Patterns

### Binary Protocol (Performance-Critical)
All network messages use binary encoding. Follow the pattern in `shared/src/protocol/`:
```typescript
// Message IDs: Client→Server 0x01-0x7F, Server→Client 0x80-0xFF
// See shared/src/protocol/msgIds.ts for constants
// Encode/decode with ByteWriter/ByteReader from shared/src/util/bytes.ts
```

### Shared Package is Sacred
**Never duplicate** types between client/server. If it's used by both:
- Types/interfaces → `shared/src/protocol/`
- Constants → `shared/src/protocol/constants.ts`
- Voxel logic → `shared/src/voxel/`
- Utilities → `shared/src/util/`

### React + Three.js Separation
- **React** (`client/src/ui/`) → Only UI components, reads from Zustand
- **GameCore** (`client/src/game/`) → Owns all Three.js/game state, imperatively updated
- **Bridge** (`client/src/state/bridge.ts`) → ALL non-React store access goes through here

### Zustand Store Access Pattern
```typescript
// ✅ React components: use the hook for reactive updates
const isSpectating = useGameStore((s) => s.isSpectating);

// ✅ Game code (non-React): use storeBridge for ALL reads and writes
import { storeBridge } from '../state/bridge';
const isSpectating = storeBridge.isSpectating;      // read
storeBridge.updateIsSpectating(false);               // write

// ❌ NEVER do this in game code:
useGameStore.getState().isSpectating;  // bypasses bridge
```

### Server Room Model
- Rooms are independent game instances (`server/src/rooms/room.ts`)
- `RoomManager` handles lobby/room creation
- Server-authoritative physics with client prediction

### Voxel Terrain System
Smooth voxel terrain using surface nets (not blocky Minecraft-style).

**Data layout** (16-bit packed voxel):
```
WWWW MMMMMMM LLLLL  →  Weight(4) | Material(7) | Light(5)
```
- Weight: -0.5 to +0.5 (surface at 0, negative = inside solid)
- Use `packVoxel()`/`unpackVoxel()` from `shared/src/voxel/voxelData.ts`

**Chunk structure**:
- 32³ voxels per chunk, 0.25m per voxel → 8m chunks
- All constants in `shared/src/voxel/constants.ts`

**Client components** (`client/src/game/voxel/`):
| File | Responsibility |
|------|----------------|
| `VoxelWorld.ts` | Chunk loading/unloading, coordinate systems |
| `Chunk.ts` | Single chunk data container |
| `ChunkMesh.ts` | Three.js mesh from chunk data |
| `SurfaceNet.ts` | Isosurface extraction algorithm |
| `VoxelCollision.ts` | Player collision with terrain |
| `VoxelIntegration.ts` | Connects world to GameCore |

**Coordinate helpers**: `worldToChunk()`, `chunkToWorld()`, `worldToVoxel()` in shared/

## Commands
```bash
npm run dev          # Start both client (5173) and server (8080)
npm run dev:kill     # Kill stuck dev processes
npm run build        # Build all packages (shared first)
```

## Key Files to Reference
| When working on... | Reference these files |
|--------------------|-----------------------|
| Network messages | `shared/src/protocol/msgIds.ts`, `snapshot.ts`, `movement.ts` |
| Voxel terrain | `shared/src/voxel/`, `client/src/game/voxel/` |
| Player physics | `client/src/game/player/playerLocal.ts`, `server/src/rooms/room.ts` |
| State management | `client/src/state/store.ts`, `bridge.ts` |
| Scene setup | `client/src/game/scene/` (lighting, camera) |

## Anti-Patterns
- ❌ Magic numbers → Use `shared/src/protocol/constants.ts`
- ❌ String-based protocols → Binary only via ByteWriter/ByteReader
- ❌ Game state in React → Keep in GameCore, expose summaries via Zustand
- ❌ Direct DOM in game code → Use React for UI, Three.js for 3D

## When Porting from worldify-app
Check `worldify-app/` for existing implementations before writing new code. Reusable patterns exist for:
- Material/texture handling
- Chunk mesh generation  
- Worker thread patterns
