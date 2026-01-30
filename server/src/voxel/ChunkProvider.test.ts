/**
 * Tests for ChunkProvider
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { 
  ChunkProvider, 
  MapChunkStore, 
  FlatTerrainGenerator,
  TerrainGenerator,
  ChunkStore,
} from './ChunkProvider.js';
import { ChunkData, getWeight } from '@worldify/shared';

describe('MapChunkStore', () => {
  let store: MapChunkStore;

  beforeEach(() => {
    store = new MapChunkStore();
  });

  it('should return undefined for non-existent chunk', () => {
    expect(store.get('0,0,0')).toBeUndefined();
  });

  it('should store and retrieve chunks', () => {
    const chunk = new ChunkData(0, 0, 0);
    store.set('0,0,0', chunk);
    expect(store.get('0,0,0')).toBe(chunk);
  });

  it('should clear all chunks', () => {
    store.set('0,0,0', new ChunkData(0, 0, 0));
    store.set('1,0,0', new ChunkData(1, 0, 0));
    store.clear();
    expect(store.get('0,0,0')).toBeUndefined();
    expect(store.get('1,0,0')).toBeUndefined();
  });
});

describe('FlatTerrainGenerator', () => {
  it('should generate flat terrain at specified height', () => {
    const generator = new FlatTerrainGenerator(2); // 2m ground level
    const chunk = new ChunkData(0, 0, 0);
    
    generator.generate(chunk);
    
    // At 2m ground level with 0.25m voxel scale = voxel Y=8 is surface
    // Voxels below surface should be solid (positive weight)
    // Voxels above surface should be empty (negative weight)
    const belowSurface = chunk.getVoxel(16, 0, 16);
    const aboveSurface = chunk.getVoxel(16, 31, 16);
    
    expect(getWeight(belowSurface)).toBeGreaterThan(0);
    expect(getWeight(aboveSurface)).toBeLessThan(0);
  });
});

describe('ChunkProvider', () => {
  let store: MapChunkStore;
  let provider: ChunkProvider;

  beforeEach(() => {
    store = new MapChunkStore();
    provider = new ChunkProvider(store);
  });

  describe('getOrCreate', () => {
    it('should create a new chunk if it does not exist', () => {
      const chunk = provider.getOrCreate(0, 0, 0);
      
      expect(chunk).toBeInstanceOf(ChunkData);
      expect(chunk.cx).toBe(0);
      expect(chunk.cy).toBe(0);
      expect(chunk.cz).toBe(0);
    });

    it('should return existing chunk if it exists', () => {
      const chunk1 = provider.getOrCreate(0, 0, 0);
      const chunk2 = provider.getOrCreate(0, 0, 0);
      
      expect(chunk1).toBe(chunk2);
    });

    it('should store created chunk in the store', () => {
      provider.getOrCreate(1, 2, 3);
      
      expect(store.get('1,2,3')).toBeDefined();
    });

    it('should apply terrain generation to new chunks', () => {
      const chunk = provider.getOrCreate(0, 0, 0);
      
      // With default FlatTerrainGenerator, should have terrain
      // Check that not all voxels are 0
      let hasNonZero = false;
      for (let i = 0; i < chunk.data.length; i++) {
        if (chunk.data[i] !== 0) {
          hasNonZero = true;
          break;
        }
      }
      expect(hasNonZero).toBe(true);
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent chunk', () => {
      expect(provider.get(0, 0, 0)).toBeUndefined();
    });

    it('should return existing chunk', () => {
      const created = provider.getOrCreate(0, 0, 0);
      const retrieved = provider.get(0, 0, 0);
      
      expect(retrieved).toBe(created);
    });
  });

  describe('custom terrain generator', () => {
    it('should use custom terrain generator', () => {
      // Custom generator that fills with a specific value
      const customGenerator: TerrainGenerator = {
        generate: (chunk: ChunkData) => {
          chunk.fill(0.5, 42, 16); // Fill with material 42
        },
      };
      
      const customProvider = new ChunkProvider(store, customGenerator);
      const chunk = customProvider.getOrCreate(5, 5, 5);
      
      // Check that custom generator was used
      const voxel = chunk.getVoxel(16, 16, 16);
      expect(voxel).not.toBe(0);
    });
  });

  describe('custom chunk store', () => {
    it('should use custom chunk store', () => {
      const customChunks = new Map<string, ChunkData>();
      const customStore: ChunkStore = {
        get: (key) => customChunks.get(key),
        set: (key, chunk) => customChunks.set(key, chunk),
      };
      
      const customProvider = new ChunkProvider(customStore);
      customProvider.getOrCreate(0, 0, 0);
      
      expect(customChunks.has('0,0,0')).toBe(true);
    });
  });
});
