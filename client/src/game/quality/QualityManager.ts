/**
 * QualityManager - Applies quality presets to all rendering systems
 *
 * Centralises the wiring between QualityPresets and:
 * - WebGLRenderer (pixel ratio, shadows, antialias flag)
 * - Post-processing (SSAO, bloom, color correction)
 * - Lighting (shadow map size, moon shadow eligibility)
 * - TerrainMaterial (shader map defines, anisotropy)
 * - VoxelWorld (visibility radius)
 *
 * Call `applyQuality()` for a full preset, or individual `apply*()` for
 * fine-grained control from the debug panel.
 */

import * as THREE from 'three';
import {
  QualityLevel,
  QualitySettings,
  QUALITY_PRESETS,
  saveQualityLevel,
  saveVisibilityRadius,
} from './QualityPresets.js';
import { updatePostProcessing } from '../scene/postprocessing.js';
import { getActiveShadowLight, setMoonShadowsAllowed, getSunLight, getMoonLight, updateShadowFrustumSize } from '../scene/Lighting.js';
import {
  setShaderMapDefines,
  setTerrainAnisotropy,
} from '../material/TerrainMaterial.js';

// ============== Managed References ==============

/** Set by GameCore.init() */
let rendererRef: THREE.WebGLRenderer | null = null;

/** Callback set by VoxelWorld or GameCore to update visibility radius at runtime */
let visibilityRadiusCallback: ((radius: number) => void) | null = null;

/** Current effective quality settings (may have custom visibility) */
let currentSettings: QualitySettings | null = null;

// ============== Public API ==============

export function setRendererRef(r: THREE.WebGLRenderer): void {
  rendererRef = r;
}

export function setVisibilityRadiusCallback(cb: (radius: number) => void): void {
  visibilityRadiusCallback = cb;
}

/**
 * Apply a full quality preset.
 * `customVisibility` overrides the preset's visibility radius (for the separate slider).
 */
export function applyQuality(level: QualityLevel, customVisibility?: number): void {
  const preset = QUALITY_PRESETS[level];
  currentSettings = { ...preset };

  // Override visibility if custom value provided
  const effectiveVisibility = customVisibility ?? preset.visibilityRadius;
  currentSettings.visibilityRadius = effectiveVisibility;

  // --- Renderer ---
  applyPixelRatio(preset.maxPixelRatio);
  applyShadowsEnabled(preset.shadowsEnabled);
  applyShadowMapSize(preset.shadowMapSize);
  applyMoonShadows(preset.moonShadows);

  // --- Post-processing ---
  applySsaoEnabled(preset.ssaoEnabled);
  applyBloomEnabled(preset.bloomEnabled);
  applyColorCorrectionEnabled(preset.colorCorrectionEnabled);

  // --- Terrain material shader maps ---
  setShaderMapDefines({
    normalMaps: preset.shaderNormalMaps,
    aoMaps: preset.shaderAoMaps,
    metalnessMaps: preset.shaderMetalnessMaps,
  });
  applyAnisotropy(preset.anisotropy);

  // --- Visibility radius ---
  applyVisibilityRadius(effectiveVisibility);

  // Persist
  saveQualityLevel(level);
  if (customVisibility !== undefined) {
    saveVisibilityRadius(customVisibility);
  }

  console.log(`[Quality] Applied preset: ${level}`, {
    pixelRatio: Math.min(window.devicePixelRatio, preset.maxPixelRatio),
    shadows: preset.shadowsEnabled,
    shadowMap: preset.shadowMapSize,
    ssao: preset.ssaoEnabled,
    bloom: preset.bloomEnabled,
    colorCorrection: preset.colorCorrectionEnabled,
    visibility: effectiveVisibility,
    normalMaps: preset.shaderNormalMaps,
    aoMaps: preset.shaderAoMaps,
    metalness: preset.shaderMetalnessMaps,
    anisotropy: preset.anisotropy,
    moonShadows: preset.moonShadows,
  });
}

// ============== Individual Setting Appliers ==============

export function applyPixelRatio(maxRatio: number): void {
  if (rendererRef) {
    rendererRef.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio));
  }
}

export function applyShadowsEnabled(enabled: boolean): void {
  if (rendererRef) {
    rendererRef.shadowMap.enabled = enabled;
    rendererRef.shadowMap.needsUpdate = true;
  }
  // The active shadow caster light is managed by Lighting.ts
  const light = getActiveShadowLight();
  if (light) {
    light.castShadow = enabled;
  }
}

export function applyShadowMapSize(size: number): void {
  // Size 0 means shadows off - handled by applyShadowsEnabled
  if (size <= 0) return;
  
  // Update both lights so the shadow config is correct after a swap
  for (const light of [getSunLight(), getMoonLight()]) {
    if (light && light.shadow.mapSize.width !== size) {
      light.shadow.mapSize.width = size;
      light.shadow.mapSize.height = size;
      light.shadow.map?.dispose();
      light.shadow.map = null;
    }
  }
}

export function applyMoonShadows(enabled: boolean): void {
  // Tell Lighting.ts whether moon is eligible to become the shadow caster
  setMoonShadowsAllowed(enabled);
  if (currentSettings) {
    currentSettings.moonShadows = enabled;
  }
}

export function applySsaoEnabled(enabled: boolean): void {
  updatePostProcessing({ ssaoEnabled: enabled });
}

export function applyBloomEnabled(enabled: boolean): void {
  updatePostProcessing({ bloomEnabled: enabled });
}

export function applyColorCorrectionEnabled(enabled: boolean): void {
  updatePostProcessing({ colorCorrectionEnabled: enabled });
}

export function applyAnisotropy(value: number): void {
  setTerrainAnisotropy(value);
}

/**
 * Apply just the visibility radius without changing quality level.
 */
export function applyVisibilityRadius(radius: number): void {
  if (currentSettings) {
    currentSettings.visibilityRadius = radius;
  }
  if (visibilityRadiusCallback) {
    visibilityRadiusCallback(radius);
  }
  // Tighten shadow frustum to match new visibility
  updateShadowFrustumSize(radius);
  saveVisibilityRadius(radius);
}

export function getCurrentSettings(): QualitySettings | null {
  return currentSettings;
}
