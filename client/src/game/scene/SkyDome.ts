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
uniform vec3 uSunsetHorizonColor;
uniform vec3 uSunsetZenithColor;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uMoonDirection;
uniform vec3 uMoonColor;
uniform float uMoonIntensity;
uniform float uTime;

varying vec3 vWorldDirection;

// ============== Hash Function ==============

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
        
        // Angular distance approximation: 1 - dot² ≈ sin²(angle) (faster than acos)
        float d = dot(dir, starDir);
        float angularDistSq = 1.0 - d * d;
        
        // Star brightness with twinkle
        float brightness = (starHash.x - density) / (1.0 - density);
        float twinkle = 0.5 + 0.5 * sin(time * twinkleSpeed + starHash.y * 628.0);
        
        // Sharp falloff based on angular distance squared
        float star = exp(-angularDistSq * scale * scale * 50.0) * brightness * twinkle;
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

// ============== Celestial Body Helper ==============

// Renders a disc with glow (reused for sun and moon)
vec3 celestialBody(vec3 viewDir, vec3 bodyDir, vec3 color, float intensity, 
                   float discInner, float discOuter, float glowPower, float glowStrength) {
  float angle = dot(viewDir, bodyDir);
  float disc = smoothstep(discInner, discOuter, angle);
  float glow = pow(max(0.0, angle), glowPower) * glowStrength;
  return color * intensity * (disc + glow);
}

// ============== Main ==============

void main() {
  vec3 worldDir = normalize(vWorldDirection);
  float altitude = worldDir.y;
  float sunAltitude = uSunDirection.y;
  
  // === Sky Gradient ===
  // Night darkening factor
  float nightFactor = smoothstep(0.1, -0.2, sunAltitude);
  float skyDarkening = mix(1.0, 0.08, nightFactor);
  
  // Dawn/dusk blend factor (peaks at sunset/sunrise)
  float dawnDusk = pow(max(0.0, 1.0 - abs(sunAltitude) / 0.3), 0.7);
  
  // Horizon blend (smooth transition above/below horizon)
  float horizonBlend = smoothstep(-0.1, 0.1, altitude);
  
  // Sky colors
  float tSky = pow(max(0.0, altitude), 0.5);
  vec3 skyAbove = mix(uHorizonColor, uSkyColor, tSky);
  vec3 sunsetGradient = mix(uSunsetHorizonColor, uSunsetZenithColor, pow(max(0.0, altitude), 0.4));
  skyAbove = mix(skyAbove, sunsetGradient, dawnDusk * 0.7);
  
  // Ground colors
  float tGround = pow(max(0.0, -altitude), 0.4);
  vec3 skyBelow = mix(uHorizonColor, uGroundColor, tGround);
  
  // Final sky gradient
  vec3 sky = mix(skyBelow, skyAbove, horizonBlend) * skyDarkening;
  
  // === Sun ===
  sky += celestialBody(worldDir, uSunDirection, uSunColor, uSunIntensity, 0.996, 0.9985, 4.0, 0.4);
  
  // Sun horizon glow (only near sunset/sunrise)
  if (sunAltitude > -0.2 && sunAltitude < 0.3) {
    float glowStrength = pow(max(0.0, 1.0 - abs(sunAltitude - 0.05) / 0.25), 0.6);
    float horizonGlow = pow(max(0.0, 1.0 - abs(altitude) * 2.0), 2.0) * glowStrength * 0.5;
    vec3 sunXZ = normalize(vec3(uSunDirection.x, 0.0, uSunDirection.z));
    vec3 dirXZ = normalize(vec3(worldDir.x, 0.0, worldDir.z));
    horizonGlow *= pow(max(0.0, dot(dirXZ, sunXZ)), 1.5);
    sky += uSunColor * uSunIntensity * horizonGlow;
  }
  
  // === Moon ===
  float moonVisible = smoothstep(-0.1, 0.1, uMoonDirection.y) * uMoonIntensity;
  sky += celestialBody(worldDir, uMoonDirection, uMoonColor, moonVisible, 0.994, 0.998, 8.0, 0.4);
  // Moon rim glow
  float moonAngle = dot(worldDir, uMoonDirection);
  sky += uMoonColor * smoothstep(0.99, 0.994, moonAngle) * (1.0 - smoothstep(0.994, 0.998, moonAngle)) * 0.3 * moonVisible;
  
  // === Stars ===
  float starsVisible = smoothstep(0.0, -0.15, sunAltitude);
  if (starsVisible > 0.0) {
    sky += vec3(1.0, 0.97, 0.92) * stars(worldDir, uTime) * starsVisible * 1.2;
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
      uHorizonColor: { value: new THREE.Color('#87ceeb') },
      uGroundColor: { value: new THREE.Color(settings.hemisphereGroundColor ?? '#3d5c3d') },
      uSunsetHorizonColor: { value: new THREE.Color(settings.sunsetHorizonColor ?? '#ff6622') },
      uSunsetZenithColor: { value: new THREE.Color(settings.sunsetZenithColor ?? '#4d3380') },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(settings.sunColor ?? '#ffcc00') },
      uSunIntensity: { value: 1.0 },
      uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
      uMoonColor: { value: new THREE.Color(settings.moonColor ?? '#aabbdd') },
      uMoonIntensity: { value: 0.0 },
      uTime: { value: 0.0 },
    },
    side: THREE.BackSide,
    depthWrite: false,
  });
  
  // Compute initial horizon color
  updateHorizonColor();
  
  skyMesh = new THREE.Mesh(geometry, skyMaterial);
  skyMesh.renderOrder = -1000;
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
 * Recompute horizon color from sky and ground colors (DRY helper).
 */
