/**
 * Tests for ChunkProvider
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ChunkProvider, ChunkStore } from './ChunkProvider.js';
import { ChunkData, getWeight } from '@worldify/shared';

/**
 * Simple Map-based chunk store for testing.
 */
class TestChunkStore implements ChunkStore {
  private readonly chunks = new Map<string, ChunkData>();

  get(key: string): ChunkData | undefined {
    return this.chunks.get(key);
  }

  set(key: string, chunk: ChunkData): void {
    this.chunks.set(key, chunk);
  }

  has(key: string): boolean {
    return this.chunks.has(key);
  }

  clear(): void {
    this.chunks.clear();
  }
}

describe('ChunkProvider', () => {
  let store: TestChunkStore;
  let provider: ChunkProvider;

  beforeEach(() => {
    store = new TestChunkStore();
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
      
      expect(store.has('1,2,3')).toBe(true);
    });

    it('should apply terrain generation to new chunks', () => {
      const chunk = provider.getOrCreate(0, -1, 0);
      
      // With TerrainGenerator, chunks at y=-1 should have terrain
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

    it('should generate terrain with proper height variation', () => {
      // Chunk below ground level should have solid voxels at top
      const chunk = provider.getOrCreate(0, -1, 0);
      
      // Check some voxels have positive weight (solid)
      let hasSolid = false;
      for (let z = 0; z < 32; z++) {
        for (let x = 0; x < 32; x++) {
          const voxel = chunk.getVoxel(x, 31, z); // Top of chunk
          if (getWeight(voxel) > 0) {
            hasSolid = true;
            break;
          }
        }
        if (hasSolid) break;
      }
      expect(hasSolid).toBe(true);
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

  describe('seed consistency', () => {
    it('should generate same terrain with same seed', () => {
      const store1 = new TestChunkStore();
      const store2 = new TestChunkStore();
      const provider1 = new ChunkProvider(store1, 12345);
      const provider2 = new ChunkProvider(store2, 12345);
      
      const chunk1 = provider1.getOrCreate(5, -1, 5);
      const chunk2 = provider2.getOrCreate(5, -1, 5);
      
      // Same seed should produce identical terrain
      expect(chunk1.data).toEqual(chunk2.data);
    });

    it('should generate different terrain with different seeds', () => {
      const store1 = new TestChunkStore();
      const store2 = new TestChunkStore();
      const provider1 = new ChunkProvider(store1, 11111);
      const provider2 = new ChunkProvider(store2, 22222);
      
      const chunk1 = provider1.getOrCreate(5, -1, 5);
      const chunk2 = provider2.getOrCreate(5, -1, 5);
      
      // Different seeds should produce different terrain
      let isDifferent = false;
      for (let i = 0; i < chunk1.data.length; i++) {
        if (chunk1.data[i] !== chunk2.data[i]) {
          isDifferent = true;
          break;
        }
      }
      expect(isDifferent).toBe(true);
    });
  });
});
