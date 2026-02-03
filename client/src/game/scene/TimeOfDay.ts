/**
 * Time of Day System
 * 
 * Controls sun/moon positioning, lighting colors, and day/night cycle.
 * Time is normalized 0-1 where:
 *   0.00 = midnight
 *   0.25 = sunrise (6am)
 *   0.50 = noon
 *   0.75 = sunset (6pm)
 *   1.00 = midnight (wraps to 0)
 */

import * as THREE from 'three';
import { getScene } from './scene';

// ============== Types ==============

export interface EnvironmentSettings {
  // Time of day
  timeOfDay: number;        // 0-1 normalized time
  timeSpeed: number;        // Multiplier for real-time progression (0 = paused)
  
  // Sun settings
  sunColor: string;         // Hex color
  sunIntensity: number;     // 0-10
  sunDistance: number;      // Distance from player for shadow positioning
  
  // Moon settings  
  moonColor: string;        // Hex color
  moonIntensity: number;    // 0-10
  
  // Ambient light
  ambientColor: string;     // Hex color
  ambientIntensity: number; // 0-2
  
  // Environment (IBL)
  environmentIntensity: number; // 0-2
  
  // Shadow settings
  shadowBias: number;       // -0.01 to 0.01
  shadowNormalBias: number; // 0 to 0.1
  shadowMapSize: number;    // 512, 1024, 2048, 4096
  
  // Tone mapping
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number; // 0.1 to 3
  
  // Post-processing
  ssaoKernelRadius: number;    // 0 to 32
  ssaoMinDistance: number;     // 0.001 to 0.02
  bloomIntensity: number;      // 0 to 3
  bloomThreshold: number;      // 0 to 1
  bloomRadius: number;         // 0 to 1
}

export const DEFAULT_ENVIRONMENT: EnvironmentSettings = {
  timeOfDay: 0.35,          // ~8:30am - nice morning light
  timeSpeed: 0,             // Paused by default
  
  sunColor: '#ffcc00',
  sunIntensity: 3.0,
  sunDistance: 150,
  
  moonColor: '#8899bb',
  moonIntensity: 0.3,
  
  ambientColor: '#ffffff',
  ambientIntensity: 0.1,
  
  environmentIntensity: 1.0,
  
  shadowBias: -0.0001,
  shadowNormalBias: 0.02,
  shadowMapSize: 4096,
  
  toneMapping: THREE.ACESFilmicToneMapping,
  toneMappingExposure: 1.0,
  
  ssaoKernelRadius: 12,
  ssaoMinDistance: 0.002,
  bloomIntensity: 0.3,
  bloomThreshold: 0.85,
  bloomRadius: 0.4,
};

// ============== Internal State ==============

let sunLight: THREE.DirectionalLight | null = null;
let moonLight: THREE.DirectionalLight | null = null;
let ambientLight: THREE.AmbientLight | null = null;
let currentSettings: EnvironmentSettings = { ...DEFAULT_ENVIRONMENT };
let renderer: THREE.WebGLRenderer | null = null;
let lastPlayerPosition: THREE.Vector3 = new THREE.Vector3(0, 0, 0);

// Orbit radius for sun/moon around player
const ORBIT_RADIUS = 200;

// ============== Initialization ==============

/**
 * Initialize the time of day lighting system.
 * Call this after scene is created, before setupLighting.
 */
