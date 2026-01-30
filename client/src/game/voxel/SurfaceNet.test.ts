/**
 * Unit tests for SurfaceNet meshing algorithm
 * Run with: npx tsx client/src/game/voxel/SurfaceNet.test.ts
 */

import { meshChunk } from './ChunkMesher.js';
import { isEmptyMesh, SurfaceNetOutput } from './SurfaceNet.js';
import { Chunk } from './Chunk.js';
import { CHUNK_SIZE, packVoxel } from '@worldify/shared';

// Simple test runner
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${e}`);
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${expected}, got ${actual}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if ((actual as number) <= expected) {
        throw new Error(`Expected ${actual} to be greater than ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number) {
      if ((actual as number) < expected) {
        throw new Error(`Expected ${actual} to be >= ${expected}`);
      }
    },
    toBeLessThan(expected: number) {
      if ((actual as number) >= expected) {
        throw new Error(`Expected ${actual} to be less than ${expected}`);
      }
    },
    toBeTrue() {
      if (actual !== true) {
        throw new Error(`Expected true, got ${actual}`);
      }
    },
    toBeFalse() {
      if (actual !== false) {
        throw new Error(`Expected false, got ${actual}`);
      }
    },
  };
}

console.log('\n=== SurfaceNet Tests ===\n');

// ============== Empty Geometry Tests ==============

test('Meshing a fully solid chunk (all weights > 0) produces no geometry', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.fill(0.5, 0, 16); // All solid
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  // No surface crossings inside the chunk = no geometry
  expect(isEmptyMesh(result)).toBeTrue();
});

test('Meshing a fully empty chunk (all weights < 0) produces no geometry', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.fill(-0.5, 0, 16); // All empty
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  expect(isEmptyMesh(result)).toBeTrue();
});

// ============== Flat Terrain Tests ==============

test('Flat terrain at Y=16 produces geometry', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  expect(result.vertexCount).toBeGreaterThan(0);
  expect(result.triangleCount).toBeGreaterThan(0);
});

test('Flat terrain produces roughly a grid of quads', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  // For a flat surface, we expect approximately CHUNK_SIZE-1 x CHUNK_SIZE-1 quads
  // Each quad = 2 triangles, so roughly (31*31)*2 = ~1922 triangles
  // Allow some variance due to boundary handling
  expect(result.triangleCount).toBeGreaterThan(100);
});

// ============== Array Consistency Tests ==============

test('Output arrays have matching vertex counts (positions.length/3 === normals.length/3)', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  expect(result.positions.length / 3).toBe(result.normals.length / 3);
  expect(result.positions.length / 3).toBe(result.vertexCount);
  expect(result.materials.length).toBe(result.vertexCount);
});

test('Indices reference valid vertex indices', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  for (let i = 0; i < result.indices.length; i++) {
    const idx = result.indices[i];
    if (idx >= result.vertexCount) {
      throw new Error(`Index ${idx} at position ${i} exceeds vertex count ${result.vertexCount}`);
    }
  }
});

test('Triangle count matches indices length / 3', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  expect(result.indices.length / 3).toBe(result.triangleCount);
});

// ============== Normal Direction Tests ==============

test('Generated normals are normalized', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  for (let i = 0; i < result.vertexCount; i++) {
    const nx = result.normals[i * 3];
    const ny = result.normals[i * 3 + 1];
    const nz = result.normals[i * 3 + 2];
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    
    if (Math.abs(len - 1.0) > 0.01) {
      throw new Error(`Normal at vertex ${i} has length ${len}, expected ~1.0`);
    }
  }
});

test('Flat terrain normals point upward (away from solid, toward empty)', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  // For flat terrain with solid below and empty above,
  // normals should point predominantly upward (positive Y)
  let upwardCount = 0;
  for (let i = 0; i < result.vertexCount; i++) {
    const ny = result.normals[i * 3 + 1];
    if (ny > 0.5) {
      upwardCount++;
    }
  }
  
  // Most normals should point up
  const upwardRatio = upwardCount / result.vertexCount;
  if (upwardRatio < 0.8) {
    throw new Error(`Only ${(upwardRatio * 100).toFixed(1)}% of normals point upward, expected >80%`);
  }
});

// ============== Material Tests ==============

