/**
 * Lighting System
 * 
 * Manages sun, moon, hemisphere lights, and procedural sky dome.
 * Uses store values for all settings to allow runtime adjustments.
 * 
 * Sun and moon positions can be set via azimuth/elevation angles,
 * calculated automatically by DayNightCycle.ts or set manually.
 * 
 * SHADOW MODEL: Only one directional light casts shadows at a time.
 * The shadow caster swaps between sun and moon based on which is
 * dominant (above the horizon with higher intensity). This avoids
 * the Three.js bug where toggling castShadow changes
 * NUM_DIR_LIGHT_SHADOWS without recompiling receiver shaders.
 */

import * as THREE from 'three';
import { getScene } from './scene';
import { setTerrainEnvMapIntensity } from '../material/TerrainMaterial';
import { useGameStore, EnvironmentSettings } from '../../state/store';
import { initSkyDome, updateSkyUniforms, disposeSkyDome } from './SkyDome';
import { CHUNK_WORLD_SIZE } from '@worldify/shared';

// ============== Internal State ==============

let sunLight: THREE.DirectionalLight | null = null;
let moonLight: THREE.DirectionalLight | null = null;
let hemisphereLight: THREE.HemisphereLight | null = null;
let renderer: THREE.WebGLRenderer | null = null;

/** Which light currently owns the single shadow map: 'sun' | 'moon' */
let activeShadowCaster: 'sun' | 'moon' = 'sun';

/** Whether moon is allowed to become the shadow caster (quality setting) */
let moonShadowsAllowed = false;

/** Current shadow frustum half-size (updated when visibility changes) */
let shadowFrustumSize = 40;

/** Shadow camera far plane */
const SHADOW_FAR = 200;

/** Extra margin (meters) beyond visibility radius for shadow frustum */
const SHADOW_MARGIN = 8;

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
  
  // Moon (secondary directional light — does NOT cast shadows on init;
  // shadow caster is swapped at runtime by updateShadowCaster())
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
  moonLight.castShadow = false;
  configureShadowCamera(moonLight, settings);
  scene.add(moonLight);
  scene.add(moonLight.target);
  
  activeShadowCaster = 'sun';
  
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
  
  console.log('[Lighting] Initialized with sun + moon + hemisphere + procedural sky (single shadow caster)');
}

