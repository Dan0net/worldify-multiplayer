/**
 * Lighting System
 * 
 * Manages sun, moon, hemisphere lights, and procedural sky dome.
 * Uses store values for all settings to allow runtime adjustments.
 * 
 * Sun and moon positions can be set via azimuth/elevation angles,
 * calculated automatically by DayNightCycle.ts or set manually.
 */

import * as THREE from 'three';
import { getScene } from './scene';
import { setTerrainEnvMapIntensity } from '../material/TerrainMaterial';
import { useGameStore, EnvironmentSettings } from '../../state/store';
import { initSkyDome, updateSkyUniforms, disposeSkyDome } from './SkyDome';

// ============== Internal State ==============

let sunLight: THREE.DirectionalLight | null = null;
let moonLight: THREE.DirectionalLight | null = null;
let hemisphereLight: THREE.HemisphereLight | null = null;
let renderer: THREE.WebGLRenderer | null = null;

// ============== Position Calculation ==============

/**
 * Convert azimuth/elevation angles to 3D position.
 * @param azimuth - Horizontal angle in degrees (0 = North, 90 = East, 180 = South, 270 = West)
 * @param elevation - Vertical angle in degrees (0 = horizon, 90 = zenith, -90 = nadir)
 * @param distance - Distance from origin
 */
function anglesToPosition(azimuth: number, elevation: number, distance: number): THREE.Vector3 {
  const azRad = (azimuth * Math.PI) / 180;
  const elRad = (elevation * Math.PI) / 180;
  
  const cosEl = Math.cos(elRad);
  
  return new THREE.Vector3(
    Math.sin(azRad) * cosEl * distance,
    Math.sin(elRad) * distance,
    Math.cos(azRad) * cosEl * distance
  );
}

// ============== Initialization ==============

/**
 * Initialize the lighting system.
 * Creates sun, moon, and hemisphere lights with initial values from store.
 * Hemisphere light replaces ambient for more natural outdoor lighting.
 */