function updateHorizonColor(): void {
  if (!skyMaterial) return;
  const uniforms = skyMaterial.uniforms;
  uniforms.uHorizonColor.value
    .copy(uniforms.uSkyColor.value)
    .lerp(uniforms.uGroundColor.value, 0.3);
}

/**
 * Update sky dome uniforms from environment settings.
 */
export function updateSkyUniforms(settings: Partial<{
  hemisphereSkyColor: string;
  hemisphereGroundColor: string;
  sunsetHorizonColor: string;
  sunsetZenithColor: string;
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
  let needsHorizonUpdate = false;
  
  // Sky colors
  if (settings.hemisphereSkyColor !== undefined) {
    uniforms.uSkyColor.value.set(settings.hemisphereSkyColor);
    needsHorizonUpdate = true;
  }
  
  if (settings.hemisphereGroundColor !== undefined) {
    uniforms.uGroundColor.value.set(settings.hemisphereGroundColor);
    needsHorizonUpdate = true;
  }
  
  if (needsHorizonUpdate) {
    updateHorizonColor();
  }
  
  // Sunset colors
  if (settings.sunsetHorizonColor !== undefined) {
    uniforms.uSunsetHorizonColor.value.set(settings.sunsetHorizonColor);
  }
  
  if (settings.sunsetZenithColor !== undefined) {
    uniforms.uSunsetZenithColor.value.set(settings.sunsetZenithColor);
  }
  
  // Sun
  if (settings.sunColor !== undefined) {
    uniforms.uSunColor.value.set(settings.sunColor);
  }
  
  if (settings.sunIntensity !== undefined) {
    uniforms.uSunIntensity.value = Math.min(1.0, settings.sunIntensity / 3.0);
  }
  
  if (settings.sunAzimuth !== undefined || settings.sunElevation !== undefined) {
    const currentSettings = useGameStore.getState().environment;
    const azimuth = settings.sunAzimuth ?? currentSettings.sunAzimuth ?? 135;
    const elevation = settings.sunElevation ?? currentSettings.sunElevation ?? 45;
    uniforms.uSunDirection.value.copy(anglesToDirection(azimuth, elevation));
  }
  
  // Moon
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
 */
export function updateSkyTime(time: number): void {
  if (skyMaterial) {
    skyMaterial.uniforms.uTime.value = time;
  }
}

/**
 * Update sky dome position to follow camera.
 */
export function updateSkyCamera(camera: THREE.Camera): void {
  if (skyMesh) {
    skyMesh.position.copy(camera.position);
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
