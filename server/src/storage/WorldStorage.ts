/**
 * WorldStorage - LevelDB singleton for persistent world data
 * 
 * Single Responsibility: Manages LevelDB lifecycle and provides raw key-value access.
 * All chunk-specific logic is in PersistentChunkStore.
 */

import { Level } from 'level';
import path from 'node:path';
import fs from 'node:fs';

// Default data directory (relative to server working directory)
const DEFAULT_DATA_DIR = 'data';
const DB_NAME = 'world.db';

/**
 * World metadata stored in LevelDB
 */
export interface WorldMeta {
  seed: number;
  createdAt: number;
}

/**
 * Singleton class managing the LevelDB instance.
 */
export class WorldStorage {
  private static instance: WorldStorage | null = null;
  private db: Level<string, Buffer> | null = null;
  private readonly dbPath: string;
  private _seed: number = 12345;
  private _isOpen: boolean = false;

  private constructor(dataDir: string = DEFAULT_DATA_DIR) {
    this.dbPath = path.join(dataDir, DB_NAME);
  }

  /**
   * Get or create the singleton instance.
   */
  static getInstance(dataDir?: string): WorldStorage {
    if (!WorldStorage.instance) {
      WorldStorage.instance = new WorldStorage(dataDir);
    }
    return WorldStorage.instance;
  }

  /**
   * Reset singleton (for testing)
   */
  static resetInstance(): void {
    WorldStorage.instance = null;
  }

  /**
   * Open the database. Must be called before any operations.
   */
  async open(): Promise<void> {
    if (this._isOpen) return;

    // Ensure data directory exists
    const dataDir = path.dirname(this.dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    // Open LevelDB with binary values
    this.db = new Level(this.dbPath, {
      valueEncoding: 'buffer',
    });

    await this.db.open();
    this._isOpen = true;

    // Load or initialize world metadata
    await this.initializeMeta();

    console.log(`[storage] Opened world database at ${this.dbPath} (seed: ${this._seed})`);
  }

  /**
   * Close the database gracefully.
   */
  async close(): Promise<void> {
    if (!this._isOpen || !this.db) return;

    await this.db.close();
    this._isOpen = false;
    console.log('[storage] World database closed');
  }

  /**
   * Get the world seed.
   */
  get seed(): number {
    return this._seed;
  }

  /**
   * Check if database is open.
   */
  get isOpen(): boolean {
    return this._isOpen;
  }

  /**
   * Get a value by key.
   */
  async get(key: string): Promise<Buffer | undefined> {
    if (!this.db || !this._isOpen) {
      throw new Error('WorldStorage not open');
    }

    try {
      return await this.db.get(key);
    } catch (err: unknown) {
      // Key not found is expected, return undefined
      if ((err as { code?: string }).code === 'LEVEL_NOT_FOUND') {
        return undefined;
      }
      throw err;
    }
  }

  /**
   * Set a value by key.
   */
  async put(key: string, value: Buffer): Promise<void> {
    if (!this.db || !this._isOpen) {
      throw new Error('WorldStorage not open');
    }

    await this.db.put(key, value);
  }

  /**
   * Delete a key.
   */
  async delete(key: string): Promise<void> {
    if (!this.db || !this._isOpen) {
      throw new Error('WorldStorage not open');
    }

    try {
      await this.db.del(key);
    } catch (err: unknown) {
      // Ignore not found errors on delete
      if ((err as { code?: string }).code !== 'LEVEL_NOT_FOUND') {
        throw err;
      }
    }
  }

  /**
   * Batch write multiple key-value pairs.
   */
  async batch(ops: Array<{ type: 'put'; key: string; value: Buffer } | { type: 'del'; key: string }>): Promise<void> {
    if (!this.db || !this._isOpen) {
      throw new Error('WorldStorage not open');
    }

    const batch = this.db.batch();
    for (const op of ops) {
      if (op.type === 'put') {
        batch.put(op.key, op.value);
      } else {
        batch.del(op.key);
      }
    }
    await batch.write();
  }

  /**
   * Clear all data from the database. USE WITH CAUTION.
   * This will delete all chunks and world metadata.
   */
  async clear(): Promise<void> {
    if (!this.db || !this._isOpen) {
      throw new Error('WorldStorage not open');
    }

    console.log('[storage] Clearing all world data...');
    
    // Iterate and delete all keys
    const keysToDelete: string[] = [];
    for await (const key of this.db.keys()) {
      keysToDelete.push(key);
    }
    
    if (keysToDelete.length > 0) {
      const batch = this.db.batch();
      for (const key of keysToDelete) {
        batch.del(key);
      }
      await batch.write();
    }
    
    console.log(`[storage] Cleared ${keysToDelete.length} entries`);
    
    // Re-initialize with fresh metadata (new seed)
    this._seed = Math.floor(Math.random() * 2147483647);
    await this.initializeMeta();
  }

  /**
   * Initialize or load world metadata.
   */
  private async initializeMeta(): Promise<void> {
    const metaKey = 'meta:world';

    try {
      const metaBuffer = await this.get(metaKey);
      if (metaBuffer) {
        const meta: WorldMeta = JSON.parse(metaBuffer.toString('utf8'));
        this._seed = meta.seed;
        console.log(`[storage] Loaded existing world (created: ${new Date(meta.createdAt).toISOString()})`);
        return;
      }
    } catch {
      // Meta doesn't exist, create it
    }

    // Create new world metadata
    const meta: WorldMeta = {
      seed: this._seed,
      createdAt: Date.now(),
    };

    await this.put(metaKey, Buffer.from(JSON.stringify(meta), 'utf8'));
    console.log('[storage] Created new world');
  }
}
