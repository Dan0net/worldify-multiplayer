/**
 * StorageManager - Lifecycle management for chunk storage
 * 
 * Single Responsibility: Manages initialization, flushing, and shutdown of storage.
 * Provides access to ChunkProvider and PersistentChunkStore instances.
 */

import { PersistentChunkStore } from './PersistentChunkStore.js';
import { WorldStorage } from './WorldStorage.js';
import { ChunkProvider } from '../voxel/ChunkProvider.js';

/** Global persistent chunk store (shared across all rooms) */
let globalChunkStore: PersistentChunkStore | null = null;

/** Global chunk provider (shared across all rooms - uses global store) */
let globalChunkProvider: ChunkProvider | null = null;

/**
 * Initialize the global chunk storage. Must be called before handling any builds.
 */
export async function initChunkStorage(): Promise<void> {
  const storage = WorldStorage.getInstance();
  await storage.open();
  
  globalChunkStore = new PersistentChunkStore(storage);
  globalChunkProvider = new ChunkProvider(globalChunkStore, storage.seed);
  
  console.log('[storage] Chunk storage initialized');
}

/**
 * Flush pending chunk changes to disk.
 */
export async function flushChunkStorage(): Promise<void> {
  if (globalChunkStore) {
    await globalChunkStore.flush();
  }
}

/**
 * Shutdown chunk storage gracefully.
 */
export async function shutdownChunkStorage(): Promise<void> {
  if (globalChunkStore) {
    await globalChunkStore.flush();
  }
  const storage = WorldStorage.getInstance();
  await storage.close();
  console.log('[storage] Chunk storage shutdown complete');
}

/**
 * Get the global ChunkProvider.
 * @throws Error if storage not initialized
 */
export function getChunkProvider(): ChunkProvider {
  if (!globalChunkProvider) {
    throw new Error('Chunk storage not initialized. Call initChunkStorage() first.');
  }
  return globalChunkProvider;
}

/**
 * Get the global PersistentChunkStore.
 * @throws Error if storage not initialized
 */
export function getChunkStore(): PersistentChunkStore {
  if (!globalChunkStore) {
    throw new Error('Chunk storage not initialized. Call initChunkStorage() first.');
  }
  return globalChunkStore;
}
