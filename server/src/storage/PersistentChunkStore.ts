/**
 * PersistentChunkStore - LevelDB-backed ChunkStore implementation
 * 
 * Single Responsibility: Persists chunks to LevelDB, delegates raw I/O to WorldStorage.
 * Implements ChunkStore interface for use with ChunkProvider.
 * 
 * Note: This uses synchronous-style API wrapping async LevelDB calls.
 * The ChunkStore interface is sync, so we cache chunks in memory and
 * persist asynchronously in the background.
 */

import { ChunkData, VOXELS_PER_CHUNK } from '@worldify/shared';
import { ChunkStore } from '../voxel/ChunkProvider.js';
import { WorldStorage } from './WorldStorage.js';

const CHUNK_KEY_PREFIX = 'chunk:';

/**
 * A ChunkStore that persists to LevelDB while maintaining an in-memory cache.
 * 
 * Write-through cache: writes go to memory immediately, then async to disk.
 * Reads check memory first, then disk (with async load).
 */
export class PersistentChunkStore implements ChunkStore {
  /** In-memory cache of chunks */
  private readonly cache = new Map<string, ChunkData>();
  
  /** Chunks that have been modified and need to be persisted */
  private readonly dirtyKeys = new Set<string>();
  
  /** Reference to the world storage singleton */
  private readonly storage: WorldStorage;
  
  /** Whether initial load from disk has completed (reserved for future use) */
  // @ts-expect-error Reserved for future async loading
  private _ready = false;
  
  /** Keys that are currently being loaded from disk */
  private readonly loadingKeys = new Set<string>();
  
  /** Callbacks waiting for a key to load */
  private readonly loadCallbacks = new Map<string, Array<(chunk: ChunkData | undefined) => void>>();

  constructor(storage?: WorldStorage) {
    this.storage = storage ?? WorldStorage.getInstance();
  }

  /**
   * Get a chunk from cache. Returns undefined if not in cache.
   * Triggers async load from disk if not cached.
   */
  get(key: string): ChunkData | undefined {
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Trigger async load if not already loading
    if (!this.loadingKeys.has(key)) {
      this.loadFromDisk(key);
    }

    return undefined;
  }

  /**
   * Store a chunk in cache and mark for persistence.
   */
  set(key: string, chunk: ChunkData): void {
    this.cache.set(key, chunk);
    this.dirtyKeys.add(key);
  }

  /**
   * Mark a chunk as dirty (modified) for persistence.
   * Call this after modifying chunk data in-place.
   */
  markDirty(key: string): void {
    if (this.cache.has(key)) {
      this.dirtyKeys.add(key);
    }
  }

  /**
   * Check if a chunk is in cache.
   */
  has(key: string): boolean {
    return this.cache.has(key);
  }

  /**
   * Get all cached chunks.
   */
  getAll(): Map<string, ChunkData> {
    return this.cache;
  }

  /**
   * Clear the cache (does not delete from disk).
   */
  clearCache(): void {
    this.cache.clear();
    this.dirtyKeys.clear();
  }

  /**
   * Flush all dirty chunks to disk.
   */
  async flush(): Promise<void> {
    if (this.dirtyKeys.size === 0) return;

    const ops: Array<{ type: 'put'; key: string; value: Buffer }> = [];

    for (const key of this.dirtyKeys) {
      const chunk = this.cache.get(key);
      if (chunk) {
        const buffer = this.serializeChunk(chunk);
        ops.push({
          type: 'put',
          key: CHUNK_KEY_PREFIX + key,
          value: buffer,
        });
      }
    }

    if (ops.length > 0) {
      await this.storage.batch(ops);
      console.log(`[storage] Flushed ${ops.length} chunks to disk`);
    }

    this.dirtyKeys.clear();
  }

  /**
   * Load a specific chunk from disk (async).
   */
  private async loadFromDisk(key: string): Promise<void> {
    this.loadingKeys.add(key);

    try {
      const buffer = await this.storage.get(CHUNK_KEY_PREFIX + key);
      let chunk: ChunkData | undefined;

      if (buffer) {
        chunk = this.deserializeChunk(buffer, key);
        this.cache.set(key, chunk);
      }

      // Notify any waiting callbacks
      const callbacks = this.loadCallbacks.get(key);
      if (callbacks) {
        for (const cb of callbacks) {
          cb(chunk);
        }
        this.loadCallbacks.delete(key);
      }
    } finally {
      this.loadingKeys.delete(key);
    }
  }

  /**
   * Get a chunk, waiting for disk load if necessary.
   */
  async getAsync(key: string): Promise<ChunkData | undefined> {
    // Check cache first
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Check if already loading
    if (this.loadingKeys.has(key)) {
      return new Promise((resolve) => {
        const callbacks = this.loadCallbacks.get(key) ?? [];
        callbacks.push(resolve);
        this.loadCallbacks.set(key, callbacks);
      });
    }

    // Load from disk
    this.loadingKeys.add(key);

    try {
      const buffer = await this.storage.get(CHUNK_KEY_PREFIX + key);
      if (buffer) {
        const chunk = this.deserializeChunk(buffer, key);
        this.cache.set(key, chunk);
        console.log(`[storage] Loaded chunk ${key} from disk`);
        return chunk;
      }
      return undefined;
    } finally {
      this.loadingKeys.delete(key);
    }
  }

  /**
   * Serialize a chunk to a buffer.
   * Format: cx (int32) | cy (int32) | cz (int32) | data (Uint16Array as bytes)
   */
  private serializeChunk(chunk: ChunkData): Buffer {
    // 12 bytes for coords + 2 bytes per voxel
    const buffer = Buffer.alloc(12 + VOXELS_PER_CHUNK * 2);

    buffer.writeInt32LE(chunk.cx, 0);
    buffer.writeInt32LE(chunk.cy, 4);
    buffer.writeInt32LE(chunk.cz, 8);

    // Copy voxel data
    const voxelBytes = new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    voxelBytes.forEach((byte, i) => {
      buffer[12 + i] = byte;
    });

    return buffer;
  }

  /**
   * Deserialize a buffer to a chunk.
   */
  private deserializeChunk(buffer: Buffer, _key: string): ChunkData {
    const cx = buffer.readInt32LE(0);
    const cy = buffer.readInt32LE(4);
    const cz = buffer.readInt32LE(8);

    const chunk = new ChunkData(cx, cy, cz);

    // Copy voxel data
    const voxelBytes = buffer.subarray(12);
    const uint8View = new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength);
    voxelBytes.copy(uint8View);

    return chunk;
  }

  /**
   * Get the number of dirty (unsaved) chunks.
   */
  get dirtyCount(): number {
    return this.dirtyKeys.size;
  }

  /**
   * Get the world seed from storage.
   */
  get seed(): number {
    return this.storage.seed;
  }
}
