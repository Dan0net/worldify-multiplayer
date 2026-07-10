/**
 * MaterialManager - Orchestrates material loading and state
 * 
 * Integrates with the store to track loading progress and state.
 */

import { useGameStore } from '../../state/store.js';
import {
  initializeMaterials,
  initializePlaceholderTextures,
  upgradeToHighRes,
  isHighResCached,
  applyMaterialSettings
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
    // This gives visual feedback while full textures load (sync - embedded pallet)
    try {
      initializePlaceholderTextures();
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
      useGameStore.getState().setTextureState('loading-high');
      useGameStore.getState().setTextureProgress(0);

      try {
        await initializeMaterials('high', (loaded, total) => {
          useGameStore.getState().setTextureProgress(loaded / total);
        });

        useGameStore.getState().setTextureState('high');
        useGameStore.getState().setTextureProgress(1);
        this.initialized = true;
        
        // Apply material settings from store to shaders
        applyMaterialSettings(useGameStore.getState().materialSettings);

        console.log('Material system initialized with HD textures (user preference)');
        return;
      } catch (error) {
        console.warn('Failed to load HD textures, falling back to low-res:', error);
      }
    }

    // Load low-res textures
    useGameStore.getState().setTextureState('loading-low');
    useGameStore.getState().setTextureProgress(0);

    try {
      await initializeMaterials('low', (loaded, total) => {
        useGameStore.getState().setTextureProgress(loaded / total);
      });

      useGameStore.getState().setTextureState('low');
      useGameStore.getState().setTextureProgress(1);
      this.initialized = true;
      
      // Apply material settings from store to shaders
      applyMaterialSettings(useGameStore.getState().materialSettings);

      console.log('Material system initialized with low-res textures');
    } catch (error) {
      console.error('Failed to initialize materials:', error);
      useGameStore.getState().setTextureState('none');
    }
  }

  /**
   * Upgrade to high-resolution textures.
   * Call this when user opts in (e.g., from spectator screen).
   */
  async upgradeToHighResolution(): Promise<void> {
    if (this.upgrading) return;
    if (useGameStore.getState().textureState === 'high' || useGameStore.getState().textureState === 'loading-high') {
      return;
    }

    this.upgrading = true;
    useGameStore.getState().setTextureState('loading-high');
    useGameStore.getState().setTextureProgress(0);

    try {
      await upgradeToHighRes((loaded, total) => {
        useGameStore.getState().setTextureProgress(loaded / total);
      });

      useGameStore.getState().setTextureState('high');
      useGameStore.getState().setTextureProgress(1);
      
      // Apply material settings from store to shaders
      applyMaterialSettings(useGameStore.getState().materialSettings);
      
      // Save user preference
      await textureCache.setUserPreference('high');

      console.log('Upgraded to high-res textures');
    } catch (error) {
      console.error('Failed to upgrade to high-res textures:', error);
      // Revert to low state
      useGameStore.getState().setTextureState('low');
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
    if (useGameStore.getState().textureState === 'low' || useGameStore.getState().textureState === 'loading-low') {
      return;
    }

    this.upgrading = true;
    useGameStore.getState().setTextureState('loading-low');
    useGameStore.getState().setTextureProgress(0);

    try {
      await initializeMaterials('low', (loaded, total) => {
        useGameStore.getState().setTextureProgress(loaded / total);
      });

      useGameStore.getState().setTextureState('low');
      useGameStore.getState().setTextureProgress(1);
      
      // Apply material settings from store to shaders
      applyMaterialSettings(useGameStore.getState().materialSettings);
      
      // Save user preference
      await textureCache.setUserPreference('low');

      console.log('Downgraded to low-res textures');
    } catch (error) {
      console.error('Failed to downgrade to low-res textures:', error);
      // Keep high state if downgrade fails
      useGameStore.getState().setTextureState('high');
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
      textureState: useGameStore.getState().textureState,
      progress: useGameStore.getState().textureProgress,
      isLoading: useGameStore.getState().textureState === 'loading-low' || useGameStore.getState().textureState === 'loading-high',
    };
  }
}

export const materialManager = new MaterialManager();
