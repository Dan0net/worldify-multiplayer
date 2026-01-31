# Normal Stitching Analysis & Implementation Plan

## Problem Statement

When chunks are meshed independently, vertices at chunk boundaries get different normals because each chunk only accumulates face normals from its own faces. This causes visible seams in lighting across chunk boundaries.

**You've been through multiple conversations trying to implement this, and it's still not working.** This document takes a **radically simplified approach** - proving each step works before moving on.

---

## Part 1: How worldify-app Does It

### Key Files
- [ChunkMesh.ts](../worldify-app/src/3d/ChunkMesh.ts) - Contains `stitchVertices()` and `stitchGeometry()` 
- [ChunkCoordinator.ts](../worldify-app/src/3d/ChunkCoordinator.ts) - Calls stitching after mesh rendering

### The Algorithm (worldify-app)

#### Step 1: Identify Boundary Vertices
```typescript
// ChunkMesh.ts lines 365-380
seamAxisRange(offset: number, side: number): [number, number] {
  switch (offset) {
    case -1: return [0, 1];                              // Low boundary: voxels 0-1
    case 0:  return [0, CHUNK_SIZE_WMARGIN - 1];         // Full range
    case 1:  return [CHUNK_SIZE_WMARGIN - 2, CHUNK_SIZE_WMARGIN - 1]; // High boundary
  }
}
```

The key insight: worldify-app uses **voxel-space coordinates** (0 to `CHUNK_SIZE_WMARGIN-1`), NOT world-space.

#### Step 2: Find Matching Vertices via Spatial Hash
```typescript
// ChunkMesh.ts lines 440-480
// Transform neighbor position into "this chunk's coordinate system"
if (isSameSize) {
  nx = xN + (xOffset * CHUNK_SIZE);  // Simple offset
  ny = yN + (yOffset * CHUNK_SIZE);
  nz = zN + (zOffset * CHUNK_SIZE);
}
// Quantize and hash
const key = (keyX & 0x3FF) | ((keyY & 0x3FF) << 10) | ((keyZ & 0x3FF) << 20);
```

**Critical**: The neighbor's vertex position is **transformed** so that matching vertices from both chunks end up at the **same quantized position**.

#### Step 3: Copy Normals (NOT Average)
```typescript
// ChunkMesh.ts lines 637-649
if (isSameSize) {
  // Just COPY the normal from neighbor to this chunk
  normals[ind] = neighbourNormals[match.index];
  normals[ind + 1] = neighbourNormals[match.index + 1];
  normals[ind + 2] = neighbourNormals[match.index + 2];
}
```

**Key difference from worldify-multiplayer**: worldify-app **copies** normals from neighbor to self. It doesn't average. The last-rendered chunk "wins".

#### Step 4: When Stitching is Triggered
```typescript
// ChunkCoordinator.ts lines 919-927 (in renderNextChunk)
chunk.renderMesh(true).then(() => {
  // After rendering, stitch with all neighbors
  const neighbours = this.chunkNeighbourMap.get(chunk.chunkKey);
  if (neighbours) {
    neighbours.forEach((neighbourKey) => {
      const neighbour = this.chunks.get(neighbourKey);
      if (neighbour) this.stitchNeighbourChunkVertices(chunk, neighbour)
    })
  }
})
```

### Phase 1: Prove Vertex Matching Works (Visual Debug)

**Goal**: Before any normal work, PROVE we can find matching vertices at boundaries.

Create a **debug visualization** that:
1. Colors boundary vertices RED on chunk A
2. Colors matched vertices GREEN on chunk B
3. If matching works, you should see green/red pairs at every boundary

```typescript
// New file: client/src/game/voxel/NormalStitchDebug.ts

export function debugBoundaryVertices(
  meshA: ChunkMesh,
  meshB: ChunkMesh, 
  offsetX: number,
  offsetY: number,
  offsetZ: number,
  scene: THREE.Scene
): void {
  // 1. Get boundary vertices from both meshes
  // 2. Create debug spheres: RED for A's boundary verts, BLUE for B's
  // 3. For matched pairs, color them GREEN
  // 4. Log: "Found X vertices on boundary, matched Y pairs"
}
```

**Success Criteria**:
- Run on flat terrain (simple case)
- See matching green spheres at chunk boundary
- Count of matched pairs should be > 0

### Phase 2: Test Normal Alignment on Flat Terrain

**Goal**: On perfectly flat terrain, all normals should point straight up (0, 1, 0).

1. Generate flat terrain (all voxels at same Y level)
2. Mesh two adjacent chunks
3. Before stitching: Log normals at boundary - they should already be (0,1,0)
4. After stitching: Verify normals are still (0,1,0)

This tests that we don't BREAK working normals.

### Phase 3: Test on Sloped Terrain

**Goal**: On a 45° slope, boundary normals should match.

1. Generate terrain with consistent slope across chunk boundary
2. Before stitching: Log normals at boundary - they will differ slightly
3. After stitching: Normals should be identical between matched pairs

### Phase 4: Integrate into VoxelWorld

**Goal**: Call stitching automatically after meshing.

