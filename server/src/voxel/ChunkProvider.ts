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
  TerrainGenerator,
} from '@worldify/shared';

/**
 * Interface for chunk storage - allows different backing stores.
 */
export interface ChunkStore {
  get(key: string): ChunkData | undefined;
  set(key: string, chunk: ChunkData): void;
  /** Async get for stores that need disk access */
  getAsync?(key: string): Promise<ChunkData | undefined>;
  /** Mark a chunk as modified (for persistence) */
  markDirty?(key: string): void;
}

/**
 * Provides chunks for a room, creating them on demand with terrain generation.
 */
export class ChunkProvider {
  private readonly store: ChunkStore;
  private readonly terrainGenerator: TerrainGenerator;

  constructor(store: ChunkStore, seed: number = 12345) {
    this.store = store;
    this.terrainGenerator = new TerrainGenerator({ seed });
  }

  /**
   * Get a chunk synchronously from cache, creating it if not cached.
   * NOTE: For persistent stores, use getOrCreateAsync to properly load from disk.
   */
  getOrCreate(cx: number, cy: number, cz: number): ChunkData {
    const key = chunkKey(cx, cy, cz);
    let chunk = this.store.get(key);

    if (!chunk) {
      chunk = new ChunkData(cx, cy, cz);
      const generatedData = this.terrainGenerator.generateChunk(cx, cy, cz);
      chunk.data.set(generatedData);
      this.store.set(key, chunk);
    }

    return chunk;
  }

  /**
   * Get a chunk asynchronously, loading from disk if available.
   * Creates with terrain generation if not found anywhere.
   * @param forceRegen - If true, skip cache/disk and regenerate chunk
   */
  async getOrCreateAsync(cx: number, cy: number, cz: number, forceRegen: boolean = false): Promise<ChunkData> {
    const key = chunkKey(cx, cy, cz);
    
    if (!forceRegen) {
      // Try cache first
      let chunk = this.store.get(key);
      if (chunk) {
        console.log(`[chunk] ${key} from cache`);
        return chunk;
      }

      // Try async load from disk if supported
      if (this.store.getAsync) {
        chunk = await this.store.getAsync(key);
        if (chunk) {
          console.log(`[chunk] ${key} loaded from disk`);
          return chunk;
        }
      }
    }

    // Generate new chunk (or force regenerate)
    console.log(`[chunk] ${key} generated${forceRegen ? ' (force regen)' : ' (not on disk)'}`);
    const chunk = new ChunkData(cx, cy, cz);
    const generatedData = this.terrainGenerator.generateChunk(cx, cy, cz);
    chunk.data.set(generatedData);
    
    // Only persist if not in force regenerate mode
    if (!forceRegen) {
      this.store.set(key, chunk);
    }

    return chunk;
  }

  /**
   * Mark a chunk as modified (for persistence).
   */
  markDirty(cx: number, cy: number, cz: number): void {
    const key = chunkKey(cx, cy, cz);
    if (this.store.markDirty) {
      this.store.markDirty(key);
    }
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
