# Terrain Generation System

## Overview

Layered terrain generation with composable noise, stamps, and dev tooling.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    TerrainGenerator                              │
├─────────────────────────────────────────────────────────────────┤
│  1. HeightSampler      │  2D noise layers → terrain height      │
│  2. MaterialSampler    │  3D noise → underground materials      │
│  3. StampPlacer        │  Point generation → voxel stamps       │
└─────────────────────────────────────────────────────────────────┘
```

### 1. HeightSampler (2D)

Generates terrain height at any (x, z) world position.

**Responsibilities:**
- Composable noise layers (continental, hills, detail)
- Per-layer domain warp support
- Per-layer noise type (Simplex, Ridged, Cellular)
- Returns: `{ height: number, surfaceMaterial: number }`

**Storage:**
- Height + surface material cached in LevelDB (server)
- Used for map tile generation (client renders 2D map)

**Extensibility points:**
- Spline remapping (height curves)
- Biome masks (layer contribution by region)

### 2. MaterialSampler (3D)

Assigns materials to voxels below the surface.

**Responsibilities:**
- 3D noise for rock strata, ore veins, caves
- Material selection based on depth + noise
- Rare material pockets (deterministic placement)

**Inputs:** `(worldX, worldY, worldZ, distanceFromSurface)`  
**Returns:** `materialId: number`

### 3. StampPlacer

Places voxel prefabs (trees, rocks, structures) into terrain.

**Responsibilities:**
- Deterministic point generation from noise
- Margin-aware: finds points in expanded region around chunk
- Applies stamp portions that overlap current chunk

**Algorithm:**
```
1. For chunk (cx, cy, cz), expand search region by MAX_STAMP_RADIUS
2. Query all potential placement points in expanded region
3. For each point, check if stamp overlaps current chunk bounds
4. Apply overlapping voxels to chunk data
```

**Stamp Library:** `shared/src/terrain/stamps/`
- Procedurally generated (trees, boulders)
- Stored as `{ size: [x,y,z], data: Uint16Array, origin: [x,y,z] }`

---

## Noise System

### FastNoiseLite Integration

Replace custom SimplexNoise with `fastnoise-lite` package.

```typescript
interface NoiseLayer {
  type: 'OpenSimplex2' | 'Perlin' | 'Cellular' | 'Value';
  frequency: number;
  amplitude: number;
  fractal?: {
    type: 'FBm' | 'Ridged' | 'PingPong';
    octaves: number;
    lacunarity: number;
    gain: number;
  };
  warp?: {
    type: 'OpenSimplex2' | 'BasicGrid';
    amplitude: number;
    frequency: number;
  };
}
```

### Layer Composition

```typescript
interface HeightConfig {
  seed: number;
  baseHeight: number;
  layers: NoiseLayer[];
  blend: 'add' | 'multiply' | 'max' | 'min'; // Future: per-layer blend modes
}
```

---

## Dev Tooling

### F8 Debug Toggle

Keyboard shortcut to disable chunk caching for rapid iteration.

**Behavior:**
1. Press F8 → sends `SetDevMode { cacheChunks: false }` to server
2. Server clears chunk cache + disables future caching
3. UI shows indicator "CACHE OFF"
4. Press F8 again → re-enables caching

**Implementation:**
- Client: `InputManager` listens for F8, sends WS message
- Server: `ChunkProvider.setCacheEnabled(bool)` + `store.clear()`

### Preview Page (`/preview`)

Route for viewing stamps and terrain samples.

**Features:**
- Stamp viewer: rotate/zoom individual stamps
- Terrain slice: 2D heightmap visualization
- Noise layer inspector: see individual layer contributions

---

## Map System

### Architecture

WebSocket-based tile streaming (same pattern as voxel chunks).

```
┌─────────────┐     SubscribeMapRegion      ┌─────────────┐
│   Client    │ ──────────────────────────► │   Server    │
│  (Canvas)   │                             │  (Room)     │
│             │ ◄────────────────────────── │             │
└─────────────┘       MapTile (PNG)         └─────────────┘
                                                   │
                                                   ▼
                                            ┌─────────────┐
                                            │   LevelDB   │
                                            │  (tiles/)   │
                                            └─────────────┘
