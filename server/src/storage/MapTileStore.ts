/**
 * MapTileStore - LevelDB-backed map tile persistence
 * 
 * Single Responsibility: Persists map tiles to LevelDB with in-memory cache.
 * Follows the same pattern as PersistentChunkStore.
 */

import {
  MapTileData,
  mapTileKey,
  createMapTile,
  MAP_TILE_HEIGHT_BYTES,
  MAP_TILE_MATERIAL_BYTES,
} from '@worldify/shared';
import { WorldStorage } from './WorldStorage.js';

const TILE_KEY_PREFIX = 'tile:';

/**
 * Persistent storage for map tiles with write-through cache.
 */
export class MapTileStore {
  /** In-memory cache of tiles */
  private readonly cache = new Map<string, MapTileData>();
  
  /** Tiles that have been modified and need persistence */
  private readonly dirtyKeys = new Set<string>();
  
  /** Reference to world storage singleton */
  private readonly storage: WorldStorage;

  constructor(storage?: WorldStorage) {
    this.storage = storage ?? WorldStorage.getInstance();
  }

  /**
   * Get a tile from cache. Returns undefined if not cached.
   */
  get(tx: number, tz: number): MapTileData | undefined {
    return this.cache.get(mapTileKey(tx, tz));
  }

  /**
   * Store a tile in cache and mark for persistence.
   */
  set(tx: number, tz: number, tile: MapTileData): void {
    const key = mapTileKey(tx, tz);
    this.cache.set(key, tile);
    this.dirtyKeys.add(key);
  }

  /**
   * Mark a tile as dirty for persistence.
   */
  markDirty(tx: number, tz: number): void {
    const key = mapTileKey(tx, tz);
    if (this.cache.has(key)) {
      this.dirtyKeys.add(key);
    }
  }

  /**
   * Check if a tile is in cache.
   */
  has(tx: number, tz: number): boolean {
    return this.cache.has(mapTileKey(tx, tz));
  }

  /**
   * Get all cached tiles.
   */
  getAll(): Map<string, MapTileData> {
    return this.cache;
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this.cache.clear();
    this.dirtyKeys.clear();
  }

  /**
   * Flush all dirty tiles to disk.
   */
  async flush(): Promise<void> {
    if (this.dirtyKeys.size === 0) return;

    const ops: Array<{ type: 'put'; key: string; value: Buffer }> = [];

    for (const key of this.dirtyKeys) {
      const tile = this.cache.get(key);
      if (tile) {
        const buffer = this.serializeTile(tile);
        ops.push({
          type: 'put',
          key: TILE_KEY_PREFIX + key,
          value: buffer,
        });
      }
    }

    if (ops.length > 0) {
      await this.storage.batch(ops);
      console.log(`[storage] Flushed ${ops.length} map tiles to disk`);
    }

    this.dirtyKeys.clear();
  }

  /**
   * Get a tile, loading from disk if necessary.
   */
  async getAsync(tx: number, tz: number): Promise<MapTileData | undefined> {
    const key = mapTileKey(tx, tz);
    
    // Check cache first
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Load from disk
    const buffer = await this.storage.get(TILE_KEY_PREFIX + key);
    if (buffer) {
      const tile = this.deserializeTile(buffer);
      this.cache.set(key, tile);
      console.log(`[storage] Loaded map tile ${key} from disk`);
      return tile;
    }
    return undefined;
  }

  /**
   * Serialize a tile to a buffer.
   * Format: tx (int32) | tz (int32) | heights (int16[]) | materials (uint8[])
   */
  private serializeTile(tile: MapTileData): Buffer {
    // 8 bytes coords + 2048 heights + 1024 materials = 3080 bytes
    const buffer = Buffer.alloc(8 + MAP_TILE_HEIGHT_BYTES + MAP_TILE_MATERIAL_BYTES);

    buffer.writeInt32LE(tile.tx, 0);
    buffer.writeInt32LE(tile.tz, 4);

    // Copy height data (Int16Array → bytes)
    const heightBytes = new Uint8Array(
      tile.heights.buffer,
      tile.heights.byteOffset,
      tile.heights.byteLength
    );
    heightBytes.forEach((byte, i) => {
      buffer[8 + i] = byte;
    });

    // Copy material data
    tile.materials.forEach((byte, i) => {
      buffer[8 + MAP_TILE_HEIGHT_BYTES + i] = byte;
    });

    return buffer;
  }

  /**
   * Deserialize a buffer to a tile.
   */
  private deserializeTile(buffer: Buffer): MapTileData {
    const tx = buffer.readInt32LE(0);
    const tz = buffer.readInt32LE(4);

    const tile = createMapTile(tx, tz);

    // Copy height data
    const heightBytes = buffer.subarray(8, 8 + MAP_TILE_HEIGHT_BYTES);
    const uint8HeightView = new Uint8Array(
      tile.heights.buffer,
      tile.heights.byteOffset,
      tile.heights.byteLength
    );
    heightBytes.copy(uint8HeightView);

    // Copy material data
    const materialBytes = buffer.subarray(8 + MAP_TILE_HEIGHT_BYTES);
    materialBytes.copy(tile.materials);

    return tile;
  }

  /**
   * Get the number of dirty tiles.
   */
  get dirtyCount(): number {
    return this.dirtyKeys.size;
  }
}