```typescript
// In VoxelWorld.remeshChunk() or after it:
remeshChunk(chunk: Chunk): void {
  // ... existing mesh generation ...
  
  // After meshing, stitch with neighbors
  this.stitchChunkNormals(chunk);
}

private stitchChunkNormals(chunk: Chunk): void {
  const mesh = this.meshes.get(chunk.key);
  if (!mesh) return;
  
  stitchWithNeighbors(
    mesh,
    chunk.cx, chunk.cy, chunk.cz,
    (cx, cy, cz) => this.meshes.get(chunkKey(cx, cy, cz)),
    (cx, cy, cz) => {
      // Is neighbor also freshly meshed this frame?
      return this.remeshQueue.has(chunkKey(cx, cy, cz));
    }
  );
}
```

### Phase 5: Handle Build Preview

When previewing a build:
1. Temp mesh is created for affected chunks
2. Stitch temp mesh with neighbors (existing meshes)
3. Use "copy from neighbor" mode (not averaging)

### Phase 6: Handle Build Commit

When committing a build:
1. Real meshes are updated for affected chunks
2. Stitch with all neighbors
3. Queue neighbor remesh if needed

---

## Part 4: Key Differences to Adopt from worldify-app

### 1. Use Voxel-Space Coordinates
Instead of world-space boundaries, use grid indices:
```typescript
// worldify-app style
const boundaryMin = offset === -1 ? 0 : CHUNK_SIZE - 1;
const boundaryMax = offset === -1 ? 1 : CHUNK_SIZE;
```

### 2. Copy Instead of Average (for asymmetric remesh)
When only ONE chunk was remeshed, copy its normals to the neighbor (don't average):
```typescript
if (!neighborIsFresh) {
  // Neighbor wasn't remeshed - copy THIS chunk's normal to it
  neighborNormals.setXYZ(neighborIdx, myNx, myNy, myNz);
} else {
  // Both fresh - average them
  const avgX = (myNx + nNx) / 2;
  // ... normalize and apply to both
}
```

### 3. Use Integer Hash Keys
worldify-app packs coordinates into a single integer for O(1) lookup:
```typescript
const key = (keyX & 0x3FF) | ((keyY & 0x3FF) << 10) | ((keyZ & 0x3FF) << 20);
```

### 4. Cache Spatial Hashes
worldify-app caches the spatial hash on the ChunkMesh so repeated stitching is fast.

---

## Part 5: Minimal Test Implementation

Before doing the full implementation, create this **minimal test**:

```typescript
// In a test file or temp debug code

function testVertexMatching() {
  // Get two adjacent chunks
  const chunkA = voxelWorld.getChunk(0, 0, 0);
  const chunkB = voxelWorld.getChunk(1, 0, 0);  // B is at +X from A
  
  const meshA = voxelWorld.meshes.get('0,0,0');
  const meshB = voxelWorld.meshes.get('1,0,0');
  
  const posA = meshA.getMesh().geometry.getAttribute('position');
  const posB = meshB.getMesh().geometry.getAttribute('position');
  
  // Find vertices at A's +X boundary (near x = CHUNK_WORLD_SIZE)
  const boundaryA = [];
  for (let i = 0; i < posA.count; i++) {
    const x = posA.getX(i);
    if (x > CHUNK_WORLD_SIZE - 0.5) {
      boundaryA.push({ idx: i, x, y: posA.getY(i), z: posA.getZ(i) });
    }
  }
  
  // Find vertices at B's -X boundary (near x = 0)
  const boundaryB = [];
  for (let i = 0; i < posB.count; i++) {
    const x = posB.getX(i);
    if (x < 0.5) {
      boundaryB.push({ idx: i, x, y: posB.getY(i), z: posB.getZ(i) });
    }
  }
  
  console.log(`Boundary A: ${boundaryA.length} vertices`);
  console.log(`Boundary B: ${boundaryB.length} vertices`);
  
  // Try to match by Y,Z position
  let matches = 0;
  for (const vA of boundaryA) {
    for (const vB of boundaryB) {
      const dy = Math.abs(vA.y - vB.y);
      const dz = Math.abs(vA.z - vB.z);
      if (dy < 0.1 && dz < 0.1) {
        matches++;
        console.log(`Match: A[${vA.idx}] (${vA.x.toFixed(2)}, ${vA.y.toFixed(2)}, ${vA.z.toFixed(2)}) <-> B[${vB.idx}] (${vB.x.toFixed(2)}, ${vB.y.toFixed(2)}, ${vB.z.toFixed(2)})`);
      }
    }
  }
  
  console.log(`Total matches: ${matches}`);
}
```

**Run this FIRST**. If matches = 0, the problem is coordinate systems. If matches > 0, move to normal stitching.

---

## Part 6: Debugging Checklist

When debugging, check these things:

1. **Are chunks positioned correctly?**
   - Chunk (0,0,0) should have its mesh at world position (0, 0, 0)
   - Chunk (1,0,0) should have its mesh at world position (8, 0, 0)

2. **Are vertex positions in local or world space?**
   - BufferGeometry positions are usually LOCAL to the mesh
   - When comparing, you need to account for mesh.position

3. **Is the surface actually crossing the boundary?**
   - If terrain is fully above or below the surface at the boundary, there are no boundary vertices

4. **Are you checking the right boundary?**
   - For chunks at (+X direction), A's HIGH X boundary matches B's LOW X boundary

5. **Is precision correct for matching?**
   - Too tight: no matches
   - Too loose: false matches

---

## Next Steps

1. **Verify build works** - Run `npm run build` and fix any missing imports
2. **Add debug visualization** - Phase 1 above
3. **Run minimal test** - Part 5 above
4. **Share the console output** - How many boundary vertices? How many matches?

Only after proving vertex matching works should we proceed to normal stitching.
