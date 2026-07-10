/**
 * QualityManager - Applies quality presets to all rendering systems
 *
 * The store's `quality` slice is the single source of truth for the active
 * QualitySettings. `applyQuality` writes that slice and pushes the settings to
 * the subsystems it owns imperatively (renderer, lighting, terrain/water
 * materials, visibility). The store-subscription-driven subsystems react on
 * their own: effects.ts (ssao/bloom/godrays/msaa/color-correction) and SkyDome
 * (god-ray sun disc) subscribe to `quality`.
 *
 * Individual `apply*()` helpers (used by the debug panel) update the `quality`
 * slice AND apply their field immediately.
 */

import * as THREE from 'three';
import {
  QualityLevel,
  QualitySettings,
  QUALITY_PRESETS,
  saveQualityLevel,
  saveVisibilityRadius,
} from './QualityPresets.js';
import { getActiveShadowLight, setMoonShadowsAllowed, updateShadowFrustumSize, applyEnvironmentSettings } from '../scene/Lighting.js';
import {
  setShaderMapDefines,
  setTerrainAnisotropy,
} from '../material/TerrainMaterial.js';
import { setWaterQualityLow } from '../material/WaterMaterial.js';
import { setGodRaysSamples } from '../scene/effects.js';
import { useGameStore } from '../../state/store.js';

// ============== Managed References ==============

/** Set by GameCore.init() */
let rendererRef: THREE.WebGLRenderer | null = null;

/** Callback set by VoxelWorld or GameCore to update visibility radius at runtime */
let visibilityRadiusCallback: ((radius: number) => void) | null = null;

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

// ============== Internal imperative appliers (no store writes) ==============

function pixelRatioImpl(maxRatio: number): void {
  if (rendererRef) {
    rendererRef.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio));
  }
}

function shadowsImpl(enabled: boolean): void {
  if (rendererRef) {
    rendererRef.shadowMap.enabled = enabled;
    rendererRef.shadowMap.needsUpdate = true;
  }
  const light = getActiveShadowLight();
  if (light) light.castShadow = enabled;
}

function shadowMapSizeImpl(size: number): void {
  // shadowMapSize still lives on the environment slice (the applied home);
  // the quality preset seeds it here.
  useGameStore.getState().setEnvironment({ shadowMapSize: size });
  applyEnvironmentSettings({ shadowMapSize: size });
}

function visibilityImpl(radius: number): void {
  if (visibilityRadiusCallback) visibilityRadiusCallback(radius);
}

// ============== Preset application ==============

/**
 * Apply a full quality preset.
 * `customVisibility` overrides the preset's visibility radius (separate slider).
 */
export function applyQuality(level: QualityLevel, customVisibility?: number): void {
  const preset = QUALITY_PRESETS[level];
  const settings: QualitySettings = {
    ...preset,
    visibilityRadius: customVisibility ?? preset.visibilityRadius,
  };

  // Single source of truth — this also drives the effects.ts / SkyDome
  // subscriptions (ssao/bloom/godrays/msaa/color-correction, sun disc).
  useGameStore.getState().setQuality(settings);

  // Subsystems this manager owns imperatively:
  pixelRatioImpl(settings.maxPixelRatio);
  shadowsImpl(settings.shadowsEnabled);
  setMoonShadowsAllowed(settings.moonShadows);
  shadowMapSizeImpl(settings.shadowMapSize);
  updateShadowFrustumSize(settings.shadowRadius);
  setShaderMapDefines({
    normalMaps: settings.shaderNormalMaps,
    aoMaps: settings.shaderAoMaps,
    metalnessMaps: settings.shaderMetalnessMaps,
  });
  setTerrainAnisotropy(settings.anisotropy);
  setWaterQualityLow(!settings.waterHighQuality);
  setGodRaysSamples(settings.godRaysSamples);
  visibilityImpl(settings.visibilityRadius);

  // Persist
  saveQualityLevel(level);
  if (customVisibility !== undefined) {
    saveVisibilityRadius(customVisibility);
  }

  console.log(`[Quality] Applied preset: ${level}`, {
    pixelRatio: Math.min(window.devicePixelRatio, settings.maxPixelRatio),
    shadows: settings.shadowsEnabled,
    shadowMap: settings.shadowMapSize,
    shadowRadius: settings.shadowRadius,
    msaa: settings.msaaSamples,
    ssao: settings.ssaoEnabled,
    bloom: settings.bloomEnabled,
    godRays: settings.godRaysEnabled,
    godRaysSamples: settings.godRaysSamples,
    colorCorrection: settings.colorCorrectionEnabled,
    visibility: settings.visibilityRadius,
    normalMaps: settings.shaderNormalMaps,
    aoMaps: settings.shaderAoMaps,
    metalness: settings.shaderMetalnessMaps,
    anisotropy: settings.anisotropy,
    moonShadows: settings.moonShadows,
  });
}

/**
 * Apply a quality preset and record the selected level. Single entry-point that
 * UI buttons and GameCore.init should call.
 */
export function syncQualityToStore(level: QualityLevel, customVisibility?: number): void {
  applyQuality(level, customVisibility);
  useGameStore.getState().setQualityLevel(level);
}

// ============== Individual Setting Appliers (debug panel) ==============
// Each updates the `quality` slice AND applies its field immediately.

export function applyPixelRatio(maxRatio: number): void {
  useGameStore.getState().updateQuality({ maxPixelRatio: maxRatio });
  pixelRatioImpl(maxRatio);
}

export function applyShadowsEnabled(enabled: boolean): void {
  useGameStore.getState().updateQuality({ shadowsEnabled: enabled });
  shadowsImpl(enabled);
}

export function applyMoonShadows(enabled: boolean): void {
  useGameStore.getState().updateQuality({ moonShadows: enabled });
  setMoonShadowsAllowed(enabled);
}

export function applySsaoEnabled(enabled: boolean): void {
  // effects.ts subscription applies it
  useGameStore.getState().updateQuality({ ssaoEnabled: enabled });
}

export function applyBloomEnabled(enabled: boolean): void {
  useGameStore.getState().updateQuality({ bloomEnabled: enabled });
}

export function applyColorCorrectionEnabled(enabled: boolean): void {
  useGameStore.getState().updateQuality({ colorCorrectionEnabled: enabled });
}

export function applyMsaaSamples(samples: number): void {
  useGameStore.getState().updateQuality({ msaaSamples: samples });
}

export function applyAnisotropy(value: number): void {
  useGameStore.getState().updateQuality({ anisotropy: value });
  setTerrainAnisotropy(value);
}

/** Apply just the visibility radius without changing quality level. */
export function applyVisibilityRadius(radius: number): void {
  useGameStore.getState().updateQuality({ visibilityRadius: radius });
  visibilityImpl(radius);
  saveVisibilityRadius(radius);
}

/** Apply shadow radius (shadow frustum + per-chunk castShadow culling). */
export function applyShadowRadius(radius: number): void {
  useGameStore.getState().updateQuality({ shadowRadius: radius });
  updateShadowFrustumSize(radius);
}

/** Current shadow radius in chunks. Used by VoxelWorld for castShadow culling. */
export function getShadowRadius(): number {
  return useGameStore.getState().quality.shadowRadius;
}

export function getCurrentSettings(): QualitySettings {
  return useGameStore.getState().quality;
}
