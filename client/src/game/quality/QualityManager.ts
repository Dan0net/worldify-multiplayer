/**
 * QualityManager - Applies quality presets to all rendering systems
 *
 * Centralises the wiring between QualityPresets and:
 * - WebGLRenderer (pixel ratio, shadows, antialias flag)
 * - Post-processing (SSAO, bloom, color correction)
 * - Lighting (shadow map size, moon shadows)
 * - TerrainMaterial (shader map defines)
 * - VoxelWorld (visibility radius)
 *
 * Call `applyQuality()` whenever the quality level changes.
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
import { getMoonLight, getSunLight } from '../scene/Lighting.js';
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
  if (rendererRef) {
    rendererRef.setPixelRatio(Math.min(window.devicePixelRatio, preset.maxPixelRatio));

    rendererRef.shadowMap.enabled = preset.shadowsEnabled;
    if (!preset.shadowsEnabled) {
      // Need to invalidate all shadow maps
      rendererRef.shadowMap.needsUpdate = true;
    }
  }

  // --- Shadows ---
  const sun = getSunLight();
  if (sun) {
    sun.castShadow = preset.shadowsEnabled;
    if (sun.shadow.mapSize.width !== preset.shadowMapSize) {
      sun.shadow.mapSize.width = preset.shadowMapSize;
      sun.shadow.mapSize.height = preset.shadowMapSize;
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
  }
  const moon = getMoonLight();
  if (moon) {
    moon.castShadow = preset.shadowsEnabled && preset.moonShadows;
    if (moon.shadow.mapSize.width !== preset.shadowMapSize) {
      moon.shadow.mapSize.width = preset.shadowMapSize;
      moon.shadow.mapSize.height = preset.shadowMapSize;
      moon.shadow.map?.dispose();
      moon.shadow.map = null;
    }
  }

  // --- Post-processing ---
  updatePostProcessing({
    enabled: preset.postProcessingEnabled,
    ssaoEnabled: preset.ssaoEnabled,
    bloomEnabled: preset.bloomEnabled,
  });

  // --- Terrain material shader maps ---
  setShaderMapDefines({
    normalMaps: preset.shaderNormalMaps,
    aoMaps: preset.shaderAoMaps,
    metalnessMaps: preset.shaderMetalnessMaps,
  });
  setTerrainAnisotropy(preset.anisotropy);

  // --- Visibility radius ---
  if (visibilityRadiusCallback) {
    visibilityRadiusCallback(effectiveVisibility);
  }

  // Persist
  saveQualityLevel(level);
  if (customVisibility !== undefined) {
    saveVisibilityRadius(customVisibility);
  }

  console.log(`[Quality] Applied preset: ${level}`, {
    pixelRatio: Math.min(window.devicePixelRatio, preset.maxPixelRatio),
    shadows: preset.shadowsEnabled,
    shadowMap: preset.shadowMapSize,
    postfx: preset.postProcessingEnabled,
    ssao: preset.ssaoEnabled,
    bloom: preset.bloomEnabled,
    visibility: effectiveVisibility,
    normalMaps: preset.shaderNormalMaps,
    aoMaps: preset.shaderAoMaps,
    metalness: preset.shaderMetalnessMaps,
    anisotropy: preset.anisotropy,
  });
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
  saveVisibilityRadius(radius);
}

export function getCurrentSettings(): QualitySettings | null {
  return currentSettings;
}