```

### Why WebSocket (not HTTP)?

- Tiles update in real-time when players build
- Same infrastructure as voxel streaming
- Server pushes updates, no polling needed
- Consistent architecture

### Protocol Messages

```typescript
// Client → Server (0x30-0x3F range)
SubscribeMapRegion   0x30  { minX: i16, minZ: i16, maxX: i16, maxZ: i16, zoom: u8 }
UnsubscribeMapRegion 0x31  { }

// Server → Client (0xB0-0xBF range)
MapTile              0xB0  { x: i16, z: i16, zoom: u8, png: bytes }
```

### Client: Canvas-based Map Component

Custom canvas (not Leaflet) for WS compatibility.

```typescript
// MapUI.tsx
- Pan: mouse drag
- Zoom: wheel (discrete zoom levels)
- Click: teleport to location
- Render: draw tile images on canvas grid
- Subscribe: send region on pan/zoom, receive tile updates
```

### Server: Tile Generation + Subscription

```typescript
// TileManager.ts
class TileManager {
  // Track which clients are viewing which regions
  private subscriptions: Map<ClientId, MapRegion>;
  
  // Generate tile from HeightSampler
  generateTile(x: number, z: number, zoom: number): Uint8Array;
  
  // On chunk modification, regenerate affected tile + push to viewers
  onChunkModified(cx: number, cy: number, cz: number): void;
}
```

### Tile Storage (LevelDB)

```
Key:    tile:{zoom}:{x}:{z}
Value:  PNG bytes (256×256)

Key:    tileHeight:{x}:{z}
Value:  Float32Array (256×256) - for spawn placement
```

### Tile Invalidation Flow

```
Player builds → Chunk modified → markTileDirty(tileX, tileZ)
                                        │
                ┌───────────────────────┴───────────────────────┐
                ▼                                               ▼
        Regenerate tile                                 Push to subscribers
        Store in LevelDB                                (if any viewing)
```

---

## File Structure

```
shared/src/terrain/
├── index.ts                 # Public exports
├── TerrainGenerator.ts      # Main orchestrator
├── HeightSampler.ts         # 2D terrain height
├── MaterialSampler.ts       # 3D material selection
├── StampPlacer.ts           # Object placement
├── NoiseLayer.ts            # FastNoiseLite wrapper
├── types.ts                 # Config interfaces
└── stamps/
    ├── index.ts             # Stamp registry
    ├── StampData.ts         # Stamp type definition
    ├── trees.ts             # Tree generators
    └── rocks.ts             # Rock generators
```

---

## Implementation Order

### Phase 1: Map View (Visual Feedback First)

1. **Canvas MapUI component** - Pan/zoom/render tiles on canvas
2. **Map protocol messages** - SubscribeMapRegion, MapTile in shared
3. **Server TileManager** - Generate tiles from current HeightSampler, track subscriptions
4. **Wire up client↔server** - Subscribe on map open, render received tiles

### Phase 2: Noise Upgrade

5. **FastNoiseLite setup** - Add package, create NoiseLayer wrapper
6. **HeightSampler refactor** - Composable layers with warp
7. **Integrate HeightSampler** - Replace current noise in TerrainGenerator

### Phase 3: Dev Tooling

8. **F8 cache toggle** - Disable chunk saving/caching, clear cache
9. **Tile invalidation** - Regenerate + push tiles on chunk modification

### Phase 4: Stamps & Objects

10. **StampData + generators** - Tree/rock stamp definitions
11. **StampPlacer** - Margin-aware placement in chunks
12. **Preview page** - `/preview` route for stamp/terrain viewing

### Phase 5: Polish

13. **MaterialSampler** - 3D underground materials
14. **Height storage** - LevelDB cache for spawn placement

