/**
 * Post-processing effects pipeline (pmndrs/postprocessing)
 *
 * Settings are driven by a Zustand store subscription — quality presets
 * and the debug panel just write to the store; this module reacts.
 *
 * To add a new effect:
 *   1. Add the setting to the store (store.ts)
 *   2. Pick it up in the subscribe callback below
 *   3. Apply it in `applySettings()`
 */

import * as THREE from 'three';
import {
  EffectComposer, EffectPass, RenderPass, CopyPass, NormalPass,
  BloomEffect, SSAOEffect, GodRaysEffect, HueSaturationEffect, KernelSize,
  BlendFunction, LuminanceMaterial,
} from 'postprocessing';
import { useGameStore } from '../../state/store';
import { getSunLight, getMoonLight } from './Lighting';

// ============== State ==============

let composer: EffectComposer | null = null;
let normalPass: NormalPass | null = null;
let ssaoEffect: SSAOEffect | null = null;
let bloomEffect: BloomEffect | null = null;
let godRaysEffect: GodRaysEffect | null = null;
let hueSaturationEffect: HueSaturationEffect | null = null;
let sunMesh: THREE.Mesh | null = null;
let effectPass: EffectPass | null = null;  // SSAO + bloom
let godRaysPass: EffectPass | null = null; // god rays (separate — needs sun mesh)
let copyPass: CopyPass | null = null;
let unsubscribe: (() => void) | null = null;

/** God-rays radial-blur sample count — quality lever set by the quality preset. */
let godRaysSamples = 60;

/** Settings snapshot that the pipeline cares about. */
interface EffectsSettings {
  msaaSamples: number;
  ssaoEnabled: boolean;
  ssaoIntensity: number;
  ssaoRadius: number;
  bloomEnabled: boolean;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomRadius: number;
  godRaysEnabled: boolean;
  godRaysDecay: number;
  godRaysExposure: number;
  colorCorrectionEnabled: boolean;
  saturation: number;              // store units: 0-2, 1.0 = neutral
}

let current: EffectsSettings = {
  msaaSamples: 4,
  ssaoEnabled: true,
  ssaoIntensity: 4,
  ssaoRadius: 0.1,
  bloomEnabled: true,
  bloomIntensity: 1,
  bloomThreshold: 0.8,
  bloomRadius: 0.5,
  godRaysEnabled: true,
  godRaysDecay: 0.85,
  godRaysExposure: 0.3,
  colorCorrectionEnabled: true,
  saturation: 1.0,
};

/** Map store saturation (0-2, 1=neutral) → HueSaturationEffect saturation (-1..1, 0=neutral). */
function toEffectSaturation(storeSaturation: number): number {
  return Math.max(-1, Math.min(1, storeSaturation - 1));
}

// ============== Internal helpers ==============

/**
 * Sync pass enabled/renderToScreen state based on which effects are active.
 * - NormalPass only runs when SSAO is on
 * - Individual effects use SKIP blend when off
 * - God rays pass is independently toggled
 * - CopyPass is fallback when ALL effects are off
 */
function updatePassStates(): void {
  if (!effectPass || !godRaysPass || !copyPass || !normalPass || !ssaoEffect || !bloomEffect || !godRaysEffect || !hueSaturationEffect) return;

  // NormalPass — only needed for SSAO
  normalPass.enabled = current.ssaoEnabled;

  // Individual effect blend functions
  ssaoEffect.blendMode.setBlendFunction(current.ssaoEnabled ? BlendFunction.MULTIPLY : BlendFunction.SKIP);
  bloomEffect.blendMode.setBlendFunction(current.bloomEnabled ? BlendFunction.SCREEN : BlendFunction.SKIP);
  hueSaturationEffect.blendMode.setBlendFunction(current.colorCorrectionEnabled ? BlendFunction.SRC : BlendFunction.SKIP);

  // EffectPass (SSAO + bloom + color correction)
  const anyEffect = current.ssaoEnabled || current.bloomEnabled || current.colorCorrectionEnabled;
  effectPass.enabled = anyEffect;

  // God rays pass
  godRaysPass.enabled = current.godRaysEnabled;

  // Exactly one pass renders to screen — last enabled pass gets it
  effectPass.renderToScreen = false;
  godRaysPass.renderToScreen = false;
  copyPass.enabled = false;
  copyPass.renderToScreen = false;

  if (current.godRaysEnabled) {
    godRaysPass.renderToScreen = true;
  } else if (anyEffect) {
    effectPass.renderToScreen = true;
  } else {
    copyPass.enabled = true;
    copyPass.renderToScreen = true;
  }
}

