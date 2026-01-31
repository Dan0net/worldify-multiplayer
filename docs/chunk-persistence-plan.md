# Chunk Persistence Plan

## Overview

Implement persistent chunk storage so player builds survive server restarts. Uses a single shared world where room names represent spawn regions spread across an infinite terrain.

---

## Architecture

### Single Infinite World

All rooms exist in **one shared world**. Each room name hashes to a unique (X, Z) spawn location, spaced ~80km apart so players in different rooms never encounter each other.

```
                        Z
                        ↑
        "coral-cove"    │    "pixel-peak"
        (-80km, +80km)  │    (+80km, +80km)
                        │
        ────────────────┼────────────────→ X
                        │
        "fuzzy-falls"   │    "breezy-bay"  
        (-80km, -80km)  │    (+80km, -80km)
```

### Storage

- **Single LevelDB** database at `data/world.db`
- Keys are global chunk coordinates: `chunk:0,0,0`, `chunk:10000,0,5`
- Only **modified chunks** are saved (delta-only) — unmodified terrain regenerates from seed
- Snappy compression enabled (~30-50% space savings)

### Room Model

- **Fixed pool of ~20 fun room names** (see below)
- Room name → deterministic spawn offset via hash
- Rooms are **views into the shared world**, not isolated instances
- Room assignment: **fill busiest room first**, then next busiest, create new if all full

---

## Decisions

| Decision | Value |
|----------|-------|
| Database | Single LevelDB (`data/world.db`) |
| Room model | Spawn regions — room name → (X, Z) offset |
| Room names | Fixed pool of ~20 fun names |
| Room spacing | ~80km apart (10,000 chunks × 8m) |
| Assignment | **Most busy first**, then overflow, then create new |
| Persistence | Delta-only — save modified chunks |
| Compression | Yes (Snappy) |
| I/O mode | Sync (simple, fast enough) |
| Backup | None (manual filesystem backup if needed) |

---

## Room Names

Fun, light-hearted names for the room pool:

```typescript
export const ROOM_NAMES = [
  'cozy-crater',
  'sunny-summit', 
  'breezy-bay',
  'pixel-peak',
  'fuzzy-falls',
  'coral-cove',
  'mellow-meadow',
  'dapper-dunes',
  'wiggly-woods',
  'snoozy-slopes',
  'bouncy-basin',
  'glimmer-gulch',
  'tipsy-terrace',
  'wobble-woods',
  'zippy-zenith',
  'noodle-nook',
  'sparkle-springs',
  'doodle-dale',
  'giggle-grove',
  'bumble-bluff',
] as const;
```

---

## Room Assignment Logic

```
Player connects:
1. Get all active rooms, sorted by player count (descending)
2. Find first room that isn't full (< MAX_PLAYERS_PER_ROOM)
3. If found → assign player to that room
4. If all full → pick random unused name from pool, create new room
5. If all names in use and full → reject connection (server at capacity)
```

This ensures:
- Players cluster together for social gameplay
- Rooms fill up before new ones are created
- Maximum utilization of each spawn region

---

## DB Key Structure

```
Key                          Value
───────────────────────────────────────────────
meta:seed                    12345 (world seed)
meta:created                 1706659200000 (timestamp)
chunk:0,0,0                  <binary 64KB>
chunk:10000,0,0              <binary 64KB>
chunk:-10000,0,5000          <binary 64KB>
```

No room prefix needed — chunks are just global coordinates.

---

## Implementation Phases

### Phase 1: Storage Layer

**Files:**
- `server/src/storage/WorldStorage.ts` — LevelDB singleton
- `server/src/storage/PersistentChunkStore.ts` — `ChunkStore` implementation

**Tasks:**
1. Add `level` npm package to server
2. Create `WorldStorage` class:
   - Opens LevelDB at `data/world.db`
   - Provides `get(key)`, `put(key, value)`, `close()` methods
   - Stores world seed in `meta:seed`
