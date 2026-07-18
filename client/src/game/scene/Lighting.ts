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
import { useGameStore, EnvironmentSettings } from '../../state/store';
import { initSkyDome, updateSkyUniforms, disposeSkyDome } from './SkyDome';
import { FIRST_PERSON_LAYER, FIRST_PERSON_ITEM_LAYER } from './firstPersonLayer';
import { CHUNK_WORLD_SIZE, deriveLighting, type DerivedLighting } from '@worldify/shared';

// ============== Internal State ==============

let sunLight: THREE.DirectionalLight | null = null;
let moonLight: THREE.DirectionalLight | null = null;
let hemisphereLight: THREE.HemisphereLight | null = null;
let renderer: THREE.WebGLRenderer | null = null;

/** Which light currently owns the single shadow map: 'sun' | 'moon' */
let activeShadowCaster: 'sun' | 'moon' = 'sun';

/** Whether moon is allowed to become the shadow caster (quality setting) */
let moonShadowsAllowed = false;

/**
 * Sun/moon world directions (unit vectors pointing from the scene toward the body). Set from
 * the derived azimuth/elevation each frame and used to position both the lights and the
 * shadow-follow — so the light *direction* is always correct and independent of where the
 * player is in the world (the sun/moon don't drift as you move).
 */
const _sunDir = new THREE.Vector3(0, 1, 0);
const _moonDir = new THREE.Vector3(0, -1, 0);

/** Fade level below which a queued caster swap is executed (swap is invisible at ~0). */
const SWAP_EPS = 0.03;

/** Current shadow frustum half-size (updated when visibility changes) */
let shadowFrustumSize = 40;

/** Shadow camera far plane */
const SHADOW_FAR = 200;

/**
 * Extra margin (meters) beyond the shadow radius for the shadow frustum. Chunk-groups are
 * 4×4×4 chunks and cull by group *center*, so a casting group's geometry reaches ~2 chunks
 * (16m) past the radius; the margin must cover that (16m) plus a chunk of safety so edge
 * groups aren't clipped out of the shadow camera.
 */
const SHADOW_MARGIN = 24;

// ============== Position Calculation ==============

/** Write the unit direction for azimuth/elevation (degrees) into `out`. */
function anglesToDir(azimuth: number, elevation: number, out: THREE.Vector3): THREE.Vector3 {
  const azRad = (azimuth * Math.PI) / 180;
  const elRad = (elevation * Math.PI) / 180;
  const cosEl = Math.cos(elRad);
  return out.set(
    Math.sin(azRad) * cosEl,
    Math.sin(elRad),
    Math.cos(azRad) * cosEl
  ).normalize();
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
  
  // Get initial settings from store
  const settings = useGameStore.getState().environment;

  // Sun (primary directional light). Colour/intensity/position are seeded from the keyframes
  // below via applyDerivedLighting — the placeholders here are overwritten before first render.
  sunLight = new THREE.DirectionalLight('#ffffff', 1);
  sunLight.castShadow = true;
  sunLight.shadow.intensity = 1;
  sunLight.layers.enable(FIRST_PERSON_LAYER); sunLight.layers.enable(FIRST_PERSON_ITEM_LAYER); // light the FP arm + held item
  configureShadowCamera(sunLight, settings);
  scene.add(sunLight);
  scene.add(sunLight.target);

  // Moon (secondary directional light — does NOT cast shadows on init; the shadow caster is
  // swapped/faded at runtime by updateShadowCaster()).
  moonLight = new THREE.DirectionalLight('#8899bb', 0.3);
  moonLight.castShadow = false;
  moonLight.shadow.intensity = 0;
  moonLight.layers.enable(FIRST_PERSON_LAYER); moonLight.layers.enable(FIRST_PERSON_ITEM_LAYER); // light the FP arm + held item
  configureShadowCamera(moonLight, settings);
  scene.add(moonLight);
  scene.add(moonLight.target);

  activeShadowCaster = 'sun';

  // Hemisphere light (sky/ground gradient — the natural outdoor fill; replaces ambient).
  // Always present; colours + intensity are driven by the keyframes.
  hemisphereLight = new THREE.HemisphereLight('#87ceeb', '#3d5c3d', 1.0);
  hemisphereLight.layers.enable(FIRST_PERSON_LAYER); hemisphereLight.layers.enable(FIRST_PERSON_ITEM_LAYER); // light the FP arm + held item
  scene.add(hemisphereLight);

  // Initialize procedural sky dome (its uniforms are seeded by applyDerivedLighting below).
  initSkyDome();

  // ACES tone mapping — applied once here (no longer a runtime setting). Note the always-on
  // post-processing composer has no ToneMappingEffect, so this affects only the rare
  // composer-bypassed path; kept for parity with the previous look.
  if (renderer) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
  }

  // Seed the full lighting state from the keyframes at the current time (no first-frame flash).
  const cfg = useGameStore.getState().dayNightConfig;
  applyDerivedLighting(deriveLighting(cfg, settings.timeOfDay));

  console.log('[Lighting] Initialized with sun + moon + hemisphere + procedural sky (single shadow caster)');

  // Subscribe to store — update shadow blur radius when it changes
  useGameStore.subscribe((state, prev) => {
    if (state.environment.shadowBlurRadius !== prev.environment.shadowBlurRadius) {
      applyShadowBlurRadius(state.environment.shadowBlurRadius);
    }
  });
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
  light.shadow.radius = settings.shadowBlurRadius ?? 8;
}

