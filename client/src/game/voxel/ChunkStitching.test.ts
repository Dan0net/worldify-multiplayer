/**
 * Diagnostic tests for chunk boundary stitching issues
 * 
 * These tests investigate the bug where:
 * - 1-voxel wide "cracks" appear at chunk boundaries on positive axis sides
 * - Fully solid underground chunks show a grid-like lattice of columns
 * - The issue is worse when chunks arrive slowly (force regen)
 * - Building fixes the affected chunk
 */

import { describe, test, expect } from 'vitest';
import { meshChunk, ChunkMeshOutput } from './ChunkMesher.js';
import { Chunk } from './Chunk.js';
import { 
  CHUNK_SIZE, 
  packVoxel, 
  chunkKey,
  voxelIndex,
} from '@worldify/shared';

// Helper: Create a fully solid chunk (all voxels have positive weight)
function createSolidChunk(cx: number, cy: number, cz: number): Chunk {
  const chunk = new Chunk(cx, cy, cz);
  chunk.fill(0.5, 1, 16); // weight=0.5 (solid), material=1
  return chunk;
}

// Helper: Create an empty chunk (all voxels have negative weight)
function createEmptyChunk(cx: number, cy: number, cz: number): Chunk {
  const chunk = new Chunk(cx, cy, cz);
  chunk.fill(-0.5, 0, 16); // weight=-0.5 (empty), material=0
  return chunk;
}

// Helper: Get total triangle count from mesh output
function getTotalTriangles(output: ChunkMeshOutput): number {
  return output.solid.triangleCount + output.transparent.triangleCount + output.liquid.triangleCount;
}

// Helper: Check if any vertices are at the high boundary (x >= 31, y >= 31, or z >= 31)
function hasVerticesAtHighBoundary(output: ChunkMeshOutput): {x: boolean, y: boolean, z: boolean} {
  const result = { x: false, y: false, z: false };
  const positions = output.solid.positions;
  
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    
    if (x >= 31) result.x = true;
    if (y >= 31) result.y = true;
    if (z >= 31) result.z = true;
  }
  
  return result;
}

// Helper: Count vertices in a specific X range
function countVerticesInXRange(output: ChunkMeshOutput, minX: number, maxX: number): number {
  const positions = output.solid.positions;
  let count = 0;
  
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    if (x >= minX && x <= maxX) count++;
  }
  
  return count;
}

describe('Fully Solid Chunk Stitching', () => {
  
  test('Solid chunk with NO neighbors should produce NO geometry (internal chunk)', () => {
    // A fully solid chunk surrounded by nothing should have no visible surfaces
    // because there's no air to create a surface against
    // (The skipHighBoundary flag should prevent boundary faces)
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    const result = meshChunk(chunk, neighbors);
    
    console.log(`Solid chunk (no neighbors): ${result.solid.triangleCount} triangles, ${result.solid.vertexCount} vertices`);
    
    // This is the BUG condition - if this fails, solid chunks without neighbors 
    // are incorrectly generating boundary geometry
    expect(getTotalTriangles(result)).toBe(0);
  });

  test('Solid chunk with ALL solid neighbors should produce NO geometry', () => {
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    // Add all 6 face neighbors as solid
    neighbors.set(chunkKey(1, 0, 0), createSolidChunk(1, 0, 0));
    neighbors.set(chunkKey(-1, 0, 0), createSolidChunk(-1, 0, 0));
    neighbors.set(chunkKey(0, 1, 0), createSolidChunk(0, 1, 0));
    neighbors.set(chunkKey(0, -1, 0), createSolidChunk(0, -1, 0));
    neighbors.set(chunkKey(0, 0, 1), createSolidChunk(0, 0, 1));
    neighbors.set(chunkKey(0, 0, -1), createSolidChunk(0, 0, -1));
    
    const result = meshChunk(chunk, neighbors);
    
    console.log(`Solid chunk (all solid neighbors): ${result.solid.triangleCount} triangles, ${result.solid.vertexCount} vertices`);
    
    expect(getTotalTriangles(result)).toBe(0);
  });

  test('Solid chunk with ONLY +X solid neighbor (others missing) should produce NO geometry', () => {
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    // Only +X neighbor exists
    neighbors.set(chunkKey(1, 0, 0), createSolidChunk(1, 0, 0));
    
    const result = meshChunk(chunk, neighbors);
    
    console.log(`Solid chunk (+X neighbor only): ${result.solid.triangleCount} triangles`);
    
    // If neighbors are missing, skipHighBoundary should prevent faces
    // The existing neighbors should stitch properly (no faces between two solid chunks)
    expect(getTotalTriangles(result)).toBe(0);
  });

  test('Solid chunk with +X, +Y, +Z neighbors only should produce NO geometry at positive boundaries', () => {
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    // Only positive side neighbors
    neighbors.set(chunkKey(1, 0, 0), createSolidChunk(1, 0, 0));
    neighbors.set(chunkKey(0, 1, 0), createSolidChunk(0, 1, 0));
    neighbors.set(chunkKey(0, 0, 1), createSolidChunk(0, 0, 1));
    
    const result = meshChunk(chunk, neighbors);
    
    console.log(`Solid chunk (+X,+Y,+Z neighbors): ${result.solid.triangleCount} triangles`);
    const boundary = hasVerticesAtHighBoundary(result);
    console.log(`  Vertices at high boundary: X=${boundary.x}, Y=${boundary.y}, Z=${boundary.z}`);
    
    expect(getTotalTriangles(result)).toBe(0);
  });
});

