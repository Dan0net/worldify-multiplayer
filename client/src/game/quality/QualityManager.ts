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
  snapViewDistance,
  saveQualityLevel,
  saveVisibilityRadius,
  saveFarViewRings,
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

/** Callback set by GameCore to update the Explore far-view ring count at runtime */
let farViewRingsCallback: ((rings: number) => void) | null = null;

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

export function setFarViewRingsCallback(cb: (rings: number) => void): void {
  farViewRingsCallback = cb;
}

// ============== Internal imperative appliers (no store writes) ==============

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

function farViewImpl(rings: number): void {
  if (farViewRingsCallback) farViewRingsCallback(rings);
}

// ============== Preset application ==============

/**
 * Apply a full quality preset.
 * `customVisibility` overrides the preset's visibility radius (separate slider).
 */
export function applyQuality(level: QualityLevel, customVisibility?: number, customFarView?: number): void {
  const preset = QUALITY_PRESETS[level];
  const settings: QualitySettings = {
    ...preset,
    // Snap a persisted custom radius (possibly from an older 2/4/6/8 build) into the current set.
    visibilityRadius: customVisibility !== undefined
      ? snapViewDistance(customVisibility)
      : preset.visibilityRadius,
    // Far-view rings are a per-device view pref, preserved across preset changes like visibilityRadius.
    farViewRings: customFarView !== undefined ? customFarView : preset.farViewRings,
  };

  // Single source of truth — this also drives the effects.ts / SkyDome
  // subscriptions (ssao/bloom/godrays/msaa/color-correction, sun disc).
  useGameStore.getState().setQuality(settings);

  // Subsystems this manager owns imperatively:
  shadowsImpl(settings.shadowsEnabled);
  setMoonShadowsAllowed(settings.shadowsEnabled); // moon casts whenever shadows are on (unified with sun)
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
  farViewImpl(settings.farViewRings);

  // Persist
  saveQualityLevel(level);
  if (customVisibility !== undefined) {
    saveVisibilityRadius(customVisibility);
  }
  if (customFarView !== undefined) {
    saveFarViewRings(customFarView);
  }

  console.log(`[Quality] Applied preset: ${level}`, {
    shadows: settings.shadowsEnabled,
    shadowMap: settings.shadowMapSize,
    shadowRadius: settings.shadowRadius,
    ssao: settings.ssaoEnabled,
    bloom: settings.bloomEnabled,
    godRays: settings.godRaysEnabled,
    godRaysSamples: settings.godRaysSamples,
    visibility: settings.visibilityRadius,
    anisotropy: settings.anisotropy,
  });
}

/**
 * Apply a quality preset and record the selected level. Single entry-point that
 * UI buttons and GameCore.init should call.
 */
export function syncQualityToStore(level: QualityLevel, customVisibility?: number, customFarView?: number): void {
  applyQuality(level, customVisibility, customFarView);
  useGameStore.getState().setQualityLevel(level);
}

// ============== Quality patch applier (segmented Quality UI) ==============

/**
 * Apply a partial `QualitySettings` change (one segment of the Quality UI) — updates the
 * store slice, then routes each changed key to its imperative subsystem. Post-processing
 * enables (ssao/bloom/godRaysEnabled) apply themselves via the effects.ts store
 * subscription, so they only need the store write. This single function replaces the old
 * per-field `applyX` appliers.
 */
export function applyQualityPatch(patch: Partial<QualitySettings>): void {
  useGameStore.getState().updateQuality(patch);

  if (patch.shadowsEnabled !== undefined) {
    shadowsImpl(patch.shadowsEnabled);
    setMoonShadowsAllowed(patch.shadowsEnabled); // moon casts whenever shadows are on
  }
  if (patch.shadowMapSize !== undefined) shadowMapSizeImpl(patch.shadowMapSize);
  if (patch.shadowRadius !== undefined) updateShadowFrustumSize(patch.shadowRadius);
  if (patch.anisotropy !== undefined) setTerrainAnisotropy(patch.anisotropy);
  if (patch.waterHighQuality !== undefined) setWaterQualityLow(!patch.waterHighQuality);
  if (patch.godRaysSamples !== undefined) setGodRaysSamples(patch.godRaysSamples);
  if (
    patch.shaderNormalMaps !== undefined
    || patch.shaderAoMaps !== undefined
    || patch.shaderMetalnessMaps !== undefined
  ) {
    const q = useGameStore.getState().quality;
    setShaderMapDefines({
      normalMaps: q.shaderNormalMaps,
      aoMaps: q.shaderAoMaps,
      metalnessMaps: q.shaderMetalnessMaps,
    });
  }
  if (patch.visibilityRadius !== undefined) {
    visibilityImpl(patch.visibilityRadius);
    saveVisibilityRadius(patch.visibilityRadius);
  }
  if (patch.farViewRings !== undefined) {
    farViewImpl(patch.farViewRings);
    saveFarViewRings(patch.farViewRings);
  }
}

/** Apply just the visibility radius (thin wrapper — home screen View control). */
export function applyVisibilityRadius(radius: number): void {
  applyQualityPatch({ visibilityRadius: snapViewDistance(radius) });
}

/** Apply just the far-view ring count (thin wrapper — Explore settings Far View control). */
export function applyFarViewRings(rings: number): void {
  applyQualityPatch({ farViewRings: rings });
}

/** Current shadow radius in chunks. Used by VoxelWorld for castShadow culling. */
export function getShadowRadius(): number {
  return useGameStore.getState().quality.shadowRadius;
}

export function getCurrentSettings(): QualitySettings {
  return useGameStore.getState().quality;
}
