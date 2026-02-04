/**
 * StorageManager - Lifecycle management for chunk storage
 * 
 * Single Responsibility: Manages initialization, flushing, and shutdown of storage.
 * Provides access to ChunkProvider and PersistentChunkStore instances.
 */

import { PersistentChunkStore } from './PersistentChunkStore.js';
import { MapTileStore } from './MapTileStore.js';
import { WorldStorage } from './WorldStorage.js';
import { ChunkProvider } from '../voxel/ChunkProvider.js';
import { MapTileProvider } from '../voxel/MapTileProvider.js';
import { TerrainGenerator } from '@worldify/shared';

/** Global persistent chunk store (shared across all rooms) */
let globalChunkStore: PersistentChunkStore | null = null;

/** Global chunk provider (shared across all rooms - uses global store) */
let globalChunkProvider: ChunkProvider | null = null;

/** Global map tile store */
let globalMapTileStore: MapTileStore | null = null;

/** Global map tile provider */
let globalMapTileProvider: MapTileProvider | null = null;

/** Global terrain generator (shared for map tile generation) */
let globalTerrainGenerator: TerrainGenerator | null = null;

/**
 * Initialize the global chunk storage. Must be called before handling any builds.
 */
export async function initChunkStorage(): Promise<void> {
  const storage = WorldStorage.getInstance();
  await storage.open();
  
  globalChunkStore = new PersistentChunkStore(storage);
  globalChunkProvider = new ChunkProvider(globalChunkStore, storage.seed);
  
  // Initialize map tile system
  globalTerrainGenerator = new TerrainGenerator({ seed: storage.seed });
  globalMapTileStore = new MapTileStore(storage);
  globalMapTileProvider = new MapTileProvider(
    globalMapTileStore,
    globalTerrainGenerator
  );
  
  console.log('[storage] Chunk and map tile storage initialized');
}

/**
 * Flush pending chunk changes to disk.
 */
export async function flushChunkStorage(): Promise<void> {
  if (globalChunkStore) {
    await globalChunkStore.flush();
  }
  if (globalMapTileStore) {
    await globalMapTileStore.flush();
  }
}

/**
 * Shutdown chunk storage gracefully.
 */
export async function shutdownChunkStorage(): Promise<void> {
  if (globalChunkStore) {
    await globalChunkStore.flush();
  }
  if (globalMapTileStore) {
    await globalMapTileStore.flush();
  }
  const storage = WorldStorage.getInstance();
  await storage.close();
  console.log('[storage] Chunk storage shutdown complete');
}

/**
 * Clear all chunk storage data. USE WITH CAUTION.
 * This will delete all persisted chunks and regenerate with a new seed.
 */
export async function clearChunkStorage(): Promise<void> {
  const storage = WorldStorage.getInstance();
  
  // Clear the database
  await storage.clear();
  
  // Clear in-memory caches
  if (globalChunkStore) {
    globalChunkStore.clearCache();
  }
  if (globalMapTileStore) {
    globalMapTileStore.clearCache();
  }
  
  // Reinitialize providers with new seed
  globalTerrainGenerator = new TerrainGenerator({ seed: storage.seed });
  if (globalChunkStore) {
    globalChunkProvider = new ChunkProvider(globalChunkStore, storage.seed);
  }
  if (globalMapTileStore && globalTerrainGenerator) {
    globalMapTileProvider = new MapTileProvider(
      globalMapTileStore,
      globalTerrainGenerator
    );
  }
  
  console.log('[storage] Chunk storage cleared and reinitialized');
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
 * Get the global MapTileProvider.
 * @throws Error if storage not initialized
 */
export function getMapTileProvider(): MapTileProvider {
  if (!globalMapTileProvider) {
    throw new Error('Chunk storage not initialized. Call initChunkStorage() first.');
  }
  return globalMapTileProvider;
}

/**
 * Set the ChunkProvider for testing purposes.
 * This allows tests to inject a mock or simple ChunkProvider without full storage initialization.
 * @internal Only for use in tests
 */
export function setChunkProviderForTesting(provider: ChunkProvider | null): void {
  globalChunkProvider = provider;
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
