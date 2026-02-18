/**
 * Singleton accessor for the global MapTileCache instance.
 * Separated from UI components so both game code and UI can import it.
 */

import { MapTileCache } from './MapTileCache';

let instance: MapTileCache | null = null;

export function getMapTileCache(): MapTileCache {
  if (!instance) {
    instance = new MapTileCache();
  }
  return instance;
}
