# Visibility-Based Chunk System Plan

## Overview

Replace distance-based chunk loading with Minecraft-style visibility culling.
Single system for both loading AND rendering.

## Architecture

```
Initial Spawn → Surface Column Request → Establish position
     ↓
Visibility BFS → Determines visible chunks → Load + Render
     ↓
Map Tiles → Separate system, full radius request
```

## Phase 1: Visibility Data Structure

**Add to Chunk:**
```typescript
// 15 bits: one per face pair (6 faces, C(6,2) = 15 pairs)
// Bit set = can see through chunk from face A to face B
visibilityBits: number;
```

**Face pairs encoding:**
```
0: +X ↔ -X    5: +Y ↔ -Z    10: +Z ↔ -Z
1: +X ↔ +Y    6: +Y ↔ +Z    11: -X ↔ -Y
2: +X ↔ -Y    7: -Y ↔ +Z    12: -X ↔ +Z
3: +X ↔ +Z    8: -Y ↔ -Z    13: -Y ↔ -Z
4: +X ↔ -Z    9: +Y ↔ -Y    14: -X ↔ -Z
```

## Phase 2: Flood Fill on Chunk Data Receive

When chunk voxel data arrives, compute visibility immediately:

```typescript
function computeVisibility(voxelData: Uint16Array): number {
  // For each non-solid voxel at boundary, flood fill
  // Track which faces are reachable from which
  // Return 15-bit mask
}
```

Run in `receiveChunkData()` / `receiveSurfaceColumnData()` before meshing.
Visibility only needs voxel solidity, not mesh geometry.

## Phase 3: BFS Visibility Traversal

**Called every frame:**

```typescript
function getVisibleChunks(cameraChunk, cameraDir): Set<string> {
  const visible = new Set<string>();
  const queue: Array<{chunk, entryFace}> = [];
  
  // Start from camera chunk
  queue.push({ chunk: cameraChunk, entryFace: null });
  
  while (queue.length > 0) {
    const { chunk, entryFace } = queue.shift();
    if (visible.has(chunk.key)) continue;
    
    visible.add(chunk.key);
    
    // Check each neighbor
    for (const [neighbor, exitFace] of getNeighbors(chunk)) {
      // Filter 1: Don't go backward (dot product check)
      if (dot(exitFace.normal, cameraDir) > 0) continue;
      
      // Filter 2: Visibility graph - can we see through?
      if (entryFace && !canSeeThrough(chunk, entryFace, exitFace)) continue;
      
      // Filter 3: Frustum cull
      if (!inFrustum(neighbor)) continue;
      
      // Filter 4: Distance limit
      if (distance(neighbor, cameraChunk) > MAX_RADIUS) continue;
      
      queue.push({ chunk: neighbor, entryFace: exitFace.opposite });
    }
  }
  
  return visible;
}
```

## Phase 4: Unified Load + Render Loop

```typescript
update(playerPos) {
  const visibleChunks = getVisibleChunks(playerChunk, cameraDir);
  
  // Request missing visible chunks
  for (const key of visibleChunks) {
    if (!this.chunks.has(key) && !this.pendingChunks.has(key)) {
      this.requestChunk(key);
    }
  }
  
  // Render visible chunks that are loaded
  for (const key of visibleChunks) {
    const chunk = this.chunks.get(key);
    if (chunk?.mesh) {
      chunk.mesh.visible = true;
    }
  }
  
  // Hide non-visible chunks (keep loaded for cache)
  for (const chunk of this.chunks.values()) {
    if (!visibleChunks.has(chunk.key)) {
      chunk.mesh.visible = false;
    }
  }
  
  // Unload chunks far outside visible set (memory management)
  this.unloadDistantInvisibleChunks(visibleChunks);
}
```

## Phase 5: Initial Spawn Bootstrap

```typescript
init() {
  // Request surface column at spawn point
  this.requestSurfaceColumn(spawnTx, spawnTz);
  // Wait for response, then normal visibility loop takes over
}
```

## Phase 6: Map Tiles (Separate)

Map tiles continue using existing `MapTileRequest` system:
- Full radius request on connect
- Not tied to visibility (overview map needs everything)
- Already implemented, no changes needed

## File Changes

| File | Change |
|------|--------|
| `shared/src/voxel/Chunk.ts` | Add `visibilityBits` field |
| `shared/src/voxel/visibility.ts` | NEW: Flood fill + bit encoding |
| `client/src/game/voxel/Chunk.ts` | Add `visibilityBits` |
| `client/src/game/voxel/VoxelWorld.ts` | Call `computeVisibility` on receive, replace loading logic with BFS |
| `client/src/game/voxel/VisibilityBFS.ts` | NEW: BFS traversal |

## Constants

```typescript
// shared/src/voxel/constants.ts
export const VISIBILITY_RADIUS = 8;  // Max BFS distance
export const UNLOAD_BUFFER = 2;      // Keep chunks this far beyond visible
```

## Edge Cases

1. **Empty chunks** (all air): visibility = 0xFFFF (all pairs visible)
2. **Solid chunks** (all solid): visibility = 0x0000 (nothing visible)
3. **Chunk not yet loaded**: Assume visible (request it)
4. **Camera inside solid**: Use last valid position

## Performance Notes

- BFS is O(visible chunks) not O(all chunks)
- Frustum cull is expensive, do last
- Visibility bits computed once per mesh, not per frame
- Cache traversal result, invalidate on chunk change or camera move
