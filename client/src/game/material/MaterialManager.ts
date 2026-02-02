/**
 * MaterialManager - Orchestrates material loading and state
 * 
 * Integrates with the store to track loading progress and state.
 */

import { storeBridge } from '../../state/bridge.js';
import { 
  initializeMaterials,
  initializePlaceholderTextures,
  upgradeToHighRes, 
  isHighResCached 
} from './TerrainMaterial.js';
import { textureCache } from './TextureCache.js';

class MaterialManager {
  private initialized = false;
  private upgrading = false;

  /**
   * Initialize the material system.
   * Respects user preference: if user chose HD and it's cached, load HD.
   * If user chose low, load low. If no preference and HD cached, load HD.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Initialize placeholder textures from pallet colors immediately
    // This gives visual feedback while full textures load
    try {
      await initializePlaceholderTextures();
    } catch (error) {
      console.warn('Failed to initialize placeholder textures:', error);
    }

    const hdCached = await isHighResCached();
    const userPref = await textureCache.getUserPreference();
    
    // Decide which resolution to load:
    // - If user explicitly chose 'low', use low
    // - If user chose 'high' or no preference, use HD if cached
    const shouldLoadHD = userPref === 'high' || (userPref !== 'low' && hdCached);
    
    if (shouldLoadHD && hdCached) {
      storeBridge.setTextureState('loading-high');
      storeBridge.setTextureProgress(0);

      try {
        await initializeMaterials('high', (loaded, total) => {
          storeBridge.setTextureProgress(loaded / total);
        });

        storeBridge.setTextureState('high');
        storeBridge.setTextureProgress(1);
        this.initialized = true;

        console.log('Material system initialized with HD textures (user preference)');
        return;
      } catch (error) {
        console.warn('Failed to load HD textures, falling back to low-res:', error);
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
      
      // Save user preference
      await textureCache.setUserPreference('high');

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
   * Downgrade to low-resolution textures.
   * Call this when user wants to reduce memory usage.
   */
  async downgradeToLowResolution(): Promise<void> {
    if (this.upgrading) return;
    if (storeBridge.textureState === 'low' || storeBridge.textureState === 'loading-low') {
      return;
    }

    this.upgrading = true;
    storeBridge.setTextureState('loading-low');
    storeBridge.setTextureProgress(0);

    try {
      await initializeMaterials('low', (loaded, total) => {
        storeBridge.setTextureProgress(loaded / total);
      });

      storeBridge.setTextureState('low');
      storeBridge.setTextureProgress(1);
      
      // Save user preference
      await textureCache.setUserPreference('low');

      console.log('Downgraded to low-res textures');
    } catch (error) {
      console.error('Failed to downgrade to low-res textures:', error);
      // Keep high state if downgrade fails
      storeBridge.setTextureState('high');
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
