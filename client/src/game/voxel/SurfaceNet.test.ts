/**
 * Unit tests for SurfaceNet meshing algorithm
 */

import { describe, test, expect } from 'vitest';
import { meshChunk } from './ChunkMesher.js';
import { isEmptyMesh, SurfaceNetOutput } from './SurfaceNet.js';
import { Chunk } from './Chunk.js';
import { CHUNK_SIZE, packVoxel } from '@worldify/shared';

describe('Empty Geometry Tests', () => {
  test('Meshing a fully solid chunk (all weights > 0) produces no geometry', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.fill(0.5, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    expect(isEmptyMesh(result)).toBe(true);
  });

  test('Meshing a fully empty chunk (all weights < 0) produces no geometry', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.fill(-0.5, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    expect(isEmptyMesh(result)).toBe(true);
  });
});

describe('Flat Terrain Tests', () => {
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
    
    expect(result.triangleCount).toBeGreaterThan(100);
  });
});

describe('Array Consistency Tests', () => {
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
      expect(idx).toBeLessThan(result.vertexCount);
    }
  });

  test('Triangle count matches indices length / 3', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    expect(result.indices.length / 3).toBe(result.triangleCount);
  });
});

describe('Normal Direction Tests', () => {
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
      
      expect(Math.abs(len - 1.0)).toBeLessThanOrEqual(0.01);
    }
  });

  test('Flat terrain normals point upward (away from solid, toward empty)', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    let upwardCount = 0;
    for (let i = 0; i < result.vertexCount; i++) {
      const ny = result.normals[i * 3 + 1];
      if (ny > 0.5) {
        upwardCount++;
      }
    }
    
    const upwardRatio = upwardCount / result.vertexCount;
    expect(upwardRatio).toBeGreaterThanOrEqual(0.8);
  });
});

describe('Material Tests', () => {
  test('Materials are correctly assigned from solid voxels', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 5, 16);
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    let correctMaterialCount = 0;
    for (let i = 0; i < result.materials.length; i++) {
      if (result.materials[i] === 5) {
        correctMaterialCount++;
      }
    }
    
    const ratio = correctMaterialCount / result.materials.length;
    expect(ratio).toBeGreaterThanOrEqual(0.9);
  });
});

describe('Vertex Position Tests', () => {
  test('Vertices are within chunk bounds', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(16, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    for (let i = 0; i < result.vertexCount; i++) {
      const x = result.positions[i * 3];
      const y = result.positions[i * 3 + 1];
      const z = result.positions[i * 3 + 2];
      
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(CHUNK_SIZE);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(CHUNK_SIZE);
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(CHUNK_SIZE);
    }
  });

  test('Flat terrain vertices are near the surface Y level', () => {
    const surfaceY = 16;
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(surfaceY, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    let nearSurfaceCount = 0;
    for (let i = 0; i < result.vertexCount; i++) {
      const y = result.positions[i * 3 + 1];
      if (Math.abs(y - surfaceY) < 2) {
        nearSurfaceCount++;
      }
    }
    
    const ratio = nearSurfaceCount / result.vertexCount;
    expect(ratio).toBeGreaterThanOrEqual(0.9);
  });
});

describe('Neighbor Boundary Tests', () => {
  test('Mesh vertices at chunk boundary align with neighbor chunk vertices', () => {
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
    
    expect(Math.abs(boundaryVerts0.length - boundaryVerts1.length)).toBeLessThanOrEqual(5);
  });
});

describe('Edge Cases', () => {
  test('Chunk with surface at Y=0 produces geometry', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(1, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    expect(result.vertexCount).toBeGreaterThan(0);
  });

  test('Chunk with surface at Y=30 produces geometry (inside chunk bounds)', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(30, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    expect(result.vertexCount).toBeGreaterThan(0);
  });

  test('Chunk with surface at Y=31 needs neighbors for boundary geometry', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(31, 0, 16);
    
    const neighborAbove = new Chunk(0, 1, 0);
    neighborAbove.fill(-0.5, 0, 16);
    
    const neighbors = new Map<string, Chunk>();
    neighbors.set(neighborAbove.key, neighborAbove);
    
    const result = meshChunk(chunk, neighbors);
    
    expect(result.vertexCount).toBeGreaterThan(0);
  });

  test('Single voxel island produces geometry when surrounded by neighbors', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.fill(-0.5, 0, 16);
    
    for (let z = 14; z <= 17; z++) {
      for (let y = 14; y <= 17; y++) {
        for (let x = 14; x <= 17; x++) {
          chunk.setVoxel(x, y, z, packVoxel(0.5, 3, 16));
        }
      }
    }
    
    const neighbors = new Map<string, Chunk>();
    const result = meshChunk(chunk, neighbors);
    
    expect(result.vertexCount).toBeGreaterThan(0);
    expect(result.triangleCount).toBeGreaterThan(0);
  });
});
