import { describe, it, expect } from 'vitest';
import { TerrainGenerator } from './TerrainGenerator.js';

describe('TerrainGenerator', () => {
  it('produces deterministic output for same seed', () => {
    const gen1 = new TerrainGenerator(12345);
    const gen2 = new TerrainGenerator(12345);

    const h1 = gen1.sampleHeight(100, 200);
    const h2 = gen2.sampleHeight(100, 200);

    expect(h1).toBe(h2);
  });

  it('produces different output for different seeds', () => {
    const gen1 = new TerrainGenerator(11111);
    const gen2 = new TerrainGenerator(22222);

    const h1 = gen1.sampleHeight(50, 50);
    const h2 = gen2.sampleHeight(50, 50);

    expect(h1).not.toBe(h2);
  });

  it('height varies with position', () => {
    const gen = new TerrainGenerator(42);

    const heights = [
      gen.sampleHeight(0, 0),
      gen.sampleHeight(10, 0),
      gen.sampleHeight(0, 10),
      gen.sampleHeight(100, 100),
    ];

    // Not all heights should be the same (noise varies)
    const unique = new Set(heights);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('respects base height from config', () => {
    const gen = new TerrainGenerator(999);
    gen.setConfig({ baseHeight: 100, heightLayers: [] });

    // With no layers, height should be exactly baseHeight
    expect(gen.sampleHeight(0, 0)).toBe(100);
    expect(gen.sampleHeight(999, 999)).toBe(100);
  });

  it('generates chunk data as Uint16Array', () => {
    const gen = new TerrainGenerator(123);
    const chunk = gen.generateChunk(0, 0, 0);

    expect(chunk).toBeInstanceOf(Uint16Array);
    expect(chunk.length).toBe(32 * 32 * 32); // CHUNK_SIZE^3
  });

  it('isChunkEmpty returns true for chunks above terrain', () => {
    const gen = new TerrainGenerator(777);
    gen.setConfig({ baseHeight: 10, heightLayers: [] });

    // Chunk at Y=10 (voxel Y 320) is way above baseHeight=10
    expect(gen.isChunkEmpty(0, 10, 0)).toBe(true);
  });

  it('isChunkEmpty returns false for chunks containing terrain', () => {
    const gen = new TerrainGenerator(777);
    gen.setConfig({ baseHeight: 16, heightLayers: [] });

    // Chunk at Y=0 contains voxels 0-31, terrain at height 16
    expect(gen.isChunkEmpty(0, 0, 0)).toBe(false);
  });
});
