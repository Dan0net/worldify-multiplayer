# Map Tile System

## Overview

Map tiles provide a 2D heightmap/surface view of the world. Each tile covers one chunk column (32×32 XZ voxels = 8m × 8m).

**Key uses:**
- Render overhead map UI
- Optimize chunk Y-axis streaming (know which Y levels have content)
- Fast spawn position lookup (without raycasting)

## Terminology

| Term | Definition |
|------|------------|
| **Terrain Height** | Procedural height from `TerrainGenerator.sampleHeight()`. Never changes. |
| **Surface Height** | Actual highest solid voxel after builds/digging. Stored in map tile. |
| **Terrain** | Procedural world (hills, paths, stamps). Used for spawning. |
| **Surface** | Current world state including player modifications. Used for map display. |

## Two Heights, Two Purposes

```
Surface (what you see)     ████ ← Player-built tower
                          ████
Terrain (procedural)  ▓▓▓▓▓▓▓▓▓▓▓▓ ← Ground level
                      ▓▓▓▓▓▓▓▓▓▓▓▓
                      ▓▓▓▓▓▓▓▓▓▓▓▓
```

| Use Case | Which Height? | Source |
|----------|---------------|--------|
| Player spawn | Terrain | `TerrainGenerator.sampleHeight()` |
| Stamp/building placement | Terrain | `TerrainGenerator.sampleHeight()` |
| Map rendering | Surface | Map tile data |
| Chunk Y-range optimization | Surface | Map tile data |

**Why spawn on terrain, not surface?**
- Players should land on ground, not on rooftops
- Consistent spawn behavior regardless of builds
- `sampleHeight()` is deterministic and fast

## Data Structure

```typescript
// shared/src/maptile/MapTileData.ts

export const MAP_TILE_SIZE = 32;  // Same as CHUNK_SIZE
export const MAP_TILE_PIXELS = MAP_TILE_SIZE * MAP_TILE_SIZE;  // 1024

export interface MapTileData {
  tx: number;  // Tile X (same as chunk X)
  tz: number;  // Tile Z (same as chunk Z)
  
  /** Current surface height per pixel (voxel Y of highest solid) */
  heights: Int16Array;   // 1024 × int16 = 2KB
  
  /** Surface material ID per pixel */
  materials: Uint8Array; // 1024 × uint8 = 1KB
}

// Key format: "tx,tz" (e.g., "3,-5")
export function mapTileKey(tx: number, tz: number): string;
```

**Total size:** ~3KB per tile (same footprint as chunk XZ slice)

## Generation Flow

### Initial Generation (Chunk First Request)

```
Client requests chunk (cx, cy, cz)
         │
         ▼
Server: ChunkProvider.getOrCreateAsync(cx, cy, cz)
         │
         ├─► Chunk exists in cache/disk? Return it
         │
         └─► Generate chunk from TerrainGenerator
                    │
                    ▼
              MapTileProvider.ensureTileExists(cx, cz)
                    │
                    ├─► Tile exists? Update from chunk
                    │
                    └─► Generate tile by scanning chunk column
                              │
                              ▼
                        Scan all loaded chunks at (cx, *, cz)
                        Find highest solid voxel per XZ
                        Store height + material
```

**Key insight:** Tiles are generated/updated as a side-effect of chunk generation. No separate generation pass needed.

### Tile Generation from Chunks

```typescript
// When generating tile for column (tx, tz):
for each pixel (lx, lz) in 0..31:
  maxHeight = -32768  // Start with minimum
  surfaceMaterial = 0
  
  for each loaded chunk at (tx, cy, tz):
    for ly in 0..31 (top to bottom):
      voxelY = cy * 32 + ly
      if isSolid(chunk.getVoxel(lx, ly, lz)):
        if voxelY > maxHeight:
          maxHeight = voxelY
          surfaceMaterial = getMaterial(voxel)
  
  tile.heights[index] = maxHeight
  tile.materials[index] = surfaceMaterial
```

**Edge case - no chunks loaded yet:**
- Use `TerrainGenerator.sampleSurface(worldX, worldZ)` as initial estimate
- Update when actual chunks load

## Build Modifications

### When Player Builds/Digs

