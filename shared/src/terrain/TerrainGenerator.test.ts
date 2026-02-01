import { describe, it, expect } from 'vitest';
import { TerrainGenerator } from './TerrainGenerator.js';
import { CHUNK_SIZE } from '../voxel/constants.js';

describe('TerrainGenerator', () => {
  it('produces deterministic output for same seed', () => {
    const gen1 = new TerrainGenerator({ seed: 12345 });
    const gen2 = new TerrainGenerator({ seed: 12345 });

    const h1 = gen1.sampleHeight(100, 200);
    const h2 = gen2.sampleHeight(100, 200);

    expect(h1).toBe(h2);
  });

  it('produces consistent output for same position', () => {
    const gen = new TerrainGenerator({ seed: 11111 });

    const h1 = gen.sampleHeight(50, 50);
    const h2 = gen.sampleHeight(50, 50);

    expect(h1).toBe(h2);
  });

  it('height varies with position', () => {
    const gen = new TerrainGenerator({ seed: 42 });

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
    const gen = new TerrainGenerator({ seed: 999, baseHeight: 100, heightLayers: [] });

    // With no layers, height should be exactly baseHeight
    expect(gen.sampleHeight(0, 0)).toBe(100);
    expect(gen.sampleHeight(999, 999)).toBe(100);
  });

  it('generates chunk data as Uint16Array', () => {
    const gen = new TerrainGenerator({ seed: 123 });
    const chunk = gen.generateChunk(0, 0, 0);

    expect(chunk).toBeInstanceOf(Uint16Array);
    expect(chunk.length).toBe(CHUNK_SIZE * CHUNK_SIZE * CHUNK_SIZE);
  });

  it('generates empty chunk above terrain', () => {
    const gen = new TerrainGenerator({ seed: 777, baseHeight: 10, heightLayers: [] });

    // Chunk at Y=10 (voxel Y 320) is way above baseHeight=10
    const chunk = gen.generateChunk(0, 10, 0);
    // All voxels should be air (weight >= 0 means outside surface)
    const allAir = chunk.every((v) => v === 0);
    expect(allAir).toBe(true);
  });

  it('generates non-empty chunk containing terrain', () => {
    const gen = new TerrainGenerator({ seed: 777, baseHeight: 16, heightLayers: [] });

    // Chunk at Y=0 contains voxels 0-31, terrain at height 16
    const chunk = gen.generateChunk(0, 0, 0);
    // Some voxels should be solid (non-zero)
    const hasSolid = chunk.some((v) => v !== 0);
    expect(hasSolid).toBe(true);
  });
});