/**
 * Apply shadow blur radius to both lights.
 * Higher values = softer, more blurred shadow edges.
 */
function applyShadowBlurRadius(radius: number): void {
  for (const light of [sunLight, moonLight]) {
    if (light) {
      light.shadow.radius = radius;
    }
  }
}

// ============== Settings Application ==============

/**
 * Apply the derived day-night lighting (from `deriveLighting`) straight to the sun/moon/
 * hemisphere lights + the sky dome. Positions are set relative to each light's current target
 * along the stored direction, so the light *direction* is constant regardless of world position
 * (the sun/moon don't drift as the player moves).
 */
export function applyDerivedLighting(d: DerivedLighting): void {
  anglesToDir(d.sunAzimuth, d.sunElevation, _sunDir);
  anglesToDir(d.moonAzimuth, d.moonElevation, _moonDir);

  if (sunLight) {
    sunLight.color.set(d.sunColor);
    sunLight.intensity = d.sunIntensity;
    sunLight.position.copy(sunLight.target.position).addScaledVector(_sunDir, d.sunDistance);
  }
  if (moonLight) {
    moonLight.color.set(d.moonColor);
    moonLight.intensity = d.moonIntensity;
    moonLight.position.copy(moonLight.target.position).addScaledVector(_moonDir, d.moonDistance);
  }
  if (hemisphereLight) {
    hemisphereLight.color.set(d.skyZenithColor);
    hemisphereLight.groundColor.set(d.groundColor);
    hemisphereLight.intensity = d.hemisphereIntensity;
  }

  updateSkyUniforms(d);
}

/**
 * Apply the non-cycle environment settings that affect the lights/renderer — currently just
 * the shadow bias / normal-bias / map-size (post-FX and terrain-shader fields are applied by
 * their own owners). Called from the debug panel on change.
 */
