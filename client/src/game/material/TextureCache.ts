/**
 * TextureCache - IndexedDB cache for material textures
 * 
 * Caches downloaded texture binaries to avoid re-downloading on subsequent visits.
 */

import { MATERIAL_ROOT_URL } from './constants.js';

const DB_NAME = 'worldify-texture-cache';
const TEXTURE_STORE = 'textures';
const META_STORE = 'metadata';
const DB_VERSION = 1;

interface TextureMetadata {
  size: number;
  timestamp: number;
  version: string;
}

interface LatestManifest {
  version: number;
  path: string;
}

// Cache the latest version to avoid repeated fetches
let cachedLatestVersion: string | null = null;
let latestVersionFetchPromise: Promise<string> | null = null;

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

  /**
   * Fetch the latest material version from R2.
   * Caches the result for the session to avoid repeated network requests.
   */
  async getLatestVersion(): Promise<string> {
    // Return cached version if available
    if (cachedLatestVersion) {
      return cachedLatestVersion;
    }

    // Deduplicate concurrent requests
    if (latestVersionFetchPromise) {
      return latestVersionFetchPromise;
    }

    latestVersionFetchPromise = (async () => {
      try {
        const url = `${MATERIAL_ROOT_URL}/latest.json`;
        console.log(`Fetching material version from: ${url}`);
        
        const response = await fetch(url, {
          cache: 'no-cache', // Always check for updates
        });

        if (!response.ok) {
          throw new Error(`Failed to fetch latest.json: ${response.status}`);
        }

        const manifest: LatestManifest = await response.json();
        cachedLatestVersion = `v${manifest.version}`;
        console.log(`Latest material version: ${cachedLatestVersion}`);
        return cachedLatestVersion;
      } catch (error) {
        console.warn('Failed to fetch latest version, using fallback:', error);
        // Fallback to cached version or default
        const cached = await this.getCacheVersion();
        cachedLatestVersion = cached || 'v3';
        return cachedLatestVersion;
      } finally {
        latestVersionFetchPromise = null;
      }
    })();

    return latestVersionFetchPromise;
  }

  /**
   * Get the URL for material binaries at the latest version.
   */
  async getLatestMaterialUrl(): Promise<string> {
    const version = await this.getLatestVersion();
    return `${MATERIAL_ROOT_URL}/${version}`;
  }

  async getTexture(resolution: string, mapType: string, requiredVersion?: string): Promise<ArrayBuffer | null> {
    try {
      const db = await this.openDB();
      const key = `${resolution}/${mapType}`;
      
      // Check if cached version matches required version
      if (requiredVersion) {
        const meta = await this.getMetadata();
        const entryMeta = meta?.[key];
        if (entryMeta && entryMeta.version !== requiredVersion) {
          console.log(`Cache version mismatch for ${key}: cached=${entryMeta.version}, required=${requiredVersion}`);
          return null; // Force re-download
        }
      }
      
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

  /**
   * Get the user's preferred texture resolution.
   * Returns 'high' if user explicitly enabled HD, 'low' if disabled, null if no preference.
   */
  async getUserPreference(): Promise<'low' | 'high' | null> {
    try {
      const db = await this.openDB();
      
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(META_STORE, 'readonly');
        const store = transaction.objectStore(META_STORE);
        const request = store.get('userPreference');
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result || null);
      });
    } catch (error) {
      console.error('Error fetching user preference:', error);
      return null;
    }
  }

  /**
   * Save the user's preferred texture resolution.
   */
  async setUserPreference(preference: 'low' | 'high'): Promise<void> {
    try {
      const db = await this.openDB();
      
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(META_STORE, 'readwrite');
        const store = transaction.objectStore(META_STORE);
        const request = store.put(preference, 'userPreference');
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve();
      });
    } catch (error) {
      console.error('Error saving user preference:', error);
    }
  }
}

export const textureCache = new TextureCache();
