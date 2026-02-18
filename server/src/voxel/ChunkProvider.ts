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
 * Async chunk generation function signature.
 * Injected by StorageManager when a worker pool is available.
 */
export type AsyncChunkGenerator = (cx: number, cy: number, cz: number) => Promise<Uint16Array>;

/**
 * Provides chunks for a room, creating them on demand with terrain generation.
 */
export class ChunkProvider {
  private readonly store: ChunkStore;
  private readonly terrainGenerator: TerrainGenerator;
  private asyncGenerator: AsyncChunkGenerator | null = null;
  /** Dedup map: prevents the same chunk from being generated concurrently */
  private readonly inFlight = new Map<string, Promise<ChunkData>>();

  constructor(store: ChunkStore, seed: number = 12345) {
    this.store = store;
    this.terrainGenerator = new TerrainGenerator({ seed });
  }

  /**
   * Set an async chunk generator (e.g., worker pool).
   * When set, getOrCreateAsync uses this instead of the local TerrainGenerator.
   */
  setAsyncGenerator(generator: AsyncChunkGenerator): void {
    this.asyncGenerator = generator;
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
   * Deduplicates concurrent requests for the same chunk.
   * @param forceRegen - If true, skip cache/disk and regenerate chunk
   */
  async getOrCreateAsync(cx: number, cy: number, cz: number, forceRegen: boolean = false): Promise<ChunkData> {
    const key = chunkKey(cx, cy, cz);

    if (!forceRegen) {
      // Try cache first
      const cached = this.store.get(key);
      if (cached) return cached;

      // Dedup: if this chunk is already being loaded/generated, reuse that promise
      const existing = this.inFlight.get(key);
      if (existing) return existing;
    }

    // Create a single promise for loading + generating this chunk
    const promise = this.loadOrGenerate(cx, cy, cz, forceRegen);

    if (!forceRegen) {
      this.inFlight.set(key, promise);
      promise.finally(() => this.inFlight.delete(key));
    }

    return promise;
  }

  /**
   * Load from disk or generate a chunk. Uses async generator (worker pool)
   * when available, otherwise falls back to synchronous TerrainGenerator.
   */
  private async loadOrGenerate(cx: number, cy: number, cz: number, forceRegen: boolean): Promise<ChunkData> {
    const key = chunkKey(cx, cy, cz);

    // Try disk load first (unless force-regenerating)
    if (!forceRegen && this.store.getAsync) {
      const diskChunk = await this.store.getAsync(key);
      if (diskChunk) return diskChunk;
    }

    // Generate via worker pool or local generator
    const chunk = new ChunkData(cx, cy, cz);
    const generatedData = this.asyncGenerator
      ? await this.asyncGenerator(cx, cy, cz)
      : this.terrainGenerator.generateChunk(cx, cy, cz);
    chunk.data.set(generatedData);

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