export function initTimeOfDay(webglRenderer: THREE.WebGLRenderer): void {
  const scene = getScene();
  if (!scene) {
    console.error('[TimeOfDay] Scene not initialized');
    return;
  }
  
  renderer = webglRenderer;
  
  // Ambient light
  ambientLight = new THREE.AmbientLight(
    currentSettings.ambientColor,
    currentSettings.ambientIntensity
  );
  scene.add(ambientLight);
  
  // Sun (main directional light)
  sunLight = new THREE.DirectionalLight(
    currentSettings.sunColor,
    currentSettings.sunIntensity
  );
  sunLight.castShadow = true;
  configureShadowCamera(sunLight, currentSettings);
  scene.add(sunLight);
  scene.add(sunLight.target);
  
  // Moon (secondary directional light, opposite to sun)
  moonLight = new THREE.DirectionalLight(
    currentSettings.moonColor,
    0 // Start at 0, will be set based on time
  );
  moonLight.castShadow = false; // Moon shadows optional for perf
  scene.add(moonLight);
  scene.add(moonLight.target);
  
  // Apply initial settings
  applyEnvironmentSettings(currentSettings);
  
  console.log('[TimeOfDay] Initialized');
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

// ============== Update Loop ==============

/**
 * Update time of day system.
 * Call each frame with delta time in seconds.
 */
export function updateTimeOfDay(deltaTime: number, playerPosition: THREE.Vector3): void {
  // Store last known position for immediate updates from UI
  lastPlayerPosition.copy(playerPosition);
  
  // Progress time
  if (currentSettings.timeSpeed > 0) {
    currentSettings.timeOfDay += deltaTime * currentSettings.timeSpeed / 60; // timeSpeed in minutes per real second
    currentSettings.timeOfDay = currentSettings.timeOfDay % 1; // Wrap at 1
  }
  
  // Update sun/moon positions and lighting
  updateSunMoonPositions(playerPosition);
}

/**
 * Update sun/moon positions and colors based on current time.
 * Called every frame and also when settings change from UI.
 */
function updateSunMoonPositions(playerPosition: THREE.Vector3): void {
  // Calculate sun/moon positions based on time
  const sunAngle = currentSettings.timeOfDay * Math.PI * 2 - Math.PI / 2; // 0 = sunrise at east
  const moonAngle = sunAngle + Math.PI; // Moon opposite to sun
  const sunHeight = Math.sin(sunAngle);
  const moonHeight = Math.sin(moonAngle);
  
  // Day factor: 1 at noon, 0 at night (with smooth transition)
  const dayFactor = smoothstep(-0.1, 0.3, sunHeight);
  const nightFactor = 1 - dayFactor;
  
  // Sun position (orbits around player)
  if (sunLight) {
    const sunHorizontal = Math.cos(sunAngle);
    
    // Sun rises in east (+X), sets in west (-X)
    sunLight.position.set(
      playerPosition.x + sunHorizontal * ORBIT_RADIUS,
      playerPosition.y + sunHeight * currentSettings.sunDistance,
      playerPosition.z + sunHorizontal * ORBIT_RADIUS * 0.3 // Slight offset for visual interest
    );
    sunLight.target.position.copy(playerPosition);
    
    // Sun intensity based on elevation (fades at horizon)
    const sunVisibility = Math.max(0, sunHeight);
    const sunFade = smoothstep(0, 0.3, sunVisibility);
    sunLight.intensity = currentSettings.sunIntensity * sunFade;
    
    // Sun color shifts to orange/red at sunset/sunrise
    const horizonFactor = 1 - Math.abs(sunHeight);
    const sunHue = lerpColor(currentSettings.sunColor, '#ff4400', horizonFactor * 0.7);
    sunLight.color.set(sunHue);
  }
  
  // Moon position (opposite to sun)
  if (moonLight) {
    const moonHorizontal = Math.cos(moonAngle);
    
    moonLight.position.set(
      playerPosition.x + moonHorizontal * ORBIT_RADIUS,
      playerPosition.y + moonHeight * currentSettings.sunDistance,
      playerPosition.z - moonHorizontal * ORBIT_RADIUS * 0.3
    );
    moonLight.target.position.copy(playerPosition);
    
    // Moon visible when sun is down
    const moonVisibility = Math.max(0, moonHeight);
    const moonFade = smoothstep(0, 0.3, moonVisibility);
    moonLight.intensity = currentSettings.moonIntensity * moonFade;
    
    // Moon has a subtle blue tint
    const moonHue = lerpColor(currentSettings.moonColor, '#6688cc', 0.3);
    moonLight.color.set(moonHue);
  }
  
  // Ambient light - much dimmer at night with blue tint
  if (ambientLight) {
    // At night: 2% intensity, during day: full intensity
    const ambientMultiplier = 0.02 + dayFactor * 0.98;
    ambientLight.intensity = currentSettings.ambientIntensity * ambientMultiplier;
    
    // Strong blue shift at night
    const ambientHue = lerpColor(currentSettings.ambientColor, '#0a1525', nightFactor * 0.95);
    ambientLight.color.set(ambientHue);
  }
  
  // Environment (IBL) intensity - dramatically reduced at night
  const scene = getScene();
  if (scene) {
    // At night: 2% of environment intensity, during day: full
    // IBL from bright HDRI needs to be very low at night
    const envMultiplier = 0.02 + dayFactor * 0.98;
    const envIntensity = currentSettings.environmentIntensity * envMultiplier;
    
    // Apply to both environment (IBL reflections) and background (visible sky)
    (scene as unknown as { environmentIntensity: number }).environmentIntensity = envIntensity;
    (scene as unknown as { backgroundIntensity: number }).backgroundIntensity = envIntensity;
  }
  
  // Renderer adjustments for night
  if (renderer) {
    // Background color - only visible if scene.background is null
    const dayColor = new THREE.Color(0x87ceeb); // Sky blue
    const nightColor = new THREE.Color(0x050810); // Very dark blue-black
    const bgColor = dayColor.clone().lerp(nightColor, nightFactor);
    renderer.setClearColor(bgColor);
    
    // Reduce exposure at night for additional darkness
    const exposureMultiplier = 0.5 + dayFactor * 0.5; // 50% at night, 100% at day
    renderer.toneMappingExposure = currentSettings.toneMappingExposure * exposureMultiplier;
  }
}

// ============== Settings Application ==============

/**
 * Apply environment settings.
 * Call when settings change from UI.
 */
export function applyEnvironmentSettings(settings: Partial<EnvironmentSettings>): void {
  currentSettings = { ...currentSettings, ...settings };
  
  // Apply to lights
  if (sunLight) {
    sunLight.color.set(currentSettings.sunColor);
    sunLight.shadow.bias = currentSettings.shadowBias;
    sunLight.shadow.normalBias = currentSettings.shadowNormalBias;
    
    // Update shadow map size if changed
    if (sunLight.shadow.mapSize.width !== currentSettings.shadowMapSize) {
      sunLight.shadow.mapSize.width = currentSettings.shadowMapSize;
      sunLight.shadow.mapSize.height = currentSettings.shadowMapSize;
      sunLight.shadow.map?.dispose();
      sunLight.shadow.map = null;
    }
  }
  
  if (moonLight) {
    moonLight.color.set(currentSettings.moonColor);
  }
  
  if (ambientLight) {
    ambientLight.color.set(currentSettings.ambientColor);
    // Note: intensity is adjusted by time of day in updateSunMoonPositions
  }
  
  // Apply to scene - base values, will be modulated by time of day
  const scene = getScene();
  if (scene) {
    (scene as unknown as { environmentIntensity: number }).environmentIntensity = 
      currentSettings.environmentIntensity;
    (scene as unknown as { backgroundIntensity: number }).backgroundIntensity = 
      currentSettings.environmentIntensity;
  }
  
  // Apply to renderer
  if (renderer) {
    renderer.toneMapping = currentSettings.toneMapping;
    renderer.toneMappingExposure = currentSettings.toneMappingExposure;
  }
  
  // Always update sun/moon positions and lighting when any setting changes
  updateSunMoonPositions(lastPlayerPosition);
}

/**
 * Get current environment settings (for UI binding).
 */
export function getEnvironmentSettings(): EnvironmentSettings {
  return { ...currentSettings };
}

/**
 * Set time of day directly (0-1).
 */
export function setTimeOfDay(time: number): void {
  currentSettings.timeOfDay = Math.max(0, Math.min(1, time));
}

/**
 * Get the sun light for external use (e.g., shadow camera helper).
 */
export function getSunLight(): THREE.DirectionalLight | null {
  return sunLight;
}

// ============== Utility Functions ==============

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerpColor(colorA: string, colorB: string, t: number): string {
  const a = new THREE.Color(colorA);
  const b = new THREE.Color(colorB);
  a.lerp(b, t);
  return '#' + a.getHexString();
}

/**
 * Get formatted time string (HH:MM format).
 */
export function formatTimeOfDay(time: number): string {
  const hours = Math.floor(time * 24);
  const minutes = Math.floor((time * 24 - hours) * 60);
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
}

/**
 * Map for tone mapping types.
 */
export const TONE_MAPPING_OPTIONS: { label: string; value: THREE.ToneMapping }[] = [
  { label: 'None', value: THREE.NoToneMapping },
  { label: 'Linear', value: THREE.LinearToneMapping },
  { label: 'Reinhard', value: THREE.ReinhardToneMapping },
  { label: 'Cineon', value: THREE.CineonToneMapping },
  { label: 'ACES Filmic', value: THREE.ACESFilmicToneMapping },
  { label: 'AgX', value: THREE.AgXToneMapping },
];
