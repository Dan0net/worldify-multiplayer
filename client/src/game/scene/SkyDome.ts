/**
 * Procedural Sky Dome
 * 
 * Creates a sky dome mesh with a custom shader that matches the day-night cycle.
 * Reads from the same store values as the lighting system for consistent visuals.
 * 
 * Features:
 * - Sky gradient matching hemisphere light colors
 * - Sun disc with soft glow
 * - Moon disc with subtle glow
 * - Animated twinkling stars at night
 */

import * as THREE from 'three';
import { getScene } from './scene';
import { useGameStore } from '../../state/store';

// ============== Shader Code ==============

const vertexShader = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vPosition;

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  vPosition = position;
  
  // Keep sky dome centered on camera (infinite distance effect)
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
precision highp float;

uniform vec3 uSkyColor;
uniform vec3 uHorizonColor;
uniform vec3 uGroundColor;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uMoonDirection;
uniform vec3 uMoonColor;
uniform float uMoonIntensity;
uniform float uTime;

varying vec3 vWorldPosition;
varying vec3 vPosition;

// ============== Noise Functions ==============

// Simple hash for star positions
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

// 2D noise for star twinkle
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f); // smoothstep
  
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ============== Star Field ==============

float stars(vec3 dir, float time) {
  // Project to sphere coordinates for even distribution
  vec2 uv = vec2(
    atan(dir.x, dir.z) / 3.14159265,
    dir.y
  );
  
  // Multiple layers of stars at different scales
  float stars = 0.0;
  
  // Large bright stars
  vec2 starUV1 = uv * 100.0;
  float star1 = hash(floor(starUV1));
  if (star1 > 0.985) {
    vec2 center = fract(starUV1) - 0.5;
    float dist = length(center);
    // Twinkle animation
    float twinkle = 0.7 + 0.3 * sin(time * 2.0 + star1 * 100.0);
    stars += smoothstep(0.15, 0.0, dist) * twinkle * (star1 - 0.985) * 66.0;
  }
  
  // Medium stars
  vec2 starUV2 = uv * 300.0;
  float star2 = hash(floor(starUV2));
  if (star2 > 0.992) {
    vec2 center = fract(starUV2) - 0.5;
    float dist = length(center);
    float twinkle = 0.6 + 0.4 * sin(time * 3.0 + star2 * 200.0);
    stars += smoothstep(0.1, 0.0, dist) * twinkle * 0.5;
  }
  
  // Small dim stars
  vec2 starUV3 = uv * 600.0;
  float star3 = hash(floor(starUV3));
  if (star3 > 0.995) {
    vec2 center = fract(starUV3) - 0.5;
    float dist = length(center);
    float twinkle = 0.5 + 0.5 * sin(time * 4.0 + star3 * 300.0);
    stars += smoothstep(0.08, 0.0, dist) * twinkle * 0.3;
  }
  
  return stars;
}

// ============== Main ==============