export function initLighting(webglRenderer: THREE.WebGLRenderer): void {
  const scene = getScene();
  if (!scene) {
    console.error('[Lighting] Scene not initialized');
    return;
  }
  
  renderer = webglRenderer;
  
  // Get initial settings from store with fallback defaults
  const settings = useGameStore.getState().environment;
  
  // Sun (primary directional light)
  sunLight = new THREE.DirectionalLight(
    settings.sunColor ?? '#ffcc00',
    settings.sunIntensity ?? 3.0
  );
  const sunPos = anglesToPosition(
    settings.sunAzimuth ?? 135,
    settings.sunElevation ?? 45,
    settings.sunDistance ?? 150
  );
  sunLight.position.copy(sunPos);
  sunLight.castShadow = true;
  configureShadowCamera(sunLight, settings);
  scene.add(sunLight);
  scene.add(sunLight.target);
  
  // Moon (secondary directional light, casts shadows at night)
  moonLight = new THREE.DirectionalLight(
    settings.moonColor ?? '#8899bb',
    settings.moonIntensity ?? 0.3
  );
  const moonPos = anglesToPosition(
    settings.moonAzimuth ?? 315,
    settings.moonElevation ?? -45,
    settings.sunDistance ?? 150
  );
  moonLight.position.copy(moonPos);
  moonLight.castShadow = true;
  configureShadowCamera(moonLight, settings);
  scene.add(moonLight);
  scene.add(moonLight.target);
  
  // Hemisphere light (sky/ground gradient for natural outdoor lighting)
  if (settings.hemisphereEnabled ?? true) {
    hemisphereLight = new THREE.HemisphereLight(
      settings.hemisphereSkyColor ?? '#87ceeb',
      settings.hemisphereGroundColor ?? '#3d5c3d',
      settings.hemisphereIntensity ?? 1.0
    );
    scene.add(hemisphereLight);
  }
  
  // Initialize procedural sky dome (matches hemisphere/sun/moon colors)
  initSkyDome();
  
  // Apply environment intensity to scene
  applyEnvironmentIntensity(settings.environmentIntensity ?? 0.5);
  
  // Apply tone mapping settings
  if (renderer) {
    renderer.toneMapping = settings.toneMapping ?? THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = settings.toneMappingExposure ?? 1.0;
  }
  
  console.log('[Lighting] Initialized with sun + moon + hemisphere + procedural sky');
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
 * Call when settings change from UI or DayNightCycle controller.
 */
export function applyEnvironmentSettings(settings: Partial<EnvironmentSettings>): void {
  // Get full current settings for position calculations
  const currentSettings = useGameStore.getState().environment;
  
  // Update sun light
  if (sunLight) {
    if (settings.sunColor !== undefined) {
      sunLight.color.set(settings.sunColor);
    }
    if (settings.sunIntensity !== undefined) {
      sunLight.intensity = settings.sunIntensity;
    }
    
    // Update sun position if azimuth or elevation changed
    if (settings.sunAzimuth !== undefined || settings.sunElevation !== undefined || settings.sunDistance !== undefined) {
      const azimuth = settings.sunAzimuth ?? currentSettings.sunAzimuth ?? 135;
      const elevation = settings.sunElevation ?? currentSettings.sunElevation ?? 45;
      const distance = settings.sunDistance ?? currentSettings.sunDistance ?? 150;
      const pos = anglesToPosition(azimuth, elevation, distance);
      sunLight.position.copy(pos);
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
  
  // Update moon light
  if (moonLight) {
    if (settings.moonColor !== undefined) {
      moonLight.color.set(settings.moonColor);
    }
    if (settings.moonIntensity !== undefined) {
      moonLight.intensity = settings.moonIntensity;
    }
    
    // Update moon position if azimuth or elevation changed
    if (settings.moonAzimuth !== undefined || settings.moonElevation !== undefined || settings.sunDistance !== undefined) {
      const azimuth = settings.moonAzimuth ?? currentSettings.moonAzimuth ?? 315;
      const elevation = settings.moonElevation ?? currentSettings.moonElevation ?? -45;
      const distance = settings.sunDistance ?? currentSettings.sunDistance ?? 150; // Use sun distance for consistency
      const pos = anglesToPosition(azimuth, elevation, distance);
      moonLight.position.copy(pos);
    }
  }
  
  // Update hemisphere light (replaces ambient for natural outdoor lighting)
  if (hemisphereLight) {
    if (settings.hemisphereSkyColor !== undefined) {
      hemisphereLight.color.set(settings.hemisphereSkyColor);
    }
    if (settings.hemisphereGroundColor !== undefined) {
      hemisphereLight.groundColor.set(settings.hemisphereGroundColor);
    }
    if (settings.hemisphereIntensity !== undefined) {
      hemisphereLight.intensity = settings.hemisphereIntensity;
    }
  }
  
  // Handle hemisphere light enable/disable
  if (settings.hemisphereEnabled !== undefined) {
    const scene = getScene();
    if (scene) {
      if (settings.hemisphereEnabled && !hemisphereLight) {
        // Create hemisphere light if enabled and doesn't exist
        hemisphereLight = new THREE.HemisphereLight(
          currentSettings.hemisphereSkyColor ?? '#87ceeb',
          currentSettings.hemisphereGroundColor ?? '#3d5c3d',
          currentSettings.hemisphereIntensity ?? 0.4
        );
        scene.add(hemisphereLight);
      } else if (!settings.hemisphereEnabled && hemisphereLight) {
        // Remove hemisphere light if disabled
        scene.remove(hemisphereLight);
        hemisphereLight = null;
      }
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
  
  // Update procedural sky dome uniforms
  updateSkyUniforms(settings);
}

/**
 * Get the sun light for external use (e.g., shadow camera helper).
 */
export function getSunLight(): THREE.DirectionalLight | null {
  return sunLight;
}

/**
 * Get the moon light for external use.
 */
export function getMoonLight(): THREE.DirectionalLight | null {
  return moonLight;
}

/**
 * Get the hemisphere light for external use.
 */
export function getHemisphereLight(): THREE.HemisphereLight | null {
  return hemisphereLight;
}

/**
 * Dispose of lighting resources.
 */
export function disposeLighting(): void {
  const scene = getScene();
  
  if (sunLight && scene) {
    scene.remove(sunLight);
    scene.remove(sunLight.target);
    sunLight.shadow.map?.dispose();
    sunLight = null;
  }
  
  if (moonLight && scene) {
    scene.remove(moonLight);
    scene.remove(moonLight.target);
    moonLight = null;
  }
  
  if (hemisphereLight && scene) {
    scene.remove(hemisphereLight);
    hemisphereLight = null;
  }
  
  // Dispose procedural sky dome
  disposeSkyDome();
  
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