```
Build commit applied to chunk
         │
         ▼
MapTileProvider.updateFromChunk(chunk)
         │
         ▼
For each modified XZ column in chunk:
  - Scan column to find new highest solid
  - Update tile.heights[x,z] and tile.materials[x,z]
  - Mark tile dirty for persistence
         │
         ▼
If tile changed && clients in radius:
  - Broadcast MSG_MAP_TILE_DELTA to affected clients
```

### Digging Below Surface

```
Before:  Surface at Y=10
         ▓▓▓▓▓▓

After:   Player digs hole
         ▓▓  ▓▓  ← Surface now Y=5 in the hole
         ▓▓▓▓▓▓
```

The tile correctly reflects the new lowest point in that column.

## Network Protocol

```typescript
// shared/src/protocol/mapTileMessages.ts

// Client → Server
export const MSG_MAP_TILE_REQUEST = 0x08;

// Server → Client  
export const MSG_MAP_TILE_DATA = 0x89;   // Full tile data
export const MSG_MAP_TILE_DELTA = 0x8A;  // Partial update (after builds)

export interface MapTileRequest {
  tx: number;
  tz: number;
}

export interface MapTileResponse {
  tx: number;
  tz: number;
  heights: Int16Array;   // 2KB
  materials: Uint8Array; // 1KB
}

export interface MapTileDelta {
  tx: number;
  tz: number;
  /** Changed pixels: [index, height, material, ...] */
  changes: Uint8Array;  // Variable size
}
```

## Client Behavior

### Tile Requests

- **Independent of chunks:** Client can request tiles anytime (map browsing)
- **Not required before chunks:** Chunks work without tiles (current behavior preserved)
- **Opportunistic:** Request tiles for visible map area, chunk loading uses them if available

### Streaming Integration

```typescript
// VoxelWorld.ts - Enhanced chunk loading

updateLoadedChunks(pcx, pcy, pcz) {
  for each (cx, cz) in XZ range:
    const tile = mapTileCache.get(cx, cz);
    
    if (tile) {
      // Smart loading: only request chunks with content
      const { minY, maxY } = getYRangeFromTile(tile, cx, cz);
      for cy in minY..maxY:
        requestChunk(cx, cy, cz);
    } else {
      // Fallback: request tiles, use default Y range
      requestMapTile(cx, cz);
      for cy in defaultYRange:
        requestChunk(cx, cy, cz);
    }
}
```

### Delta Updates

Same radius logic as chunks:
- Client subscribes to tile updates for tiles in streaming radius
- Server broadcasts `MSG_MAP_TILE_DELTA` when builds modify tiles
- Client applies delta to local cache

## Server Components

```
server/src/
├── storage/
│   └── MapTileStore.ts      # LevelDB persistence (like PersistentChunkStore)
└── voxel/
    └── MapTileProvider.ts   # Generation + updates
```

### MapTileStore

```typescript
export class MapTileStore {
  private cache = new Map<string, MapTileData>();
  private dirty = new Set<string>();
  
  get(tx: number, tz: number): MapTileData | undefined;
  set(tx: number, tz: number, tile: MapTileData): void;
  markDirty(tx: number, tz: number): void;
  
  async getAsync(tx: number, tz: number): Promise<MapTileData | undefined>;
  async flush(): Promise<void>;  // Persist dirty tiles
}
```

### MapTileProvider

```typescript
export class MapTileProvider {
  constructor(
    store: MapTileStore,
    chunkProvider: ChunkProvider,
    terrainGenerator: TerrainGenerator
  );
  
  /** Get tile, generating if needed */
  getOrCreate(tx: number, tz: number): MapTileData;
  
  /** Update tile when chunk data changes */
  updateFromChunk(chunk: ChunkData): void;
  
  /** Generate tile from terrain (when no chunks exist) */
  private generateFromTerrain(tx: number, tz: number): MapTileData;
  
  /** Scan loaded chunks to build tile */
  private scanChunkColumn(tx: number, tz: number): MapTileData;
}
```

## Client Components

```
client/src/game/maptile/
├── MapTileCache.ts    # Client-side tile storage
├── MapRenderer.ts     # Canvas-based map rendering
└── index.ts
```

