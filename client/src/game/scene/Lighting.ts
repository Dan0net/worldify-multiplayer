/**
 * Lighting System
 * 
 * Static lighting setup matching MaterialPreview/PreviewScene.
 * Uses store values for all settings to allow runtime adjustments.
 * 
 * Replaces the old TimeOfDay system with a simpler, predictable setup.
 */

import * as THREE from 'three';
import { getScene } from './scene';
import { setTerrainEnvMapIntensity } from '../material/TerrainMaterial';
import { useGameStore, EnvironmentSettings } from '../../state/store';

// ============== Internal State ==============

let sunLight: THREE.DirectionalLight | null = null;
let ambientLight: THREE.AmbientLight | null = null;
let renderer: THREE.WebGLRenderer | null = null;

// Static sun position matching MaterialPreview: [5, 5, 5] normalized and scaled
const SUN_POSITION = new THREE.Vector3(5, 5, 5).normalize().multiplyScalar(150);

// ============== Initialization ==============

/**
 * Initialize the lighting system.
 * Creates static ambient + directional lights matching MaterialPreview.
 */
export function initLighting(webglRenderer: THREE.WebGLRenderer): void {
  const scene = getScene();
  if (!scene) {
    console.error('[Lighting] Scene not initialized');
    return;
  }
  
  renderer = webglRenderer;
  
  // Get initial settings from store
  const settings = useGameStore.getState().environment;
  
  // Ambient light - static, matching PreviewScene
  ambientLight = new THREE.AmbientLight(
    settings.ambientColor,
    settings.ambientIntensity
  );
  scene.add(ambientLight);
  
  // Sun (directional light) - static position matching PreviewScene [5, 5, 5]
  sunLight = new THREE.DirectionalLight(
    settings.sunColor,
    settings.sunIntensity
  );
  sunLight.position.copy(SUN_POSITION);
  sunLight.castShadow = true;
  configureShadowCamera(sunLight, settings);
  scene.add(sunLight);
  scene.add(sunLight.target);
  
  // Apply environment intensity to scene
  applyEnvironmentIntensity(settings.environmentIntensity);
  
  // Apply tone mapping settings
  if (renderer) {
    renderer.toneMapping = settings.toneMapping;
    renderer.toneMappingExposure = settings.toneMappingExposure;
  }
  
  console.log('[Lighting] Initialized with static lighting');
}

function configureShadowCamera(light: THREE.DirectionalLight, settings: EnvironmentSettings): void {
  light.shadow.mapSize.width = settings.shadowMapSize;
  light.shadow.mapSize.height = settings.shadowMapSize;
  light.shadow.camera.left = -100;
  light.shadow.camera.right = 100;
  light.shadow.camera.top = 100;
  light.shadow.camera.bottom = -100;
  light.shadow.camera.near = 0.5;
  light.shadow.camera.far = 500;
  light.shadow.bias = settings.shadowBias;
  light.shadow.normalBias = settings.shadowNormalBias;
}

// ============== Environment Intensity ==============

/**
 * Apply environment intensity to scene and terrain materials.
 */
function applyEnvironmentIntensity(intensity: number): void {
  const scene = getScene();
  if (scene) {
    (scene as unknown as { environmentIntensity: number }).environmentIntensity = intensity;
    (scene as unknown as { backgroundIntensity: number }).backgroundIntensity = intensity;
    setTerrainEnvMapIntensity(intensity);
  }
}

// ============== Settings Application ==============

/**
 * Apply environment settings from store.
 * Call when settings change from UI.
 */
export function applyEnvironmentSettings(settings: Partial<EnvironmentSettings>): void {
  // Update sun light
  if (sunLight) {
    if (settings.sunColor !== undefined) {
      sunLight.color.set(settings.sunColor);
    }
    if (settings.sunIntensity !== undefined) {
      sunLight.intensity = settings.sunIntensity;
    }
    if (settings.shadowBias !== undefined) {
      sunLight.shadow.bias = settings.shadowBias;
    }
    if (settings.shadowNormalBias !== undefined) {
      sunLight.shadow.normalBias = settings.shadowNormalBias;
    }
    if (settings.shadowMapSize !== undefined && sunLight.shadow.mapSize.width !== settings.shadowMapSize) {
      sunLight.shadow.mapSize.width = settings.shadowMapSize;
      sunLight.shadow.mapSize.height = settings.shadowMapSize;
      sunLight.shadow.map?.dispose();
      sunLight.shadow.map = null;
    }
  }
  
  // Update ambient light
  if (ambientLight) {
    if (settings.ambientColor !== undefined) {
      ambientLight.color.set(settings.ambientColor);
    }
    if (settings.ambientIntensity !== undefined) {
      ambientLight.intensity = settings.ambientIntensity;
    }
  }
  
  // Update environment intensity
  if (settings.environmentIntensity !== undefined) {
    applyEnvironmentIntensity(settings.environmentIntensity);
  }
  
  // Update renderer tone mapping
  if (renderer) {
    if (settings.toneMapping !== undefined) {
      renderer.toneMapping = settings.toneMapping;
    }
    if (settings.toneMappingExposure !== undefined) {
      renderer.toneMappingExposure = settings.toneMappingExposure;
    }
  }
}

/**
 * Get the sun light for external use (e.g., shadow camera helper).
 */
export function getSunLight(): THREE.DirectionalLight | null {
  return sunLight;
}

/**
 * Dispose of lighting resources.
 */
export function disposeLighting(): void {
  const scene = getScene();
  
  if (ambientLight && scene) {
    scene.remove(ambientLight);
    ambientLight = null;
  }
  
  if (sunLight && scene) {
    scene.remove(sunLight);
    scene.remove(sunLight.target);
    sunLight.shadow.map?.dispose();
    sunLight = null;
  }
  
  renderer = null;
}

// ============== UI Helpers ==============

/**
 * Map for tone mapping types (for UI dropdowns).
 */
export const TONE_MAPPING_OPTIONS: { label: string; value: THREE.ToneMapping }[] = [
  { label: 'None', value: THREE.NoToneMapping },
  { label: 'Linear', value: THREE.LinearToneMapping },
  { label: 'Reinhard', value: THREE.ReinhardToneMapping },
  { label: 'Cineon', value: THREE.CineonToneMapping },
  { label: 'ACES Filmic', value: THREE.ACESFilmicToneMapping },
  { label: 'AgX', value: THREE.AgXToneMapping },
];

/**
 * Format time value (0-1) as HH:MM string.
 * Kept for UI compatibility even though time is no longer dynamic.
 */
export function formatTimeOfDay(time: number): string {
  const hours = Math.floor(time * 24);
  const minutes = Math.floor((time * 24 - hours) * 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}
