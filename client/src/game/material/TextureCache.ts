/**
 * TextureCache - IndexedDB cache for material textures
 * 
 * Caches downloaded texture binaries to avoid re-downloading on subsequent visits.
 */

const DB_NAME = 'worldify-texture-cache';
const TEXTURE_STORE = 'textures';
const META_STORE = 'metadata';
const DB_VERSION = 1;

interface TextureMetadata {
  size: number;
  timestamp: number;
  version: string;
}

class TextureCache {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private openDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(TEXTURE_STORE)) {
          db.createObjectStore(TEXTURE_STORE);
        }
        if (!db.objectStoreNames.contains(META_STORE)) {
          db.createObjectStore(META_STORE);
        }
      };
    });

    return this.dbPromise;
  }

  async getTexture(resolution: string, mapType: string): Promise<ArrayBuffer | null> {
    try {
      const db = await this.openDB();
      const key = `${resolution}/${mapType}`;
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(TEXTURE_STORE, 'readonly');
        const store = transaction.objectStore(TEXTURE_STORE);
        const request = store.get(key);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result || null);
      });
    } catch (error) {
      console.error('Error fetching texture from cache:', error);
      return null;
    }
  }

  async saveTexture(resolution: string, mapType: string, data: ArrayBuffer, version: string): Promise<void> {
    try {
      const db = await this.openDB();
      const key = `${resolution}/${mapType}`;
      
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(TEXTURE_STORE, 'readwrite');
        const store = transaction.objectStore(TEXTURE_STORE);
        const request = store.put(data, key);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });

      // Update metadata
      const meta = await this.getMetadata() || {};
      meta[key] = {
        size: data.byteLength,
        timestamp: Date.now(),
        version,
      };
      
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(META_STORE, 'readwrite');
        const store = transaction.objectStore(META_STORE);
        const request = store.put(meta, 'textureInfo');
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error('Error saving texture to cache:', error);
    }
  }

  async getMetadata(): Promise<Record<string, TextureMetadata> | null> {
    try {
      const db = await this.openDB();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(META_STORE, 'readonly');
        const store = transaction.objectStore(META_STORE);
        const request = store.get('textureInfo');
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result || null);
      });
    } catch (error) {
      console.error('Error fetching metadata:', error);
      return null;
    }
  }

  async getCacheVersion(): Promise<string | null> {
    try {
      const meta = await this.getMetadata();
      if (!meta) return null;
      
      // Get version from any cached texture
      const firstEntry = Object.values(meta)[0];
      return firstEntry?.version || null;
    } catch {
      return null;
    }
  }

  async clearCache(): Promise<void> {
    try {
      const db = await this.openDB();
      
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(TEXTURE_STORE, 'readwrite');
          const store = transaction.objectStore(TEXTURE_STORE);
          const request = store.clear();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve();
        }),
        new Promise<void>((resolve, reject) => {
          const transaction = db.transaction(META_STORE, 'readwrite');
          const store = transaction.objectStore(META_STORE);
          const request = store.clear();
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve();
        }),
      ]);
      
      console.log('Texture cache cleared');
    } catch (error) {
      console.error('Error clearing cache:', error);
    }
  }

  async getCacheSize(): Promise<number> {
    try {
      const meta = await this.getMetadata() || {};
      return Object.values(meta).reduce((total, entry) => total + entry.size, 0);
    } catch (error) {
      console.error('Error calculating cache size:', error);
      return 0;
    }
  }

  async hasResolution(resolution: string): Promise<boolean> {
    try {
      const meta = await this.getMetadata();
      if (!meta) return false;
      
      // Check if we have all required textures for this resolution
      const requiredMaps = ['albedo', 'normal', 'ao', 'roughness'];
      return requiredMaps.every(map => meta[`${resolution}/${map}`]);
    } catch {
      return false;
    }
  }
}

export const textureCache = new TextureCache();