3. Create `PersistentChunkStore` implementing existing `ChunkStore` interface:
   - `get(key)` → read from LevelDB
   - `set(key, chunk)` → write to LevelDB
4. Wire into `ChunkProvider` as backing store
5. Handle graceful shutdown on SIGTERM → flush + close DB

### Phase 2: Room Names & Offsets

**Files:**
- `shared/src/protocol/constants.ts` — add `ROOM_NAMES`, `ROOM_SPACING`
- `shared/src/util/roomOffset.ts` — `roomToOffset()` function

**Tasks:**
1. Define `ROOM_NAMES` constant array
2. Define `ROOM_SPACING = 10000` (chunks between rooms)
3. Implement `roomToOffset(roomName: string): { x: number; z: number }`:
   - Hash room name to deterministic grid position
   - Return world coordinates (meters)
4. Update `createPlayerState()` to use room offset for spawn position

### Phase 3: Room Assignment

**Files:**
- `server/src/rooms/roomManager.ts`

**Tasks:**
1. Change from random room IDs to named rooms from pool
2. Update `assignPlayer()`:
   - Sort active rooms by player count (descending)
   - Find first non-full room
   - If none, create new room with unused name
   - If all names used and full, reject
3. Remove random room ID generation
4. Keep room cleanup (empty rooms removed after timeout)

### Phase 4: Delta Detection

**Files:**
- `shared/src/voxel/chunkDelta.ts`
- `server/src/storage/PersistentChunkStore.ts`

**Tasks:**
1. Add `isChunkModified(chunk, cx, cy, cz, seed): boolean`:
   - Regenerate chunk from seed
   - Compare to provided chunk data
   - Return true if any voxel differs
2. On save: skip if chunk matches generated terrain
3. On load: check DB first → fallback to terrain generator

---

## File Changes Summary

```
shared/src/
├── protocol/
│   └── constants.ts          # Add ROOM_NAMES, ROOM_SPACING
└── util/
    └── roomOffset.ts         # NEW: roomToOffset()

server/src/
├── storage/
│   ├── WorldStorage.ts       # NEW: LevelDB singleton
│   └── PersistentChunkStore.ts # NEW: ChunkStore implementation
├── rooms/
│   ├── roomManager.ts        # Use named rooms, busiest-first assignment
│   └── room.ts               # Spawn at room offset
├── voxel/
│   └── ChunkProvider.ts      # Use PersistentChunkStore
└── index.ts                  # Graceful shutdown handling
```

---

## Example Flow

1. Player connects → `RoomManager.assignPlayer()`
2. Active rooms: `cozy-crater` (5 players), `sunny-summit` (2 players)
3. `cozy-crater` not full → assign player there
4. `roomToOffset("cozy-crater")` → `{ x: -80000, z: 0 }`
5. Player spawns at `(-80000, 10, 0)` — 10m above surface
6. Client requests chunks around that position
7. Server checks LevelDB → not found → generates from seed → returns
8. Player builds a tower → chunk modified → saved to LevelDB
9. Server restarts → chunk loaded from DB → tower still there
10. Another player joins `cozy-crater` → sees the tower

---

## Storage Estimates

| Scenario | Modified Chunks | Storage |
|----------|-----------------|---------|
| Light building (per room) | ~100 chunks | 6.4 MB |
| Medium session | ~1,000 chunks | 64 MB |
| Heavy building (all rooms) | ~10,000 chunks | 640 MB |

With Snappy compression: **~200-400 MB** for heavy usage.

---

## Future Considerations

- **World reset**: Delete `data/world.db` to start fresh
- **Per-room reset**: Would need to track which chunks belong to which region
- **Multiple worlds**: Could add world ID prefix to keys: `world1:chunk:0,0,0`
- **Backup**: Periodic `tar` of `data/` directory
- **Migration**: Export chunks to JSON for debugging/transfer