function applySettings(next: Partial<EffectsSettings>): void {
  if (!composer) return;

  if (next.msaaSamples !== undefined && next.msaaSamples !== current.msaaSamples) {
    composer.multisampling = Math.min(next.msaaSamples, composer.getRenderer().capabilities.maxSamples);
    console.log(`[Effects] MSAA → ${composer.multisampling}`);
  }

  // SSAO params
  if (ssaoEffect) {
    if (next.ssaoIntensity !== undefined) ssaoEffect.intensity = next.ssaoIntensity;
    if (next.ssaoRadius !== undefined) ssaoEffect.ssaoMaterial.radius = next.ssaoRadius;
  }

  // Bloom params
  if (bloomEffect) {
    if (next.bloomIntensity !== undefined) bloomEffect.intensity = next.bloomIntensity;
    if (next.bloomThreshold !== undefined) {
      (bloomEffect.luminancePass.fullscreenMaterial as LuminanceMaterial).threshold = next.bloomThreshold;
    }
    if (next.bloomRadius !== undefined) bloomEffect.mipmapBlurPass.radius = next.bloomRadius;
  }

  // God rays params
  if (godRaysEffect) {
    if (next.godRaysDecay !== undefined) godRaysEffect.godRaysMaterial.decay = next.godRaysDecay;
    if (next.godRaysExposure !== undefined) godRaysEffect.godRaysMaterial.exposure = next.godRaysExposure;
  }

  // Color correction params
  if (hueSaturationEffect && next.saturation !== undefined) {
    hueSaturationEffect.saturation = toEffectSaturation(next.saturation);
  }

  // Merge BEFORE updatePassStates so it uses new values
  Object.assign(current, next);

  // Update pass enable states if any toggle changed
  if (next.ssaoEnabled !== undefined || next.bloomEnabled !== undefined
    || next.godRaysEnabled !== undefined || next.colorCorrectionEnabled !== undefined) {
    updatePassStates();
  }
}

// ============== Public API ==============

/**
 * Initialize the pmndrs post-processing pipeline and subscribe to the store.
 */