void main() {
  vec3 viewDir = normalize(vWorldPosition);
  float altitude = viewDir.y;
  
  // Get sun altitude for atmospheric calculations
  float sunAltitude = uSunDirection.y;
  
  // === Sky Gradient with atmospheric scattering ===
  vec3 sky;
  
  // Calculate how much to darken the sky (night = darker, day = normal)
  // This ensures the procedural sky matches hemisphere light intensity
  float nightFactor = smoothstep(0.1, -0.2, sunAltitude); // 0 at day, 1 at night
  float skyDarkening = mix(1.0, 0.08, nightFactor); // Day: full brightness, Night: 8%
  
  // Dawn/dusk atmospheric colors - warm at horizon, cool at zenith
  float dawnDusk = 1.0 - abs(sunAltitude - 0.0) / 0.3; // Peak at sunset/sunrise
  dawnDusk = max(0.0, dawnDusk);
  dawnDusk = pow(dawnDusk, 0.7); // Soften the falloff
  
  // Warm sunset colors
  vec3 sunsetHorizon = vec3(1.0, 0.4, 0.15);  // Orange-red
  vec3 sunsetZenith = vec3(0.3, 0.2, 0.5);     // Purple
  
  // Smooth blend factor across horizon (no sharp line)
  // -0.1 to 0.1 is the transition zone
  float horizonBlend = smoothstep(-0.1, 0.1, altitude);
  
  // Calculate sky color (above horizon)
  float tSky = pow(max(0.0, altitude), 0.5);
  vec3 skyAbove = mix(uHorizonColor, uSkyColor, tSky);
  vec3 sunsetGradient = mix(sunsetHorizon, sunsetZenith, pow(max(0.0, altitude), 0.4));
  skyAbove = mix(skyAbove, sunsetGradient, dawnDusk * 0.7);
  
  // Calculate ground color (below horizon)
  float tGround = pow(max(0.0, -altitude), 0.4);
  vec3 skyBelow = mix(uHorizonColor, uGroundColor, tGround);
  
  // Blend smoothly across horizon
  sky = mix(skyBelow, skyAbove, horizonBlend);
  
  // Darken for night
  sky *= skyDarkening;
  
  // === Sun ===
  float sunAngle = dot(viewDir, uSunDirection);
  
  // Sun disc - MUCH bigger (was 0.9995-0.9998, now ~0.996-0.999 for ~3x size)
  float sunDisc = smoothstep(0.996, 0.9985, sunAngle);
  
  // Sun glow (soft halo) - wider
  float sunGlow = pow(max(0.0, sunAngle), 4.0) * 0.4;
  
  // Horizon glow when sun is low - more dramatic
  float horizonGlow = 0.0;
  if (sunAltitude > -0.2 && sunAltitude < 0.3) {
    float glowStrength = 1.0 - abs(sunAltitude - 0.05) / 0.25;
    glowStrength = pow(glowStrength, 0.6); // Stronger effect
    horizonGlow = pow(max(0.0, 1.0 - abs(altitude) * 2.0), 2.0) * glowStrength * 0.5;
    // Tint toward sun direction
    float towardSun = pow(max(0.0, dot(normalize(vec3(viewDir.x, 0.0, viewDir.z)), 
                                        normalize(vec3(uSunDirection.x, 0.0, uSunDirection.z)))), 1.5);
    horizonGlow *= towardSun;
  }
  
  // Add sun contribution
  vec3 sunContrib = uSunColor * uSunIntensity * (sunDisc * 2.0 + sunGlow + horizonGlow);
  sky += sunContrib;
  
  // === Moon ===
  float moonAngle = dot(viewDir, uMoonDirection);
  
  // Moon disc - MUCH bigger (was 0.999-0.9995, now ~0.994-0.998 for ~4x size)
  float moonDisc = smoothstep(0.994, 0.998, moonAngle);
  
  // Moon glow - wider and softer
  float moonGlow = pow(max(0.0, moonAngle), 8.0) * 0.4;
  
  // Moon rim glow for atmosphere
  float moonRim = smoothstep(0.99, 0.994, moonAngle) * (1.0 - moonDisc) * 0.3;
  
  // Only show moon when above horizon and visible
  float moonVisible = smoothstep(-0.1, 0.1, uMoonDirection.y) * uMoonIntensity;
  vec3 moonContrib = uMoonColor * (moonDisc * 1.0 + moonGlow + moonRim) * moonVisible;
  sky += moonContrib;
  
  // === Stars ===
  // Stars visible when sun is below horizon
  float starsVisible = smoothstep(0.0, -0.15, sunAltitude);
  // Fade out stars near horizon (atmospheric extinction)
  float starsFade = smoothstep(0.05, 0.4, altitude);
  
  if (starsVisible > 0.0 && altitude > 0.0) {
    float starField = stars(viewDir, uTime);
    // Brighter stars against dark sky
    sky += vec3(1.0, 0.97, 0.92) * starField * starsVisible * starsFade * 1.5;
  }
  
  gl_FragColor = vec4(sky, 1.0);
}
`;

// ============== Module State ==============

let skyDome: THREE.Mesh | null = null;
let skyMaterial: THREE.ShaderMaterial | null = null;

// ============== Initialization ==============

/**
 * Initialize the procedural sky dome.
 * Call after scene is created.
 */
export function initSkyDome(): void {
  const scene = getScene();
  if (!scene) {
    console.error('[SkyDome] Scene not initialized');
    return;
  }
  
  // Create large inverted sphere
  const geometry = new THREE.SphereGeometry(1000, 64, 32);
  
  // Get initial settings
  const settings = useGameStore.getState().environment;
  
  // Create shader material
  skyMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uSkyColor: { value: new THREE.Color(settings.hemisphereSkyColor ?? '#87ceeb') },
      uHorizonColor: { value: new THREE.Color(settings.hemisphereSkyColor ?? '#87ceeb').lerp(
        new THREE.Color(settings.hemisphereGroundColor ?? '#3d5c3d'), 0.3
      )},
      uGroundColor: { value: new THREE.Color(settings.hemisphereGroundColor ?? '#3d5c3d') },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(settings.sunColor ?? '#ffcc00') },
      uSunIntensity: { value: 1.0 },
      uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
      uMoonColor: { value: new THREE.Color(settings.moonColor ?? '#aabbdd') },
      uMoonIntensity: { value: 0.0 },
      uTime: { value: 0.0 },
    },
    side: THREE.BackSide, // Render inside of sphere
    depthWrite: false,
  });
  
  skyDome = new THREE.Mesh(geometry, skyMaterial);
  skyDome.renderOrder = -1000; // Render first (behind everything)
  scene.add(skyDome);
  
  // Set scene background to null (we're using the sky dome)
  scene.background = null;
  
  // Apply initial settings
  updateSkyUniforms(settings);
  
  console.log('[SkyDome] Initialized procedural sky');
}

// ============== Update Functions ==============

/**
 * Convert azimuth/elevation to normalized direction vector.
 */
function anglesToDirection(azimuth: number, elevation: number): THREE.Vector3 {
  const azRad = (azimuth * Math.PI) / 180;
  const elRad = (elevation * Math.PI) / 180;
  const cosEl = Math.cos(elRad);
  
  return new THREE.Vector3(
    Math.sin(azRad) * cosEl,
    Math.sin(elRad),
    Math.cos(azRad) * cosEl
  ).normalize();
}

/**
 * Update sky dome uniforms from environment settings.
 * Call when lighting settings change.
 */
export function updateSkyUniforms(settings: Partial<{
  hemisphereSkyColor: string;
  hemisphereGroundColor: string;
  sunColor: string;
  sunIntensity: number;
  sunAzimuth: number;
  sunElevation: number;
  moonColor: string;
  moonIntensity: number;
  moonAzimuth: number;
  moonElevation: number;
}>): void {
  if (!skyMaterial) return;
  
  const uniforms = skyMaterial.uniforms;
  
  // Update sky colors
  if (settings.hemisphereSkyColor !== undefined) {
    uniforms.uSkyColor.value.set(settings.hemisphereSkyColor);
    // Horizon is blend of sky and ground
    uniforms.uHorizonColor.value.copy(uniforms.uSkyColor.value)
      .lerp(uniforms.uGroundColor.value, 0.3);
  }
  
  if (settings.hemisphereGroundColor !== undefined) {
    uniforms.uGroundColor.value.set(settings.hemisphereGroundColor);
    // Update horizon blend
    uniforms.uHorizonColor.value.copy(uniforms.uSkyColor.value)
      .lerp(uniforms.uGroundColor.value, 0.3);
  }
  
  // Update sun
  if (settings.sunColor !== undefined) {
    uniforms.uSunColor.value.set(settings.sunColor);
  }
  
  if (settings.sunIntensity !== undefined) {
    // Normalize intensity for shader (0-1 range for glow)
    uniforms.uSunIntensity.value = Math.min(1.0, settings.sunIntensity / 3.0);
  }
  
  if (settings.sunAzimuth !== undefined || settings.sunElevation !== undefined) {
    const currentSettings = useGameStore.getState().environment;
    const azimuth = settings.sunAzimuth ?? currentSettings.sunAzimuth ?? 135;
    const elevation = settings.sunElevation ?? currentSettings.sunElevation ?? 45;
    uniforms.uSunDirection.value.copy(anglesToDirection(azimuth, elevation));
  }
  
  // Update moon
  if (settings.moonColor !== undefined) {
    uniforms.uMoonColor.value.set(settings.moonColor);
  }
  
  if (settings.moonIntensity !== undefined) {
    uniforms.uMoonIntensity.value = settings.moonIntensity;
  }
  
  if (settings.moonAzimuth !== undefined || settings.moonElevation !== undefined) {
    const currentSettings = useGameStore.getState().environment;
    const azimuth = settings.moonAzimuth ?? currentSettings.moonAzimuth ?? 315;
    const elevation = settings.moonElevation ?? currentSettings.moonElevation ?? -45;
    uniforms.uMoonDirection.value.copy(anglesToDirection(azimuth, elevation));
  }
}

/**
 * Update time uniform for star animation.
 * Call each frame.
 */
export function updateSkyTime(time: number): void {
  if (skyMaterial) {
    skyMaterial.uniforms.uTime.value = time;
  }
}

/**
 * Position sky dome at camera location.
 * Call each frame after camera moves.
 */
export function updateSkyDomePosition(cameraPosition: THREE.Vector3): void {
  if (skyDome) {
    skyDome.position.copy(cameraPosition);
  }
}

/**
 * Dispose of sky dome resources.
 */
export function disposeSkyDome(): void {
  const scene = getScene();
  
  if (skyDome && scene) {
    scene.remove(skyDome);
    skyDome.geometry.dispose();
    if (skyMaterial) {
      skyMaterial.dispose();
      skyMaterial = null;
    }
    skyDome = null;
  }
}

/**
 * Get the sky material for external access.
 */
export function getSkyMaterial(): THREE.ShaderMaterial | null {
  return skyMaterial;
}
