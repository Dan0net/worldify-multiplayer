/**
 * Procedural Sky Dome
 * 
 * Uses an inverted sphere with a custom shader for the sky.
 * The star field uses 3D cell-based hashing for uniform distribution.
 * 
 * Features:
 * - Sky gradient matching hemisphere light colors
 * - Sun disc with soft glow
 * - Moon disc with subtle glow
 * - Dense animated twinkling stars with 3D cell hashing
 */

import * as THREE from 'three';
import { getScene } from './scene';
import { useGameStore } from '../../state/store';

// ============== Shader Code ==============

const vertexShader = /* glsl */ `
varying vec3 vWorldDirection;

void main() {
  // For a sphere centered at origin, position IS the direction
  vWorldDirection = normalize(position);
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

varying vec3 vWorldDirection;

// ============== Noise Functions ==============

// Simple 2D hash
float hash2(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract(p.x * p.y);
}

vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(443.897, 441.423, 437.195));
  p3 += dot(p3, p3.yzx + 19.19);
  return fract((p3.xx + p3.yz) * p3.zy);
}

// ============== Octahedron Mapping ==============

// Maps a 3D direction to 2D octahedron UV (no pole distortion)
vec2 octEncode(vec3 n) {
  n /= (abs(n.x) + abs(n.y) + abs(n.z));
  if (n.y < 0.0) {
    n.xz = (1.0 - abs(n.zx)) * vec2(n.x >= 0.0 ? 1.0 : -1.0, n.z >= 0.0 ? 1.0 : -1.0);
  }
  return n.xz * 0.5 + 0.5;
}

// Decode octahedron UV back to 3D direction
vec3 octDecode(vec2 f) {
  f = f * 2.0 - 1.0;
  vec3 n = vec3(f.x, 1.0 - abs(f.x) - abs(f.y), f.y);
  float t = max(-n.y, 0.0);
  n.x += n.x >= 0.0 ? -t : t;
  n.z += n.z >= 0.0 ? -t : t;
  return normalize(n);
}

// ============== Star Field ==============

float starsLayer(vec3 dir, float scale, float density, float time, float twinkleSpeed) {
  // Use octahedron mapping for cell lookup only
  vec2 uv = octEncode(dir) * scale;
  vec2 cellId = floor(uv);
  vec2 cellUv = fract(uv);
  
  float result = 0.0;
  
  // Check 3x3 neighborhood for stars
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      vec2 neighbor = cellId + vec2(float(x), float(y));
      vec2 starHash = hash22(neighbor);
      
      // Density check
      if (starHash.x > density) {
        // Get star position in UV space, then convert back to 3D direction
        vec2 starUv = (neighbor + starHash) / scale;
        vec3 starDir = octDecode(starUv);
        
        // Compute angular distance in 3D (rotation invariant, perfect circles)
        float angularDist = acos(clamp(dot(dir, starDir), -1.0, 1.0));
        
        // Very small, sharp stars
        float brightness = (starHash.x - density) / (1.0 - density);
        float twinkle = 0.5 + 0.5 * sin(time * twinkleSpeed + starHash.y * 628.0);
        
        // Sharp falloff based on angular distance (in radians)
        // Multiply by scale to keep star size consistent across layers
        float star = exp(-angularDist * angularDist * scale * scale * 50.0) * brightness * twinkle;
        result += star;
      }
    }
  }
  
  return result;
}

float stars(vec3 dir, float time) {
  float result = 0.0;
  
  // Layer 1: Bright stars (rare) - 2x bigger, 2x denser
  result += starsLayer(dir, 30.0, 0.984, time, 0.5) * 1.0;
  
  // Layer 2: Medium stars
  result += starsLayer(dir, 100.0, 0.95, time, 1.0) * 0.7;
  
  // Layer 3: Small stars
  result += starsLayer(dir, 150.0, 0.9, time, 2.0) * 0.5;
  
  // Layer 4: Tiny stars
  result += starsLayer(dir, 220.0, 0.85, time, 3.0) * 0.35;
  
  // Layer 5: Star dust
  result += starsLayer(dir, 320.0, 0.8, time, 4.0) * 0.25;
  
  return result;
}

// ============== Main ==============

void main() {
  vec3 worldDir = normalize(vWorldDirection);
  float altitude = worldDir.y;
  
  // Get sun altitude for atmospheric calculations
  float sunAltitude = uSunDirection.y;
  
  // === Sky Gradient with atmospheric scattering ===
  vec3 sky;
  
  // Calculate how much to darken the sky (night = darker, day = normal)
  float nightFactor = smoothstep(0.1, -0.2, sunAltitude);
  float skyDarkening = mix(1.0, 0.08, nightFactor);
  
  // Dawn/dusk atmospheric colors
  float dawnDusk = 1.0 - abs(sunAltitude) / 0.3;
  dawnDusk = max(0.0, dawnDusk);
  dawnDusk = pow(dawnDusk, 0.7);
  
  // Warm sunset colors
  vec3 sunsetHorizon = vec3(1.0, 0.4, 0.15);
  vec3 sunsetZenith = vec3(0.3, 0.2, 0.5);
  
  // Smooth blend across horizon
  float horizonBlend = smoothstep(-0.1, 0.1, altitude);
  
  // Sky above
  float tSky = pow(max(0.0, altitude), 0.5);
  vec3 skyAbove = mix(uHorizonColor, uSkyColor, tSky);
  vec3 sunsetGradient = mix(sunsetHorizon, sunsetZenith, pow(max(0.0, altitude), 0.4));
  skyAbove = mix(skyAbove, sunsetGradient, dawnDusk * 0.7);
  
  // Ground below
  float tGround = pow(max(0.0, -altitude), 0.4);
  vec3 skyBelow = mix(uHorizonColor, uGroundColor, tGround);
  
  // Blend
  sky = mix(skyBelow, skyAbove, horizonBlend);
  sky *= skyDarkening;
  
  // === Sun ===
  float sunAngle = dot(worldDir, uSunDirection);
  float sunDisc = smoothstep(0.996, 0.9985, sunAngle);
  float sunGlow = pow(max(0.0, sunAngle), 4.0) * 0.4;
  
  float horizonGlow = 0.0;
  if (sunAltitude > -0.2 && sunAltitude < 0.3) {
    float glowStrength = 1.0 - abs(sunAltitude - 0.05) / 0.25;
    glowStrength = pow(max(0.0, glowStrength), 0.6);
    horizonGlow = pow(max(0.0, 1.0 - abs(altitude) * 2.0), 2.0) * glowStrength * 0.5;
    float towardSun = pow(max(0.0, dot(normalize(vec3(worldDir.x, 0.0, worldDir.z)), 
                                        normalize(vec3(uSunDirection.x, 0.0, uSunDirection.z)))), 1.5);
    horizonGlow *= towardSun;
  }
  
  vec3 sunContrib = uSunColor * uSunIntensity * (sunDisc * 2.0 + sunGlow + horizonGlow);
  sky += sunContrib;
  
  // === Moon ===
  float moonAngle = dot(worldDir, uMoonDirection);
  float moonDisc = smoothstep(0.994, 0.998, moonAngle);
  float moonGlow = pow(max(0.0, moonAngle), 8.0) * 0.4;
  float moonRim = smoothstep(0.99, 0.994, moonAngle) * (1.0 - moonDisc) * 0.3;
  
  float moonVisible = smoothstep(-0.1, 0.1, uMoonDirection.y) * uMoonIntensity;
  vec3 moonContrib = uMoonColor * (moonDisc * 1.0 + moonGlow + moonRim) * moonVisible;
  sky += moonContrib;
  
  // === Stars ===
  float starsVisible = smoothstep(0.0, -0.15, sunAltitude);
  
  if (starsVisible > 0.0) {
    float starField = stars(worldDir, uTime);
    sky += vec3(1.0, 0.97, 0.92) * starField * starsVisible * 1.2;
  }
  
  gl_FragColor = vec4(sky, 1.0);
}
`;

