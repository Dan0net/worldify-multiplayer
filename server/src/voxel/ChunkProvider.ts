/**
 * ChunkProvider - Handles chunk retrieval and creation for a room
 * 
 * Single Responsibility: Only handles chunk access and creation.
 * Open/Closed: Terrain generation strategy could be extended via subclass.
 * Dependency Inversion: Consumers depend on this abstraction, not concrete terrain generation.
 */

import {
  ChunkData,
  chunkKey,
  GROUND_LEVEL,
  VOXEL_SCALE,
} from '@worldify/shared';

/**
 * Interface for chunk storage - allows different backing stores.
 */
export interface ChunkStore {
  get(key: string): ChunkData | undefined;
  set(key: string, chunk: ChunkData): void;
}

/**
 * Interface for terrain generation - allows different terrain strategies.
 */
export interface TerrainGenerator {
  generate(chunk: ChunkData): void;
}

/**
 * Default terrain generator - flat terrain at ground level.
 */
export class FlatTerrainGenerator implements TerrainGenerator {
  private readonly groundVoxelY: number;

  constructor(groundLevel: number = GROUND_LEVEL) {
    this.groundVoxelY = Math.floor(groundLevel / VOXEL_SCALE);
  }

  generate(chunk: ChunkData): void {
    chunk.generateFlatGlobal(this.groundVoxelY);
  }
}

/**
 * Provides chunks for a room, creating them on demand with terrain generation.
 */
export class ChunkProvider {
  private readonly store: ChunkStore;
  private readonly terrainGenerator: TerrainGenerator;

  constructor(store: ChunkStore, terrainGenerator?: TerrainGenerator) {
    this.store = store;
    this.terrainGenerator = terrainGenerator ?? new FlatTerrainGenerator();
  }

  /**
   * Get a chunk, creating it if it doesn't exist.
   */
  getOrCreate(cx: number, cy: number, cz: number): ChunkData {
    const key = chunkKey(cx, cy, cz);
    let chunk = this.store.get(key);

    if (!chunk) {
      chunk = new ChunkData(cx, cy, cz);
      this.terrainGenerator.generate(chunk);
      this.store.set(key, chunk);
    }

    return chunk;
  }

  /**
   * Get a chunk if it exists, undefined otherwise.
   */
  get(cx: number, cy: number, cz: number): ChunkData | undefined {
    return this.store.get(chunkKey(cx, cy, cz));
  }
}

/**
 * Simple Map-based chunk store (default for Room).
 */
export class MapChunkStore implements ChunkStore {
  private readonly chunks = new Map<string, ChunkData>();

  get(key: string): ChunkData | undefined {
    return this.chunks.get(key);
  }

  set(key: string, chunk: ChunkData): void {
    this.chunks.set(key, chunk);
  }

  /** Get the underlying map for iteration */
  getAll(): Map<string, ChunkData> {
    return this.chunks;
  }

  clear(): void {
    this.chunks.clear();
  }
}
