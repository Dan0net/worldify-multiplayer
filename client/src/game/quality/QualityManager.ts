/**
 * QualityManager - Applies quality presets to all rendering systems
 *
 * Centralises the wiring between QualityPresets and:
 * - WebGLRenderer (pixel ratio, shadows, antialias flag)
 * - Post-processing (SSAO, bloom, color correction)
 * - Lighting (shadow map size via environment settings, moon shadow eligibility)
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
import { updatePostProcessing, updateMsaaSamples } from '../scene/postprocessing.js';
import { getActiveShadowLight, setMoonShadowsAllowed, updateShadowFrustumSize, applyEnvironmentSettings } from '../scene/Lighting.js';
import {
  setShaderMapDefines,
  setTerrainAnisotropy,
} from '../material/TerrainMaterial.js';
import { storeBridge } from '../../state/bridge.js';

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

export function getRendererRef(): THREE.WebGLRenderer | null {
  return rendererRef;
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
  applyMoonShadows(preset.moonShadows);

  // --- Shadow map size (routed through environment settings) ---
  storeBridge.setEnvironment({ shadowMapSize: preset.shadowMapSize });
  applyEnvironmentSettings({ shadowMapSize: preset.shadowMapSize });

  // --- Shadow frustum (uses shadow-specific radius, not visibility) ---
  updateShadowFrustumSize(preset.shadowRadius);

  // --- MSAA ---
  applyMsaaSamples(preset.msaaSamples);

  // --- Post-processing ---
  applySsaoEnabled(preset.ssaoEnabled);
  applyBloomEnabled(preset.bloomEnabled);
  applyColorCorrectionEnabled(preset.colorCorrectionEnabled);

  // --- Terrain material shader maps ---
  setShaderMapDefines({
    normalMaps: preset.shaderNormalMaps,
    aoMaps: preset.shaderAoMaps,
    metalnessMaps: preset.shaderMetalnessMaps,
    reducedTriplanar: preset.shaderReducedTriplanar,
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
    shadowRadius: preset.shadowRadius,
    msaa: preset.msaaSamples,
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

/**
 * Apply a quality preset AND sync every individual setting to the Zustand store.
 * This is the single entry-point that UI buttons and GameCore.init should call
 * so the store always mirrors the active rendering state.
 */
export function syncQualityToStore(level: QualityLevel, customVisibility?: number): void {
  const preset = QUALITY_PRESETS[level];
  const vis = customVisibility ?? preset.visibilityRadius;
  applyQuality(level, vis);
  storeBridge.setQualityLevel(level);
  storeBridge.setVisibilityRadius(vis);
  storeBridge.setSsaoEnabled(preset.ssaoEnabled);
  storeBridge.setBloomEnabled(preset.bloomEnabled);
  storeBridge.setColorCorrectionEnabled(preset.colorCorrectionEnabled);
  storeBridge.setShadowsEnabled(preset.shadowsEnabled);
  storeBridge.setMoonShadows(preset.moonShadows);
  storeBridge.setShadowRadius(preset.shadowRadius);
  storeBridge.setAnisotropy(preset.anisotropy);
  storeBridge.setMaxPixelRatio(preset.maxPixelRatio);
  storeBridge.setMsaaSamples(preset.msaaSamples);
  storeBridge.setShaderNormalMaps(preset.shaderNormalMaps);
  storeBridge.setShaderAoMaps(preset.shaderAoMaps);
  storeBridge.setShaderMetalnessMaps(preset.shaderMetalnessMaps);
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

export function applyMsaaSamples(samples: number): void {
  updateMsaaSamples(samples);
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

/**
 * Apply shadow radius (controls shadow frustum AND per-chunk castShadow culling).
 */
export function applyShadowRadius(radius: number): void {
  if (currentSettings) {
    currentSettings.shadowRadius = radius;
  }
  updateShadowFrustumSize(radius);
}

/**
 * Get the current shadow radius in chunks.
 * Used by VoxelWorld for per-chunk castShadow distance culling.
 */
export function getShadowRadius(): number {
  return currentSettings?.shadowRadius ?? 4;
}

export function getCurrentSettings(): QualitySettings | null {
  return currentSettings;
}