// ============== Module State ==============

let skyMesh: THREE.Mesh | null = null;
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
  
  // Large inverted sphere - position vertices become the world direction
  const geometry = new THREE.SphereGeometry(500, 64, 32);
  const settings = useGameStore.getState().environment;
  
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
    side: THREE.BackSide,  // Render inside of sphere
    depthWrite: false,
  });
  
  skyMesh = new THREE.Mesh(geometry, skyMaterial);
  skyMesh.renderOrder = -1000; // Render first (behind everything)
  scene.add(skyMesh);
  
  scene.background = null;
  
  updateSkyUniforms(settings);
  
  console.log('[SkyDome] Initialized procedural sky dome');
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
 * Update sky dome position to follow camera.
 * Call each frame after camera updates.
 */
export function updateSkyCamera(camera: THREE.Camera): void {
  if (skyMesh) {
    // Keep sky dome centered on camera
    skyMesh.position.copy(camera.position);
  }
}

/**
 * @deprecated Use updateSkyCamera instead. Kept for backwards compatibility.
 */
export function updateSkyDomePosition(cameraPosition: THREE.Vector3): void {
  if (skyMesh) {
    skyMesh.position.copy(cameraPosition);
  }
}

/**
 * Dispose of sky resources.
 */
export function disposeSkyDome(): void {
  const scene = getScene();
  
  if (skyMesh && scene) {
    scene.remove(skyMesh);
    skyMesh.geometry.dispose();
    if (skyMaterial) {
      skyMaterial.dispose();
      skyMaterial = null;
    }
    skyMesh = null;
  }
}

/**
 * Get the sky material for external access.
 */
export function getSkyMaterial(): THREE.ShaderMaterial | null {
  return skyMaterial;
}