export function initEffects(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
): void {
  const state = useGameStore.getState();

  composer = new EffectComposer(renderer, {
    multisampling: Math.min(state.quality.msaaSamples, renderer.capabilities.maxSamples),
    frameBufferType: THREE.HalfFloatType,
  });

  // RenderPass — renders the scene into the multisampled FBO
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);

  // NormalPass — generates view-space normals for SSAO
  normalPass = new NormalPass(scene, camera);
  composer.addPass(normalPass);

  // SSAOEffect — defaults match pmndrs demo
  ssaoEffect = new SSAOEffect(camera, normalPass.texture, {
    intensity: state.environment.ssaoIntensity,
    radius: state.environment.ssaoRadius,
    samples: 9,
    rings: 7,
    distanceScaling: true,
    depthAwareUpsampling: true,
    minRadiusScale: 0.33,
    luminanceInfluence: 0.7,
    bias: 0.025,
    fade: 0.01,
    distanceThreshold: 0.02,
    distanceFalloff: 0.0025,
    rangeThreshold: 0.0003,
    rangeFalloff: 0.0001,
    resolutionScale: 0.5,
  });

  // BloomEffect
  bloomEffect = new BloomEffect({
    intensity: state.environment.bloomIntensity,
    luminanceThreshold: state.environment.bloomThreshold,
    luminanceSmoothing: 0.03,
    mipmapBlur: true,
    radius: state.environment.bloomRadius,
  });

  // HueSaturationEffect — color correction / saturation grading
  hueSaturationEffect = new HueSaturationEffect({
    saturation: toEffectSaturation(state.environment.saturation),
  });

  // EffectPass — SSAO + bloom + color correction (saturation applied last)
  effectPass = new EffectPass(camera, ssaoEffect, bloomEffect, hueSaturationEffect);
  composer.addPass(effectPass);

  // Sun mesh for god rays (invisible, transparent, no depth write)
  sunMesh = new THREE.Mesh(
    new THREE.SphereGeometry(30, 16, 16),
    new THREE.MeshBasicMaterial({ color: 0xffddaa, transparent: true, fog: false }),
  );
  sunMesh.frustumCulled = false;
  sunMesh.matrixAutoUpdate = false;
  // Position from sunLight (don't add to main scene — GodRaysEffect renders it internally)
  syncSunMeshPosition();

  // GodRaysEffect — defaults match pmndrs demo (exposure seeded from store)
  godRaysEffect = new GodRaysEffect(camera, sunMesh, {
    density: 0.96,
    decay: state.environment.godRaysDecay,
    weight: 0.3,
    exposure: state.environment.godRaysExposure,
    samples: godRaysSamples,
    clampMax: 1.0,
    kernelSize: KernelSize.SMALL,
    blur: true,
    resolutionScale: 0.5,
  });
  // Apply any preset sample count set before init.
  godRaysEffect.samples = godRaysSamples;

  // God rays in a separate EffectPass
  godRaysPass = new EffectPass(camera, godRaysEffect);
  composer.addPass(godRaysPass);

  // CopyPass — resolves MSAA FBO to screen when all effects are off
  copyPass = new CopyPass();
  composer.addPass(copyPass);

  // Manually manage which pass renders to screen
  composer.autoRenderToScreen = false;

  // Sync current state
  current = {
    msaaSamples: state.quality.msaaSamples,
    ssaoEnabled: state.quality.ssaoEnabled,
    ssaoIntensity: state.environment.ssaoIntensity,
    ssaoRadius: state.environment.ssaoRadius,
    bloomEnabled: state.quality.bloomEnabled,
    bloomIntensity: state.environment.bloomIntensity,
    bloomThreshold: state.environment.bloomThreshold,
    bloomRadius: state.environment.bloomRadius,
    godRaysEnabled: state.quality.godRaysEnabled,
    godRaysDecay: state.environment.godRaysDecay,
    godRaysExposure: state.environment.godRaysExposure,
    colorCorrectionEnabled: state.quality.colorCorrectionEnabled,
    saturation: state.environment.saturation,
  };
  updatePassStates();

  // Subscribe to store — react to settings changes
  unsubscribe = useGameStore.subscribe((state, prev) => {
    const changes: Partial<EffectsSettings> = {};

    if (state.quality.msaaSamples !== prev.quality.msaaSamples) changes.msaaSamples = state.quality.msaaSamples;
    if (state.quality.ssaoEnabled !== prev.quality.ssaoEnabled) changes.ssaoEnabled = state.quality.ssaoEnabled;
    if (state.environment.ssaoIntensity !== prev.environment.ssaoIntensity) changes.ssaoIntensity = state.environment.ssaoIntensity;
    if (state.environment.ssaoRadius !== prev.environment.ssaoRadius) changes.ssaoRadius = state.environment.ssaoRadius;
    if (state.quality.bloomEnabled !== prev.quality.bloomEnabled) changes.bloomEnabled = state.quality.bloomEnabled;
    if (state.environment.bloomIntensity !== prev.environment.bloomIntensity) changes.bloomIntensity = state.environment.bloomIntensity;
    if (state.environment.bloomThreshold !== prev.environment.bloomThreshold) changes.bloomThreshold = state.environment.bloomThreshold;
    if (state.environment.bloomRadius !== prev.environment.bloomRadius) changes.bloomRadius = state.environment.bloomRadius;
    if (state.quality.godRaysEnabled !== prev.quality.godRaysEnabled) changes.godRaysEnabled = state.quality.godRaysEnabled;
    if (state.environment.godRaysDecay !== prev.environment.godRaysDecay) changes.godRaysDecay = state.environment.godRaysDecay;
    if (state.environment.godRaysExposure !== prev.environment.godRaysExposure) changes.godRaysExposure = state.environment.godRaysExposure;
    if (state.quality.colorCorrectionEnabled !== prev.quality.colorCorrectionEnabled) changes.colorCorrectionEnabled = state.quality.colorCorrectionEnabled;
    if (state.environment.saturation !== prev.environment.saturation) changes.saturation = state.environment.saturation;

    if (Object.keys(changes).length > 0) {
      applySettings(changes);
    }
  });

  console.log('[Effects] Pipeline initialized', {
    multisampling: composer.multisampling,
    ssao: state.quality.ssaoEnabled,
    bloom: state.quality.bloomEnabled,
    godRays: state.quality.godRaysEnabled,
  });
}