export function applyEnvironmentSettings(settings: Partial<EnvironmentSettings>): void {
  if (!sunLight) return;

  if (settings.shadowBias !== undefined) {
    sunLight.shadow.bias = settings.shadowBias;
    if (moonLight) moonLight.shadow.bias = settings.shadowBias;
  }
  if (settings.shadowNormalBias !== undefined) {
    sunLight.shadow.normalBias = settings.shadowNormalBias;
    if (moonLight) moonLight.shadow.normalBias = settings.shadowNormalBias;
  }
  if (settings.shadowMapSize !== undefined && sunLight.shadow.mapSize.width !== settings.shadowMapSize) {
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
 * Set whether the moon is allowed to become the shadow caster. Moon shadows are unified
 * with the sun: QualityManager passes the quality `shadowsEnabled` flag here, so whenever
 * shadows are on, the moon casts at night (the single caster swaps to whichever body is up).
 */
export function setMoonShadowsAllowed(allowed: boolean): void {
  moonShadowsAllowed = allowed;
  // If moon shadows are disabled while the moon owns the shadow: when the cycle is running the
  // reconciler will fade+swap to the sun next frame, but when it's paused/off the reconciler
  // isn't pumping — so hard-swap immediately in that case.
  if (!allowed && activeShadowCaster === 'moon') {
    const cycleRunning = useGameStore.getState().environment.dayNightEnabled ?? false;
    if (!cycleRunning) {
      transferShadowCaster('sun');
      if (sunLight) sunLight.shadow.intensity = 1;
    }
  }
}

export function isMoonShadowsAllowed(): boolean {
  return moonShadowsAllowed;
}

/**
 * Reconcile which directional light casts shadows, and drive a pop-free fade across sun↔moon
 * hand-offs. Called each frame from DayNightCycle.
 *
 * Only ONE light casts shadows at a time (keeps NUM_DIR_LIGHT_SHADOWS constant → no receiver
 * recompiles). The active caster's `shadow.intensity` follows its body's elevation (shadows
 * soften to nothing as the body reaches the horizon), and a queued caster swap is deferred
 * until that intensity is ~0 — so the hard castShadow flip (which disposes/reallocates the
 * shadow map) is invisible. A hysteresis deadband avoids thrash at the crossover.
 */
export function updateShadowCaster(sunElevation: number, moonElevation: number, shadowFadeAngle: number): void {
  if (!sunLight || !moonLight) return;

  // Desired caster by ELEVATION: whichever body is higher and above the horizon. Sun & moon cross
  // 0° together at dawn/dusk, so the swap lands where BOTH are at the horizon — where the fade is
  // ~0 for both — instead of when the incoming body is already high (the old dusk-pop). A small
  // deadband avoids thrash at the crossover.
  let desired: 'sun' | 'moon';
  if (moonShadowsAllowed && moonElevation > 0 && moonElevation > sunElevation + 1) desired = 'moon';
  else if (sunElevation > moonElevation + 1 || !moonShadowsAllowed) desired = 'sun';
  else desired = activeShadowCaster;

  const active = getActiveShadowLight();
  if (!active) return;

  // Fade level = smoothstep of the active body's elevation over [horizon, shadowFadeAngle].
  // The band is anchored at the horizon (0°): the shadow reaches 0 exactly where the sun/moon
  // cross — i.e. where the caster swaps — so the hand-off is seamless, while `shadowFadeAngle`
  // alone controls how quickly the shadow returns to full above the horizon (smaller = snappier).
  const activeElev = activeShadowCaster === 'sun' ? sunElevation : moonElevation;
  const f = Math.min(1, Math.max(0, activeElev / shadowFadeAngle));
  active.shadow.intensity = f * f * (3 - 2 * f);

  if (desired !== activeShadowCaster && active.shadow.intensity <= SWAP_EPS) {
    // Perform the (invisible) hard swap only once the active shadow has faded to ~0.
    transferShadowCaster(desired);
    const next = getActiveShadowLight();
    if (next) next.shadow.intensity = 0; // fades back up next frame from its own elevation
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
 * Update the shadow frustum size based on shadow radius (in chunks).
 * Uses a dedicated shadow radius that is typically smaller than visibility radius,
 * so the frustum is tighter and produces higher-resolution shadows.
 * Call when quality settings change.
 */
export function updateShadowFrustumSize(shadowRadius: number): void {
  // Frustum covers the shadow-casting area + a small margin
  const newSize = shadowRadius * CHUNK_WORLD_SIZE + SHADOW_MARGIN;
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

  // Use the stored light direction (from the derived azimuth/elevation), NOT position−target —
  // so the direction is constant regardless of where the player is in the world.
  _lightOffset.copy(activeShadowCaster === 'sun' ? _sunDir : _moonDir);
  if (_lightOffset.lengthSq() < 0.001) return;

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
