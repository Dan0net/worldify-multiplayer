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
import type { DerivedLighting } from '@worldify/shared';

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

uniform vec3 uSkyColor;         // zenith
uniform vec3 uHorizonColor;     // horizon band (authored per keyframe)
uniform vec3 uGroundColor;
uniform vec3 uSunDirection;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform float uSunSize;         // relative sun disc size (1 = base)
uniform vec3 uMoonDirection;
uniform vec3 uMoonColor;
uniform float uMoonIntensity;
uniform float uMoonSize;        // relative moon disc size (1 = base)
uniform float uTime;
uniform float uStarAngle;       // star-field rotation (radians) — tracks the moon
uniform float uStarLayers;      // quality lever: 5 = full, 2 = low/medium
uniform float uSunDiscEnabled;  // 1 when god rays are off (draw disc here), else 0

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
        
        // Falloff based on angular distance squared (lower constant = larger stars)
        float star = exp(-angularDistSq * scale * scale * 22.0) * brightness * twinkle;
        result += star;
      }
    }
  }
  
  return result;
}

float stars(vec3 dirIn, float time) {
  // Rotate the whole star field about the world Y axis so it sweeps with the moon.
  float ca = cos(uStarAngle), sa = sin(uStarAngle);
  vec3 dir = vec3(ca * dirIn.x + sa * dirIn.z, dirIn.y, -sa * dirIn.x + ca * dirIn.z);

  float result = 0.0;

  // Layer 1: Bright stars (rare) - 2x bigger, 2x denser
  result += starsLayer(dir, 30.0, 0.984, time, 0.5) * 1.3;

  // Layer 2: Medium stars
  result += starsLayer(dir, 100.0, 0.95, time, 1.0) * 0.9;

  // Layers 3-5 skipped on low/medium quality (each is 9 hash evals/pixel)
  if (uStarLayers < 3.0) return result;

  // Layer 3: Small stars
  result += starsLayer(dir, 150.0, 0.9, time, 2.0) * 0.6;

  // Layer 4: Tiny stars
  result += starsLayer(dir, 220.0, 0.85, time, 3.0) * 0.4;

  // Layer 5: Star dust
  result += starsLayer(dir, 320.0, 0.8, time, 4.0) * 0.3;

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

  // Horizon blend (smooth transition above/below horizon)
  float horizonBlend = smoothstep(-0.1, 0.1, altitude);

  // Sky colors — zenith↔horizon gradient; the horizon colour is authored per keyframe, so the
  // Sunrise/Sunset keyframes carry the two-tone twilight look directly (no separate blend).
  float tSky = pow(max(0.0, altitude), 0.5);
  vec3 skyAbove = mix(uHorizonColor, uSkyColor, tSky);

  // Ground colors
  float tGround = pow(max(0.0, -altitude), 0.4);
  vec3 skyBelow = mix(uHorizonColor, uGroundColor, tGround);
  
  // Final sky gradient
  vec3 sky = mix(skyBelow, skyAbove, horizonBlend) * skyDarkening;

  // Sun / moon discs.
  // When god rays are enabled (ultra/high) the god-rays sun mesh provides the
  // bright disc; when they're off (medium/low) draw the discs here so the sun
  // and moon are still visible. uSunDiscEnabled is set to !godRaysEnabled.
  if (uSunDiscEnabled > 0.5) {
    // Disc thresholds scale with size (larger size → lower thresholds → bigger disc).
    float sunInner = 1.0 - (1.0 - 0.996) * uSunSize;
    float sunOuter = 1.0 - (1.0 - 0.9985) * uSunSize;
    sky += celestialBody(worldDir, uSunDirection, uSunColor, uSunIntensity, sunInner, sunOuter, 4.0, 0.4);

    // Moon disc: opaque like the sun — gated by above-horizon visibility only (NOT the dim
    // moon light intensity), so it reads as a solid bluish disc at night.
    float moonAbove = smoothstep(-0.1, 0.1, uMoonDirection.y);
    float moonInner = 1.0 - (1.0 - 0.994) * uMoonSize;
    float moonOuter = 1.0 - (1.0 - 0.998) * uMoonSize;
    sky += celestialBody(worldDir, uMoonDirection, uMoonColor, moonAbove, moonInner, moonOuter, 8.0, 0.5);
    // Moon rim glow
    float moonAngle = dot(worldDir, uMoonDirection);
    sky += uMoonColor * smoothstep(moonInner - 0.004, moonInner, moonAngle) * (1.0 - smoothstep(moonInner, moonOuter, moonAngle)) * 0.3 * moonAbove;
  }

  // Sun horizon glow (only near sunset/sunrise)
  if (sunAltitude > -0.2 && sunAltitude < 0.3) {
    float glowStrength = pow(max(0.0, 1.0 - abs(sunAltitude - 0.05) / 0.25), 0.6);
    float horizonGlow = pow(max(0.0, 1.0 - abs(altitude) * 2.0), 2.0) * glowStrength * 0.5;
    vec3 sunXZ = normalize(vec3(uSunDirection.x, 0.0, uSunDirection.z));
    vec3 dirXZ = normalize(vec3(worldDir.x, 0.0, worldDir.z));
    horizonGlow *= pow(max(0.0, dot(dirXZ, sunXZ)), 1.5);
    sky += uSunColor * uSunIntensity * horizonGlow;
  }
  
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
let starLayersUnsub: (() => void) | null = null;

/** Star layers by quality: ultra/high get the full 5, medium/low get 2. */
function starLayersForQuality(): number {
  const level = useGameStore.getState().qualityLevel;
  return level === 'ultra' || level === 'high' ? 5 : 2;
}

/**
 * Draw the sun/moon discs in the sky shader only when god rays are OFF — with
 * god rays on, the god-rays sun mesh provides the disc (avoids a doubled disc).
 */
function sunDiscEnabledValue(): number {
  return useGameStore.getState().quality.godRaysEnabled ? 0 : 1;
}

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
  
  // Large inverted sphere - position vertices become the world direction. All colour/direction
  // uniforms below are placeholders — applyDerivedLighting() seeds them right after init.
  const geometry = new THREE.SphereGeometry(500, 64, 32);

  skyMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uSkyColor: { value: new THREE.Color('#87ceeb') },
      uHorizonColor: { value: new THREE.Color('#bfe3f5') },
      uGroundColor: { value: new THREE.Color('#3d5c3d') },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color('#ffcc00') },
      uSunIntensity: { value: 1.0 },
      uSunSize: { value: 1.0 },
      uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
      uMoonColor: { value: new THREE.Color('#aabbdd') },
      uMoonIntensity: { value: 0.0 },
      uMoonSize: { value: 0.5 },
      uTime: { value: 0.0 },
      uStarAngle: { value: 0.0 },
      uStarLayers: { value: starLayersForQuality() },
      uSunDiscEnabled: { value: sunDiscEnabledValue() },
    },
    side: THREE.BackSide,
    depthWrite: false,
  });

  // Update star LOD + sun-disc visibility live when quality / god rays change.
  starLayersUnsub?.();
  starLayersUnsub = useGameStore.subscribe((state, prev) => {
    if (!skyMaterial) return;
    if (state.qualityLevel !== prev.qualityLevel) {
      skyMaterial.uniforms.uStarLayers.value = starLayersForQuality();
    }
    if (state.quality.godRaysEnabled !== prev.quality.godRaysEnabled) {
      skyMaterial.uniforms.uSunDiscEnabled.value = sunDiscEnabledValue();
    }
  });
  
  skyMesh = new THREE.Mesh(geometry, skyMaterial);
  skyMesh.renderOrder = -1000;
  scene.add(skyMesh);

  scene.background = null;
  // Uniforms are seeded by applyDerivedLighting() immediately after initLighting().

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
 * Update all sky dome uniforms from the derived day-night lighting. The horizon colour is now
 * authored (per keyframe), not derived from sky↔ground. Star field rotates with the moon.
 */
export function updateSkyUniforms(d: DerivedLighting): void {
  if (!skyMaterial) return;
  const u = skyMaterial.uniforms;

  u.uSkyColor.value.set(d.skyZenithColor);
  u.uHorizonColor.value.set(d.skyHorizonColor);
  u.uGroundColor.value.set(d.groundColor);

  u.uSunColor.value.set(d.sunColor);
  u.uSunIntensity.value = Math.min(1.0, d.sunIntensity / 3.0);
  u.uSunSize.value = d.sunSize;
  u.uSunDirection.value.copy(anglesToDirection(d.sunAzimuth, d.sunElevation));

  u.uMoonColor.value.set(d.moonColor);
  u.uMoonIntensity.value = d.moonIntensity;
  u.uMoonSize.value = d.moonSize;
  u.uMoonDirection.value.copy(anglesToDirection(d.moonAzimuth, d.moonElevation));

  // Stars rotate with the moon's azimuth.
  u.uStarAngle.value = (d.moonAzimuth * Math.PI) / 180;
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

  starLayersUnsub?.();
  starLayersUnsub = null;

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