describe('Margin Voxel Sampling', () => {
  
  test('getVoxelWithMargin returns correct data from +X neighbor', () => {
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    const neighborX = createSolidChunk(1, 0, 0);
    // Set a specific voxel in the neighbor at position (0, 16, 16) 
    neighborX.setVoxel(0, 16, 16, packVoxel(0.3, 99, 15));
    neighbors.set(chunkKey(1, 0, 0), neighborX);
    
    // Query margin position (32, 16, 16) which should map to neighbor's (0, 16, 16)
    const marginVoxel = chunk.getVoxelWithMargin(32, 16, 16, neighbors);
    
    expect(marginVoxel).toBe(packVoxel(0.3, 99, 15));
  });

  test('getVoxelWithMargin extrapolates from edge when neighbor is missing', () => {
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>(); // No neighbors
    
    // Query margin position (32, 16, 16) - no +X neighbor
    // Should extrapolate from (31, 16, 16) which is solid
    const marginVoxel = chunk.getVoxelWithMargin(32, 16, 16, neighbors);
    
    // Should return the clamped position (31, 16, 16) value - which is solid (weight > 0)
    const expectedSolid = chunk.getVoxel(31, 16, 16);
    expect(marginVoxel).toBe(expectedSolid);
  });

  test('getVoxelWithMargin at corner (32, 32, 32) extrapolates from (31,31,31) when corner neighbor missing', () => {
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    // Add only face neighbors, not the corner neighbor (1,1,1)
    neighbors.set(chunkKey(1, 0, 0), createSolidChunk(1, 0, 0));
    neighbors.set(chunkKey(0, 1, 0), createSolidChunk(0, 1, 0));
    neighbors.set(chunkKey(0, 0, 1), createSolidChunk(0, 0, 1));
    
    // Query corner margin position (32, 32, 32) - needs neighbor (1, 1, 1) which doesn't exist
    const marginVoxel = chunk.getVoxelWithMargin(32, 32, 32, neighbors);
    
    // Should extrapolate from (31, 31, 31) which is solid
    const expectedSolid = chunk.getVoxel(31, 31, 31);
    expect(marginVoxel).toBe(expectedSolid);
  });
});

describe('Surface Net Boundary Logic', () => {
  
  test('Solid chunk meshed with all 6 face neighbors solid - check vertex positions', () => {
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    // All face neighbors
    for (const [dx, dy, dz] of [[1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]]) {
      neighbors.set(chunkKey(dx, dy, dz), createSolidChunk(dx, dy, dz));
    }
    
    const result = meshChunk(chunk, neighbors);
    
    if (result.solid.vertexCount > 0) {
      console.log('UNEXPECTED: Solid chunk with solid neighbors has vertices!');
      
      // Log vertex positions to see where the problem is
      const positions = result.solid.positions;
      const xPositions = new Set<number>();
      const yPositions = new Set<number>();
      const zPositions = new Set<number>();
      
      for (let i = 0; i < positions.length; i += 3) {
        xPositions.add(Math.round(positions[i]));
        yPositions.add(Math.round(positions[i + 1]));
        zPositions.add(Math.round(positions[i + 2]));
      }
      
      console.log(`  X positions: ${[...xPositions].sort((a,b)=>a-b).join(', ')}`);
      console.log(`  Y positions: ${[...yPositions].sort((a,b)=>a-b).join(', ')}`);
      console.log(`  Z positions: ${[...zPositions].sort((a,b)=>a-b).join(', ')}`);
    }
    
    expect(result.solid.vertexCount).toBe(0);
  });

  test('Solid chunk meshed with all 26 neighbors solid - no geometry', () => {
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    // All 26 neighbors (6 face + 12 edge + 8 corner)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          if (dx === 0 && dy === 0 && dz === 0) continue;
          neighbors.set(chunkKey(dx, dy, dz), createSolidChunk(dx, dy, dz));
        }
      }
    }
    
    const result = meshChunk(chunk, neighbors);
    
    console.log(`Solid chunk (26 solid neighbors): ${result.solid.triangleCount} triangles`);
    
    expect(result.solid.vertexCount).toBe(0);
  });
});

