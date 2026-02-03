import {
  Scene,
  EquirectangularReflectionMapping,
  Texture,
  LinearSRGBColorSpace,
} from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

let skyboxTexture: Texture | null = null;
let currentSkyboxName: string | null = null;
let cachedScene: Scene | null = null;

/** CDN for drei HDRI presets */
const HDRI_CDN = 'https://raw.githack.com/pmndrs/drei-assets/456060a26bbeb8fdf79326f224b6d99b8bcce736/hdri/';

/** Available skybox presets (from drei) */
export const SKYBOX_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'sunset', label: 'Sunset' },
  { value: 'dawn', label: 'Dawn' },
  { value: 'night', label: 'Night' },
  { value: 'forest', label: 'Forest' },
  { value: 'park', label: 'Park' },
  { value: 'city', label: 'City' },
  { value: 'apartment', label: 'Apartment' },
  { value: 'lobby', label: 'Lobby' },
  { value: 'studio', label: 'Studio' },
  { value: 'warehouse', label: 'Warehouse' },
] as const;

/** Preset name to HDR filename mapping */
const PRESET_FILES: Record<string, string> = {
  apartment: 'lebombo_1k.hdr',
  city: 'potsdamer_platz_1k.hdr',
  dawn: 'kiara_1_dawn_1k.hdr',
  forest: 'forest_slope_1k.hdr',
  lobby: 'st_fagans_interior_1k.hdr',
  night: 'dikhololo_night_1k.hdr',
  park: 'rooitou_park_1k.hdr',
  studio: 'studio_small_03_1k.hdr',
  sunset: 'venice_sunset_1k.hdr',
  warehouse: 'empty_warehouse_01_1k.hdr',
};

export type SkyboxName = typeof SKYBOX_OPTIONS[number]['value'];

/**
 * Loads and applies an equirectangular HDR skybox texture to the scene.
 * Sets both scene.background (visible sky) and scene.environment (IBL reflections).
 * Pass 'none' to disable skybox and environment map.
 */
export function setupSkybox(scene: Scene, skyboxName?: string, onLoaded?: () => void): void {
  const preset = skyboxName || 'sunset';
  cachedScene = scene;
  
  // Handle "none" - disable skybox and environment
  if (preset === 'none') {
    // Dispose previous texture
    if (skyboxTexture) {
      skyboxTexture.dispose();
      skyboxTexture = null;
    }
    
    scene.background = null;
    scene.environment = null;
    currentSkyboxName = 'none';
    console.log('Skybox disabled (none)');
    onLoaded?.();
    return;
  }
  
  // Skip if already loaded
  if (currentSkyboxName === preset && skyboxTexture) {
    onLoaded?.();
    return;
  }
  
  // Dispose previous texture
  if (skyboxTexture) {
    skyboxTexture.dispose();
    skyboxTexture = null;
  }
  
  const filename = PRESET_FILES[preset] || PRESET_FILES['sunset'];
  const url = `${HDRI_CDN}${filename}`;
  
  const loader = new RGBELoader();

  console.log(`Loading skybox: ${preset} (${url})`);
  
  loader.load(
    url,
    (texture) => {
      console.log(`Skybox loaded successfully: ${preset}`);
      texture.mapping = EquirectangularReflectionMapping;
      // HDR textures should use linear color space for proper IBL
      texture.colorSpace = LinearSRGBColorSpace;

      scene.background = texture;
      scene.environment = texture;
      // environmentIntensity is available in Three.js r155+ but types may lag
      (scene as unknown as { environmentIntensity: number }).environmentIntensity = 1.0;

      skyboxTexture = texture;
      currentSkyboxName = preset;
      onLoaded?.();
    },
    undefined,
    (error) => {
      console.error(`Failed to load skybox texture ${preset}:`, error);
    }
  );
}

/**
 * Change the skybox to a different preset.
 */
export function changeSkybox(skyboxName: string): void {
  if (cachedScene) {
    setupSkybox(cachedScene, skyboxName);
  } else {
    console.warn('changeSkybox: No cached scene available');
  }
}

/**
 * Dispose of the skybox texture to free GPU memory.
 */
export function disposeSkybox(): void {
  if (skyboxTexture) {
    skyboxTexture.dispose();
    skyboxTexture = null;
    currentSkyboxName = null;
  }
}