function configureShadowCamera(light: THREE.DirectionalLight, settings: EnvironmentSettings): void {
  light.shadow.mapSize.width = settings.shadowMapSize;
  light.shadow.mapSize.height = settings.shadowMapSize;
  light.shadow.camera.left = -shadowFrustumSize;
  light.shadow.camera.right = shadowFrustumSize;
  light.shadow.camera.top = shadowFrustumSize;
  light.shadow.camera.bottom = -shadowFrustumSize;
  light.shadow.camera.near = 0.5;
  light.shadow.camera.far = SHADOW_FAR;
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
      if (moonLight) moonLight.shadow.bias = settings.shadowBias;
    }
    if (settings.shadowNormalBias !== undefined) {
      sunLight.shadow.normalBias = settings.shadowNormalBias;
      if (moonLight) moonLight.shadow.normalBias = settings.shadowNormalBias;
    }
    if (settings.shadowMapSize !== undefined && sunLight.shadow.mapSize.width !== settings.shadowMapSize) {
      // Update both lights so either can be shadow caster
      for (const light of [sunLight, moonLight]) {
        if (light && light.shadow.mapSize.width !== settings.shadowMapSize) {
          light.shadow.mapSize.width = settings.shadowMapSize;
          light.shadow.mapSize.height = settings.shadowMapSize;
          light.shadow.map?.dispose();
          light.shadow.map = null;
        }
      }
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
 * Get which light currently owns the shadow.
 */
export function getActiveShadowCaster(): 'sun' | 'moon' {
  return activeShadowCaster;
}

/**
 * Get the light that currently casts shadows.
 */
export function getActiveShadowLight(): THREE.DirectionalLight | null {
  return activeShadowCaster === 'sun' ? sunLight : moonLight;
}

// ============== Shadow Caster Swap ==============

/**
 * Set whether moon is allowed to become the shadow caster.
 * Called by QualityManager when the moonShadows quality setting changes.
 */
export function setMoonShadowsAllowed(allowed: boolean): void {
  moonShadowsAllowed = allowed;
  // If moon shadows just got disabled and moon currently owns the shadow, swap back to sun
  if (!allowed && activeShadowCaster === 'moon') {
    transferShadowCaster('sun');
  }
}

export function isMoonShadowsAllowed(): boolean {
  return moonShadowsAllowed;
}

/**
 * Update which directional light casts shadows based on current intensities.
 * Call each frame from DayNightCycle (or whenever intensities change).
 * 
 * Only ONE light casts shadows at a time. This keeps NUM_DIR_LIGHT_SHADOWS
 * constant at 1 so receiver shaders never need recompilation.
 * 
 * @param sunIntensity - current sun light intensity
 * @param moonIntensity - current moon light intensity
 */
export function updateShadowCaster(sunIntensity: number, moonIntensity: number): void {
  if (!sunLight || !moonLight) return;
  
  // Determine who should own the shadow
  let desired: 'sun' | 'moon' = 'sun';
  if (moonShadowsAllowed && moonIntensity > sunIntensity) {
    desired = 'moon';
  }
  
  if (desired !== activeShadowCaster) {
    transferShadowCaster(desired);
  }
}

/**
 * Transfer shadow casting from the current light to `target`.
 * Disposes the old shadow map and marks the renderer for update.
 */
function transferShadowCaster(target: 'sun' | 'moon'): void {
  const oldLight = activeShadowCaster === 'sun' ? sunLight : moonLight;
  const newLight = target === 'sun' ? sunLight : moonLight;
  if (!oldLight || !newLight) return;
  
  // Turn off old
  oldLight.castShadow = false;
  oldLight.shadow.map?.dispose();
  oldLight.shadow.map = null;
  
  // Turn on new
  newLight.castShadow = true;
  // Shadow map will be auto-allocated on next render
  
  // Force the renderer to re-render shadows
  if (renderer) {
    renderer.shadowMap.needsUpdate = true;
  }
  
  activeShadowCaster = target;
  console.log(`[Lighting] Shadow caster swapped to ${target}`);
}

// ============== Shadow Follow ==============

// Reusable vector to avoid per-frame allocation
const _lightOffset = new THREE.Vector3();

/**
 * Update the shadow frustum size based on visibility radius.
 * Call when quality/visibility settings change.
 */
export function updateShadowFrustumSize(visibilityRadius: number): void {
  // Frustum covers the visible terrain + a small margin for shadow casters outside view
  const newSize = visibilityRadius * CHUNK_WORLD_SIZE + SHADOW_MARGIN;
  if (newSize === shadowFrustumSize) return;
  shadowFrustumSize = newSize;

  // Apply to both lights
  for (const light of [sunLight, moonLight]) {
    if (!light) continue;
    const cam = light.shadow.camera;
    cam.left = -shadowFrustumSize;
    cam.right = shadowFrustumSize;
    cam.top = shadowFrustumSize;
    cam.bottom = -shadowFrustumSize;
    cam.updateProjectionMatrix();
  }
}

/**
 * Update the shadow camera to follow a world position (player or spectator center).
 * 
 * Moves the active shadow light's target to `center` and offsets the light position
 * along the light direction. Snaps to shadow texel grid to prevent shadow swimming.
 * 
 * Call once per frame from GameCore.update().
 */
export function updateShadowFollow(center: THREE.Vector3): void {
  const light = activeShadowCaster === 'sun' ? sunLight : moonLight;
  if (!light || !light.castShadow) return;

  // The light direction is encoded in its position (directional light
  // shines from position toward target). We keep the same direction but
  // re-center around the player.
  
  // Compute the normalized light-to-target direction from current position
  _lightOffset.copy(light.position).sub(light.target.position);
  if (_lightOffset.lengthSq() < 0.001) return;
  _lightOffset.normalize();

  // Snap center to shadow texel grid to prevent shadow swimming/shimmer
  // when the player moves sub-texel amounts
  const shadowMapSize = light.shadow.mapSize.width;
  const worldUnitsPerTexel = (shadowFrustumSize * 2) / shadowMapSize;
  
  // Snap in the shadow camera's "right" and "up" directions
  // For simplicity, snap in world XZ (dominant axes for top-down shadow)
  const snappedX = Math.floor(center.x / worldUnitsPerTexel) * worldUnitsPerTexel;
  const snappedZ = Math.floor(center.z / worldUnitsPerTexel) * worldUnitsPerTexel;

  // Move the light target to (snapped) player position
  light.target.position.set(snappedX, center.y, snappedZ);
  light.target.updateMatrixWorld();

  // Offset the light itself at a fixed distance along the light direction
  // Distance must be > shadow far / 2 to keep camera.near > 0
  const lightDistance = SHADOW_FAR * 0.5;
  light.position.set(
    snappedX + _lightOffset.x * lightDistance,
    center.y + _lightOffset.y * lightDistance,
    snappedZ + _lightOffset.z * lightDistance,
  );
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
    moonLight.shadow.map?.dispose();
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
