/**
 * MaterialManager - Orchestrates material loading and state
 * 
 * Integrates with the store to track loading progress and state.
 */

import { storeBridge } from '../../state/bridge.js';
import { 
  initializeMaterials, 
  upgradeToHighRes, 
  isHighResCached 
} from './TerrainMaterial.js';

class MaterialManager {
  private initialized = false;
  private upgrading = false;

  /**
   * Initialize the material system.
   * Loads HD textures if cached, otherwise loads low-res.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Check if HD is cached - if so, load it directly
    const hdCached = await isHighResCached();
    
    if (hdCached) {
      storeBridge.setTextureState('loading-high');
      storeBridge.setTextureProgress(0);

      try {
        await initializeMaterials('high', (loaded, total) => {
          storeBridge.setTextureProgress(loaded / total);
        });

        storeBridge.setTextureState('high');
        storeBridge.setTextureProgress(1);
        this.initialized = true;

        console.log('Material system initialized with cached HD textures');
        return;
      } catch (error) {
        console.warn('Failed to load cached HD textures, falling back to low-res:', error);
      }
    }

    // Load low-res textures
    storeBridge.setTextureState('loading-low');
    storeBridge.setTextureProgress(0);

    try {
      await initializeMaterials('low', (loaded, total) => {
        storeBridge.setTextureProgress(loaded / total);
      });

      storeBridge.setTextureState('low');
      storeBridge.setTextureProgress(1);
      this.initialized = true;

      console.log('Material system initialized with low-res textures');
    } catch (error) {
      console.error('Failed to initialize materials:', error);
      storeBridge.setTextureState('none');
    }
  }

  /**
   * Upgrade to high-resolution textures.
   * Call this when user opts in (e.g., from spectator screen).
   */
  async upgradeToHighResolution(): Promise<void> {
    if (this.upgrading) return;
    if (storeBridge.textureState === 'high' || storeBridge.textureState === 'loading-high') {
      return;
    }

    this.upgrading = true;
    storeBridge.setTextureState('loading-high');
    storeBridge.setTextureProgress(0);

    try {
      await upgradeToHighRes((loaded, total) => {
        storeBridge.setTextureProgress(loaded / total);
      });

      storeBridge.setTextureState('high');
      storeBridge.setTextureProgress(1);

      console.log('Upgraded to high-res textures');
    } catch (error) {
      console.error('Failed to upgrade to high-res textures:', error);
      // Revert to low state
      storeBridge.setTextureState('low');
    } finally {
      this.upgrading = false;
    }
  }

  /**
   * Check if high-resolution textures are available in cache.
   */
  async checkHighResAvailable(): Promise<boolean> {
    return isHighResCached();
  }

  /**
   * Get current loading state.
   */
  getState() {
    return {
      textureState: storeBridge.textureState,
      progress: storeBridge.textureProgress,
      isLoading: storeBridge.textureState === 'loading-low' || storeBridge.textureState === 'loading-high',
    };
  }
}

export const materialManager = new MaterialManager();
