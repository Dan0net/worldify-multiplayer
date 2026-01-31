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

1. **FastNoiseLite setup** - Add package, create NoiseLayer wrapper
2. **HeightSampler** - Composable layers with warp
3. **Refactor TerrainGenerator** - Use new HeightSampler
4. **Cache toggle** - F8 debug mode
5. **StampData + generators** - Tree/rock stamps
6. **StampPlacer** - Margin-aware placement
7. **Preview page** - Stamp/terrain viewer
8. **MaterialSampler** - 3D underground materials
9. **LevelDB height cache** - Map tile support