### MapTileCache

```typescript
export class MapTileCache {
  private tiles = new Map<string, MapTileData>();
  
  get(tx: number, tz: number): MapTileData | undefined;
  set(tx: number, tz: number, tile: MapTileData): void;
  applyDelta(delta: MapTileDelta): void;
  
  /** Query helpers */
  getHeightAt(worldX: number, worldZ: number): number | null;
  getMaterialAt(worldX: number, worldZ: number): number | null;
  getYRange(tx: number, tz: number): { minY: number; maxY: number } | null;
}
```

### MapRenderer (Debug Priority)

```typescript
export class MapRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  
  /** Render tiles centered on player position */
  render(
    tiles: Map<string, MapTileData>,
    playerTx: number,
    playerTz: number,
    radiusTiles: number
  ): void;
  
  /** Color lookup for materials */
  private getMaterialColor(materialId: number): string;
  
  /** Height to grayscale/contour */
  private getHeightShading(height: number): number;
}
```

## Spawn Integration

### Server-Side Spawn

```typescript
// room.ts - createPlayerState()

function createPlayerState(playerId: number, playerCount: number, roomId?: string) {
  const spawnPos = roomToSpawnPosition(roomId, 0);  // Get XZ
  
  // Use terrain height (procedural), not surface height
  const terrainY = terrainGenerator.sampleHeight(spawnPos.x, spawnPos.z);
  const spawnY = terrainY * VOXEL_SCALE + PLAYER_HEIGHT;
  
  return {
    x: spawnPos.x + offset.x,
    y: spawnY,
    z: spawnPos.z + offset.z,
    ...
  };
}
```

### Client-Side Spawn (Fallback)

```typescript
// SpawnManager.ts

getSpawnPosition(x: number, z: number): Vector3 {
  // Option 1: Use terrain generator (if available client-side)
  const terrainY = this.terrainGenerator?.sampleHeight(x, z);
  if (terrainY !== null) {
    return new Vector3(x, terrainY * VOXEL_SCALE + PLAYER_HEIGHT, z);
  }
  
  // Option 2: Raycast (current fallback)
  return this.raycastSpawn(x, z);
}
```

## Implementation Phases

### Phase 1: Core Infrastructure
1. `shared/src/maptile/` - Data structures, constants, utilities
2. `shared/src/terrain/TerrainGenerator.ts` - Add `sampleSurface()` method
3. `server/src/storage/MapTileStore.ts` - LevelDB persistence

### Phase 2: Server Generation
1. `server/src/voxel/MapTileProvider.ts` - Generation + chunk updates
2. Integrate with `ChunkProvider` - Generate tiles when chunks created
3. Update tiles on build commits

### Phase 3: Network Protocol
1. `shared/src/protocol/mapTileMessages.ts` - Message definitions
2. Server handlers for tile requests
3. Client handlers for tile data/deltas

### Phase 4: Client Cache + Debug Map
1. `client/src/game/maptile/MapTileCache.ts` - Client storage
2. `client/src/game/maptile/MapRenderer.ts` - Debug canvas map
3. Simple React component to toggle map overlay

### Phase 5: Smart Streaming
1. Modify `VoxelWorld.ts` to use tile data for Y-range optimization
2. Fallback behavior when tiles not yet loaded

### Phase 6: Spawn Integration
1. Server uses `sampleHeight()` for authoritative spawn Y
2. Client spawn manager uses same logic

## FAQ

**Q: Do tiles need to be requested before chunks?**
A: No. Chunks work independently. Tiles are an optimization layer.

**Q: What if client browses map for an area with no chunks loaded?**
A: Server generates tile from `TerrainGenerator.sampleSurface()` (fast, no chunk creation needed).

**Q: How do stamps (trees, rocks) affect height?**
A: Stamps are part of terrain generation. When chunks with stamps are generated, the tile is updated to reflect the stamp's surface.

**Q: What happens if all chunks in a column are unloaded?**
A: Tile persists in LevelDB. It represents last-known surface state.

**Q: How big is a tile request radius?**
A: For map UI: configurable (e.g., 20 tiles = 160m visible)
   For streaming: same as chunk XZ radius (STREAM_RADIUS)
