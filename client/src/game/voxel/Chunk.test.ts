/**
 * Unit tests for Chunk class
 */

import { describe, test, expect } from 'vitest';
import { Chunk } from './Chunk.js';
import {
  CHUNK_SIZE,
  VOXELS_PER_CHUNK,
  packVoxel,
  getWeight,
  chunkKey,
} from '@worldify/shared';

describe('Chunk Constructor Tests', () => {
  test('new Chunk(0, 0, 0) creates chunk with 32,768 voxel array', () => {
    const chunk = new Chunk(0, 0, 0);
    expect(chunk.data.length).toBe(VOXELS_PER_CHUNK);
    expect(chunk.data.length).toBe(32768);
  });

  test('Chunk stores coordinates correctly', () => {
    const chunk = new Chunk(1, -2, 3);
    expect(chunk.cx).toBe(1);
    expect(chunk.cy).toBe(-2);
    expect(chunk.cz).toBe(3);
  });

  test('Chunk has correct key', () => {
    const chunk = new Chunk(1, -2, 3);
    expect(chunk.key).toBe('1,-2,3');
  });

  test('New chunk is dirty by default', () => {
    const chunk = new Chunk(0, 0, 0);
    expect(chunk.dirty).toBe(true);
  });
});

describe('Get/Set Voxel Tests', () => {
  test('setVoxel and getVoxel round-trip correctly', () => {
    const chunk = new Chunk(0, 0, 0);
    const value = packVoxel(0.25, 42, 20);
    chunk.setVoxel(5, 5, 5, value);
    expect(chunk.getVoxel(5, 5, 5)).toBe(value);
  });

  test('setVoxel marks chunk as dirty', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.clearDirty();
    expect(chunk.dirty).toBe(false);
    
    chunk.setVoxel(0, 0, 0, packVoxel(0, 0, 0));
    expect(chunk.dirty).toBe(true);
  });

  test('getVoxel returns 0 for out-of-bounds coordinates', () => {
    const chunk = new Chunk(0, 0, 0);
    expect(chunk.getVoxel(-1, 0, 0)).toBe(0);
    expect(chunk.getVoxel(32, 0, 0)).toBe(0);
    expect(chunk.getVoxel(0, -1, 0)).toBe(0);
    expect(chunk.getVoxel(0, 32, 0)).toBe(0);
  });

  test('setVoxel ignores out-of-bounds coordinates', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.clearDirty();
    chunk.setVoxel(-1, 0, 0, 12345);
    expect(chunk.dirty).toBe(false);
  });

  test('getWeightAt extracts weight correctly', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.setVoxel(10, 10, 10, packVoxel(0.3, 5, 10));
    expect(chunk.getWeightAt(10, 10, 10)).toBeCloseTo(0.3, 1);
  });
});

describe('Fill Tests', () => {
  test('fill sets all voxels to same value', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.fill(0.25, 10, 20);
    
    expect(getWeight(chunk.getVoxel(0, 0, 0))).toBeCloseTo(0.25, 1);
    expect(getWeight(chunk.getVoxel(15, 15, 15))).toBeCloseTo(0.25, 1);
    expect(getWeight(chunk.getVoxel(31, 31, 31))).toBeCloseTo(0.25, 1);
  });

  test('fill marks chunk as dirty', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.clearDirty();
    chunk.fill(0, 0, 0);
    expect(chunk.dirty).toBe(true);
  });
});

describe('Generate Flat Tests', () => {
  test('generateFlat fills below surface with positive weight', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(10, 0, 16);
    
    expect(chunk.getWeightAt(5, 0, 5)).toBeGreaterThan(0);
    expect(chunk.getWeightAt(5, 5, 5)).toBeGreaterThan(0);
    expect(chunk.getWeightAt(5, 9, 5)).toBeGreaterThan(0);
  });

  test('generateFlat fills above surface with negative weight', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(10, 0, 16);
    
    expect(chunk.getWeightAt(5, 11, 5)).toBeLessThan(0);
    expect(chunk.getWeightAt(5, 20, 5)).toBeLessThan(0);
    expect(chunk.getWeightAt(5, 31, 5)).toBeLessThan(0);
  });

  test('generateFlat surface voxel has weight near 0', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.generateFlat(10, 0, 16);
    
    expect(chunk.getWeightAt(5, 10, 5)).toBeCloseTo(0, 1);
  });

  test('generateFlat marks chunk as dirty', () => {
    const chunk = new Chunk(0, 0, 0);
    chunk.clearDirty();
    chunk.generateFlat(10);
    expect(chunk.dirty).toBe(true);
  });
});

describe('Generate Flat Global Tests', () => {
  test('generateFlatGlobal adjusts for chunk Y position', () => {
    const chunk = new Chunk(0, 1, 0);
    chunk.generateFlatGlobal(10, 0, 16);
    
    expect(chunk.getWeightAt(5, 0, 5)).toBeLessThan(0);
    expect(chunk.getWeightAt(5, 31, 5)).toBeLessThan(0);
  });

  test('generateFlatGlobal works for chunk below surface', () => {
    const chunk = new Chunk(0, -1, 0);
    chunk.generateFlatGlobal(10, 0, 16);
    
    expect(chunk.getWeightAt(5, 0, 5)).toBeGreaterThan(0);
    expect(chunk.getWeightAt(5, 31, 5)).toBeGreaterThan(0);
  });
});