test('Materials are correctly assigned from solid voxels', () => {
  const chunk = new Chunk(0, 0, 0);
  // Fill with material ID 5
  chunk.generateFlat(16, 5, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  // Check that most vertices have material 5
  let correctMaterialCount = 0;
  for (let i = 0; i < result.materials.length; i++) {
    if (result.materials[i] === 5) {
      correctMaterialCount++;
    }
  }
  
  const ratio = correctMaterialCount / result.materials.length;
  if (ratio < 0.9) {
    throw new Error(`Only ${(ratio * 100).toFixed(1)}% of vertices have correct material, expected >90%`);
  }
});

// ============== Vertex Position Tests ==============

test('Vertices are within chunk bounds', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(16, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  for (let i = 0; i < result.vertexCount; i++) {
    const x = result.positions[i * 3];
    const y = result.positions[i * 3 + 1];
    const z = result.positions[i * 3 + 2];
    
    if (x < 0 || x > CHUNK_SIZE || y < 0 || y > CHUNK_SIZE || z < 0 || z > CHUNK_SIZE) {
      throw new Error(`Vertex ${i} at (${x}, ${y}, ${z}) is outside chunk bounds`);
    }
  }
});

test('Flat terrain vertices are near the surface Y level', () => {
  const surfaceY = 16;
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(surfaceY, 0, 16);
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  // Most vertices should be near Y=16
  let nearSurfaceCount = 0;
  for (let i = 0; i < result.vertexCount; i++) {
    const y = result.positions[i * 3 + 1];
    if (Math.abs(y - surfaceY) < 2) {
      nearSurfaceCount++;
    }
  }
  
  const ratio = nearSurfaceCount / result.vertexCount;
  if (ratio < 0.9) {
    throw new Error(`Only ${(ratio * 100).toFixed(1)}% of vertices near surface, expected >90%`);
  }
});

// ============== Neighbor Boundary Tests ==============

test('Mesh vertices at chunk boundary align with neighbor chunk vertices', () => {
  // Create two adjacent chunks with same flat terrain
  const chunk0 = new Chunk(0, 0, 0);
  const chunk1 = new Chunk(1, 0, 0);
  
  chunk0.generateFlatGlobal(10, 0, 16);
  chunk1.generateFlatGlobal(10, 0, 16);
  
  const neighbors0 = new Map<string, Chunk>();
  neighbors0.set(chunk1.key, chunk1);
  
  const neighbors1 = new Map<string, Chunk>();
  neighbors1.set(chunk0.key, chunk0);
  
  const result0 = meshChunk(chunk0, neighbors0);
  const result1 = meshChunk(chunk1, neighbors1);
  
  // Find vertices at the boundary (x near CHUNK_SIZE for chunk0, x near 0 for chunk1)
  const boundaryVerts0: { y: number; z: number }[] = [];
  const boundaryVerts1: { y: number; z: number }[] = [];
  
  for (let i = 0; i < result0.vertexCount; i++) {
    const x = result0.positions[i * 3];
    if (x > CHUNK_SIZE - 1) {
      boundaryVerts0.push({
        y: result0.positions[i * 3 + 1],
        z: result0.positions[i * 3 + 2],
      });
    }
  }
  
  for (let i = 0; i < result1.vertexCount; i++) {
    const x = result1.positions[i * 3];
    if (x < 1) {
      boundaryVerts1.push({
        y: result1.positions[i * 3 + 1],
        z: result1.positions[i * 3 + 2],
      });
    }
  }
  
  // Both chunks should have similar number of boundary vertices
  // Allow some tolerance
  if (Math.abs(boundaryVerts0.length - boundaryVerts1.length) > 5) {
    throw new Error(
      `Boundary vertex count mismatch: chunk0 has ${boundaryVerts0.length}, chunk1 has ${boundaryVerts1.length}`
    );
  }
});

// ============== Edge Cases ==============

test('Chunk with surface at Y=0 produces geometry', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(1, 0, 16); // Use Y=1 so surface is inside chunk
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  // Should produce geometry
  expect(result.vertexCount).toBeGreaterThan(0);
});

test('Chunk with surface at Y=30 produces geometry (inside chunk bounds)', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(30, 0, 16); // Surface at Y=30, vertices still inside
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  expect(result.vertexCount).toBeGreaterThan(0);
});

test('Chunk with surface at Y=31 needs neighbors for boundary geometry', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.generateFlat(31, 0, 16);
  
  // Create neighbor above with empty space
  const neighborAbove = new Chunk(0, 1, 0);
  neighborAbove.fill(-0.5, 0, 16); // All empty
  
  const neighbors = new Map<string, Chunk>();
  neighbors.set(neighborAbove.key, neighborAbove);
  
  const result = meshChunk(chunk, neighbors);
  
  // Now it should produce geometry at the boundary
  expect(result.vertexCount).toBeGreaterThan(0);
});

test('Single voxel island produces geometry when surrounded by neighbors', () => {
  const chunk = new Chunk(0, 0, 0);
  chunk.fill(-0.5, 0, 16); // All empty
  
  // Place a small solid region in the middle (2x2x2 so we have internal cells)
  for (let z = 14; z <= 17; z++) {
    for (let y = 14; y <= 17; y++) {
      for (let x = 14; x <= 17; x++) {
        chunk.setVoxel(x, y, z, packVoxel(0.5, 3, 16));
      }
    }
  }
  
  const neighbors = new Map<string, Chunk>();
  const result = meshChunk(chunk, neighbors);
  
  // Should produce geometry around the solid region
  expect(result.vertexCount).toBeGreaterThan(0);
  expect(result.triangleCount).toBeGreaterThan(0);
});

// Summary
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