/**
 * Sync sun mesh position and color from the active light source each frame.
 * Follows whichever light currently casts shadows (sun or moon).
 */
function syncSunMeshPosition(): void {
  if (!sunMesh) return;
  // The sun mesh is only consumed by the god-rays pass; skip the per-frame light
  // lookup + matrix update entirely when god rays are disabled.
  if (!current.godRaysEnabled) return;
  // God rays emanate from whichever celestial body is above the horizon — the
  // sun by day, the moon by night — independent of which light casts shadows.
  // (Tying this to the shadow caster meant the moon never got rays on High,
  // where moon shadows are off.)
  const sun = getSunLight();
  const moon = getMoonLight();
  const light = sun && sun.position.y >= 0 ? sun : (moon ?? sun);
  if (light) {
    sunMesh.position.copy(light.position);
    (sunMesh.material as THREE.MeshBasicMaterial).color.copy(light.color);
    sunMesh.updateMatrix();
  }
}

/**
 * Render a frame through the effects pipeline.
 */
export function renderEffects(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  delta: number,
): void {
  if (composer) {
    syncSunMeshPosition();
    composer.render(delta);
  } else {
    renderer.render(scene, camera);
  }
}

/**
 * Set the god-rays radial-blur sample count (quality/cost lever). Driven by the
 * quality preset — High uses a low count, Max a high count.
 */
export function setGodRaysSamples(samples: number): void {
  godRaysSamples = samples;
  if (godRaysEffect) godRaysEffect.samples = samples;
}

/**
 * Resize the effects pipeline to match the new viewport.
 */
export function resizeEffects(width: number, height: number): void {
  if (composer) {
    composer.setSize(width, height);
  }
}

/**
 * Dispose of all post-processing resources and unsubscribe from store.
 */
export function disposeEffects(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
  if (composer) {
    composer.dispose();
    composer = null;
  }
  if (sunMesh) {
    sunMesh.geometry.dispose();
    (sunMesh.material as THREE.MeshBasicMaterial).dispose();
    sunMesh = null;
  }
  normalPass = null;
  ssaoEffect = null;
  bloomEffect = null;
  godRaysEffect = null;
  hueSaturationEffect = null;
  effectPass = null;
  godRaysPass = null;
  copyPass = null;
}

/**
 * Get the composer instance (for external use).
 */
export function getEffectComposer(): EffectComposer | null {
  return composer;
}