describe('Edge Case: Missing Corner/Edge Neighbors', () => {
  
  test('Solid chunk with 6 face neighbors but missing corner neighbors', () => {
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    // Only 6 face neighbors (no edge or corner neighbors)
    for (const [dx, dy, dz] of [[1,0,0], [-1,0,0], [0,1,0], [0,-1,0], [0,0,1], [0,0,-1]]) {
      neighbors.set(chunkKey(dx, dy, dz), createSolidChunk(dx, dy, dz));
    }
    
    const result = meshChunk(chunk, neighbors);
    
    console.log(`Solid chunk (6 face neighbors, no corners): ${result.solid.triangleCount} triangles`);
    
    if (result.solid.vertexCount > 0) {
      // This might reveal the bug - corners might be creating spurious surfaces
      const positions = result.solid.positions;
      let cornerVertices = 0;
      let edgeVertices = 0;
      
      for (let i = 0; i < positions.length; i += 3) {
        const x = Math.round(positions[i]);
        const y = Math.round(positions[i + 1]);
        const z = Math.round(positions[i + 2]);
        
        const atXBound = (x <= 0 || x >= 32);
        const atYBound = (y <= 0 || y >= 32);
        const atZBound = (z <= 0 || z >= 32);
        
        const boundCount = (atXBound ? 1 : 0) + (atYBound ? 1 : 0) + (atZBound ? 1 : 0);
        
        if (boundCount >= 3) cornerVertices++;
        else if (boundCount >= 2) edgeVertices++;
      }
      
      console.log(`  Corner vertices (3 bounds): ${cornerVertices}`);
      console.log(`  Edge vertices (2 bounds): ${edgeVertices}`);
    }
    
    // This test documents current behavior - may reveal the bug
    // If faces are generated at edges/corners where neighbors are missing,
    // that's the stitching bug
  });
});

describe('Reproduce Reported Bug', () => {
  
  test('Simulate chunk arriving before +X neighbor - should not generate +X boundary faces', () => {
    // This simulates the race condition:
    // Chunk at (0,0,0) is meshed before neighbor at (1,0,0) arrives
    
    const chunk = createSolidChunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    // Simulate: only -X, -Y, -Z neighbors have arrived
    neighbors.set(chunkKey(-1, 0, 0), createSolidChunk(-1, 0, 0));
    neighbors.set(chunkKey(0, -1, 0), createSolidChunk(0, -1, 0));
    neighbors.set(chunkKey(0, 0, -1), createSolidChunk(0, 0, -1));
    
    const result = meshChunk(chunk, neighbors);
    
    console.log(`Solid chunk (only -X,-Y,-Z neighbors): ${result.solid.triangleCount} triangles`);
    
    if (result.solid.vertexCount > 0) {
      // Count vertices at high boundary - these are the "crack" faces
      const highBoundary = hasVerticesAtHighBoundary(result);
      console.log(`  Vertices at +X boundary (x>=31): ${highBoundary.x}`);
      console.log(`  Vertices at +Y boundary (y>=31): ${highBoundary.y}`);
      console.log(`  Vertices at +Z boundary (z>=31): ${highBoundary.z}`);
      
      const verticesAtX31 = countVerticesInXRange(result, 31, 33);
      console.log(`  Total vertices at X=31-33: ${verticesAtX31}`);
    }
    
    // The bug: skipHighBoundary should prevent +X,+Y,+Z boundary faces
    // but we're seeing faces anyway
    expect(result.solid.triangleCount).toBe(0);
  });

  test('Re-mesh after +X neighbor arrives - should still have no geometry', () => {
    const chunk = createSolidChunk(0, 0, 0);
    
    // First mesh without +X neighbor
    const neighbors1 = new Map<string, Chunk>();
    neighbors1.set(chunkKey(-1, 0, 0), createSolidChunk(-1, 0, 0));
    const result1 = meshChunk(chunk, neighbors1);
    console.log(`First mesh (no +X): ${result1.solid.triangleCount} triangles`);
    
    // Second mesh after +X neighbor arrives  
    const neighbors2 = new Map<string, Chunk>();
    neighbors2.set(chunkKey(-1, 0, 0), createSolidChunk(-1, 0, 0));
    neighbors2.set(chunkKey(1, 0, 0), createSolidChunk(1, 0, 0));
    const result2 = meshChunk(chunk, neighbors2);
    console.log(`Second mesh (with +X): ${result2.solid.triangleCount} triangles`);
    
    // After remesh with neighbor, should be 0 triangles
    expect(result2.solid.triangleCount).toBe(0);
  });
});
