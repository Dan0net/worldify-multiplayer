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
  BloomEffect, SSAOEffect, BlendFunction, LuminanceMaterial,
} from 'postprocessing';
import { useGameStore } from '../../state/store';

// ============== State ==============

let composer: EffectComposer | null = null;
let normalPass: NormalPass | null = null;
let ssaoEffect: SSAOEffect | null = null;
let bloomEffect: BloomEffect | null = null;
let effectPass: EffectPass | null = null;
let copyPass: CopyPass | null = null;
let unsubscribe: (() => void) | null = null;

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
};

// ============== Internal helpers ==============

/**
 * Sync pass enabled/renderToScreen state based on which effects are active.
 * - NormalPass only runs when SSAO is on (it generates normals for SSAO)
 * - Individual effects are disabled when off (skips their internal render passes)
 * - EffectPass is on when any effect is active; CopyPass when none are
 */
function updatePassStates(): void {
  if (!effectPass || !copyPass || !normalPass || !ssaoEffect || !bloomEffect) return;

  // Skip NormalPass entirely when SSAO is off
  normalPass.enabled = current.ssaoEnabled;

  // Disable individual effects so their internal passes don't run
  ssaoEffect.blendMode.setBlendFunction(current.ssaoEnabled ? BlendFunction.MULTIPLY : BlendFunction.SKIP);
  bloomEffect.blendMode.setBlendFunction(current.bloomEnabled ? BlendFunction.SCREEN : BlendFunction.SKIP);

  // EffectPass vs CopyPass
  const anyActive = current.ssaoEnabled || current.bloomEnabled;
  effectPass.enabled = anyActive;
  effectPass.renderToScreen = anyActive;
  copyPass.enabled = !anyActive;
  copyPass.renderToScreen = !anyActive;
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

  // Merge BEFORE updatePassStates so it uses new values
  Object.assign(current, next);

  // Update pass enable states if any toggle changed
  if (next.ssaoEnabled !== undefined || next.bloomEnabled !== undefined) {
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
    multisampling: Math.min(state.msaaSamples, renderer.capabilities.maxSamples),
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

  // EffectPass — combines all effects into one fullscreen pass
  effectPass = new EffectPass(camera, ssaoEffect, bloomEffect);
  composer.addPass(effectPass);

  // CopyPass — resolves MSAA FBO to screen when all effects are off
  copyPass = new CopyPass();
  composer.addPass(copyPass);

  // Manually manage which pass renders to screen
  composer.autoRenderToScreen = false;

  // Sync current state
  current = {
    msaaSamples: state.msaaSamples,
    ssaoEnabled: state.ssaoEnabled,
    ssaoIntensity: state.environment.ssaoIntensity,
    ssaoRadius: state.environment.ssaoRadius,
    bloomEnabled: state.bloomEnabled,
    bloomIntensity: state.environment.bloomIntensity,
    bloomThreshold: state.environment.bloomThreshold,
    bloomRadius: state.environment.bloomRadius,
  };
  updatePassStates();

  // Subscribe to store — react to settings changes
  unsubscribe = useGameStore.subscribe((state, prev) => {
    const changes: Partial<EffectsSettings> = {};

    if (state.msaaSamples !== prev.msaaSamples) changes.msaaSamples = state.msaaSamples;
    if (state.ssaoEnabled !== prev.ssaoEnabled) changes.ssaoEnabled = state.ssaoEnabled;
    if (state.environment.ssaoIntensity !== prev.environment.ssaoIntensity) changes.ssaoIntensity = state.environment.ssaoIntensity;
    if (state.environment.ssaoRadius !== prev.environment.ssaoRadius) changes.ssaoRadius = state.environment.ssaoRadius;
    if (state.bloomEnabled !== prev.bloomEnabled) changes.bloomEnabled = state.bloomEnabled;
    if (state.environment.bloomIntensity !== prev.environment.bloomIntensity) changes.bloomIntensity = state.environment.bloomIntensity;
    if (state.environment.bloomThreshold !== prev.environment.bloomThreshold) changes.bloomThreshold = state.environment.bloomThreshold;
    if (state.environment.bloomRadius !== prev.environment.bloomRadius) changes.bloomRadius = state.environment.bloomRadius;

    if (Object.keys(changes).length > 0) {
      applySettings(changes);
    }
  });

  console.log('[Effects] Pipeline initialized', {
    multisampling: composer.multisampling,
    ssao: state.ssaoEnabled,
    bloom: state.bloomEnabled,
  });
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
    composer.render(delta);
  } else {
    renderer.render(scene, camera);
  }
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
  normalPass = null;
  ssaoEffect = null;
  bloomEffect = null;
  effectPass = null;
  copyPass = null;
}

/**
 * Get the composer instance (for external use).
 */
export function getEffectComposer(): EffectComposer | null {
  return composer;
}