describe('Margin Sampling Tests', () => {
  test('getVoxelWithMargin returns own voxel for in-bounds coords', () => {
    const chunk = new Chunk(0, 0, 0);
    const value = packVoxel(0.2, 5, 10);
    chunk.setVoxel(15, 15, 15, value);
    
    const neighbors = new Map<string, Chunk>();
    expect(chunk.getVoxelWithMargin(15, 15, 15, neighbors)).toBe(value);
  });

  test('getVoxelWithMargin(-1, 5, 5) samples from neighbor at cx-1', () => {
    const chunk = new Chunk(0, 0, 0);
    const neighborChunk = new Chunk(-1, 0, 0);
    
    const value = packVoxel(0.4, 77, 25);
    neighborChunk.setVoxel(31, 5, 5, value);
    
    const neighbors = new Map<string, Chunk>();
    neighbors.set(neighborChunk.key, neighborChunk);
    
    expect(chunk.getVoxelWithMargin(-1, 5, 5, neighbors)).toBe(value);
  });

  test('getVoxelWithMargin(32, 5, 5) samples from neighbor at cx+1', () => {
    const chunk = new Chunk(0, 0, 0);
    const neighborChunk = new Chunk(1, 0, 0);
    
    const value = packVoxel(-0.3, 50, 15);
    neighborChunk.setVoxel(0, 5, 5, value);
    
    const neighbors = new Map<string, Chunk>();
    neighbors.set(neighborChunk.key, neighborChunk);
    
    expect(chunk.getVoxelWithMargin(32, 5, 5, neighbors)).toBe(value);
  });

  test('getVoxelWithMargin handles Y axis neighbors', () => {
    const chunk = new Chunk(0, 0, 0);
    const neighborAbove = new Chunk(0, 1, 0);
    const neighborBelow = new Chunk(0, -1, 0);
    
    const valueAbove = packVoxel(-0.4, 10, 5);
    const valueBelow = packVoxel(0.3, 20, 10);
    
    neighborAbove.setVoxel(5, 0, 5, valueAbove);
    neighborBelow.setVoxel(5, 31, 5, valueBelow);
    
    const neighbors = new Map<string, Chunk>();
    neighbors.set(neighborAbove.key, neighborAbove);
    neighbors.set(neighborBelow.key, neighborBelow);
    
    expect(chunk.getVoxelWithMargin(5, 32, 5, neighbors)).toBe(valueAbove);
    expect(chunk.getVoxelWithMargin(5, -1, 5, neighbors)).toBe(valueBelow);
  });

  test('getVoxelWithMargin handles Z axis neighbors', () => {
    const chunk = new Chunk(0, 0, 0);
    const neighborFront = new Chunk(0, 0, 1);
    const neighborBack = new Chunk(0, 0, -1);
    
    const valueFront = packVoxel(0.1, 30, 20);
    const valueBack = packVoxel(-0.2, 40, 25);
    
    neighborFront.setVoxel(5, 5, 0, valueFront);
    neighborBack.setVoxel(5, 5, 31, valueBack);
    
    const neighbors = new Map<string, Chunk>();
    neighbors.set(neighborFront.key, neighborFront);
    neighbors.set(neighborBack.key, neighborBack);
    
    expect(chunk.getVoxelWithMargin(5, 5, 32, neighbors)).toBe(valueFront);
    expect(chunk.getVoxelWithMargin(5, 5, -1, neighbors)).toBe(valueBack);
  });

  test('getVoxelWithMargin handles corner neighbors (diagonal)', () => {
    const chunk = new Chunk(0, 0, 0);
    const cornerNeighbor = new Chunk(-1, -1, -1);
    
    const value = packVoxel(0.5, 100, 30);
    cornerNeighbor.setVoxel(31, 31, 31, value);
    
    const neighbors = new Map<string, Chunk>();
    neighbors.set(cornerNeighbor.key, cornerNeighbor);
    
    expect(chunk.getVoxelWithMargin(-1, -1, -1, neighbors)).toBe(value);
  });

  test('getVoxelWithMargin returns empty voxel when neighbor missing', () => {
    const chunk = new Chunk(0, 0, 0);
    const neighbors = new Map<string, Chunk>();
    
    const result = chunk.getVoxelWithMargin(-1, 5, 5, neighbors);
    expect(getWeight(result)).toBeCloseTo(-0.5, 2);
  });

  test('getWeightWithMargin extracts weight correctly', () => {
    const chunk = new Chunk(0, 0, 0);
    const neighbor = new Chunk(-1, 0, 0);
    neighbor.setVoxel(31, 5, 5, packVoxel(0.35, 0, 0));
    
    const neighbors = new Map<string, Chunk>();
    neighbors.set(neighbor.key, neighbor);
    
    expect(chunk.getWeightWithMargin(-1, 5, 5, neighbors)).toBeCloseTo(0.35, 1);
  });
});

describe('World Position Tests', () => {
  test('getWorldPosition returns correct position for origin chunk', () => {
    const chunk = new Chunk(0, 0, 0);
    const pos = chunk.getWorldPosition();
    expect(pos.x).toBe(0);
    expect(pos.y).toBe(0);
    expect(pos.z).toBe(0);
  });

  test('getWorldPosition returns correct position for offset chunk', () => {
    const chunk = new Chunk(2, -1, 3);
    const pos = chunk.getWorldPosition();
    expect(pos.x).toBe(16);
    expect(pos.y).toBe(-8);
    expect(pos.z).toBe(24);
  });
});

describe('Clear Dirty Tests', () => {
  test('clearDirty sets dirty to false', () => {
    const chunk = new Chunk(0, 0, 0);
    expect(chunk.dirty).toBe(true);
    chunk.clearDirty();
    expect(chunk.dirty).toBe(false);
  });
});
