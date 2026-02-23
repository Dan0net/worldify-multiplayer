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
import { EffectComposer, EffectPass, RenderPass, CopyPass, BloomEffect, LuminanceMaterial } from 'postprocessing';
import { useGameStore } from '../../state/store';

// ============== State ==============

let composer: EffectComposer | null = null;
let bloomEffect: BloomEffect | null = null;
let effectPass: EffectPass | null = null;
let copyPass: CopyPass | null = null;
let unsubscribe: (() => void) | null = null;

/** Settings snapshot that the pipeline cares about. */
interface EffectsSettings {
  msaaSamples: number;
  bloomEnabled: boolean;
  bloomIntensity: number;
  bloomThreshold: number;
  bloomRadius: number;
}

let current: EffectsSettings = {
  msaaSamples: 4,
  bloomEnabled: true,
  bloomIntensity: 1,
  bloomThreshold: 0.8,
  bloomRadius: 0.5,
};

// ============== Internal helpers ==============

function applySettings(next: Partial<EffectsSettings>): void {
  if (!composer) return;

  if (next.msaaSamples !== undefined && next.msaaSamples !== current.msaaSamples) {
    composer.multisampling = Math.min(next.msaaSamples, composer.getRenderer().capabilities.maxSamples);
    console.log(`[Effects] MSAA → ${composer.multisampling}`);
  }

  if (bloomEffect) {
    if (next.bloomEnabled !== undefined) {
      setBloomActive(next.bloomEnabled);
    }
    if (next.bloomIntensity !== undefined) {
      bloomEffect.intensity = next.bloomIntensity;
    }
    if (next.bloomThreshold !== undefined) {
      (bloomEffect.luminancePass.fullscreenMaterial as LuminanceMaterial).threshold = next.bloomThreshold;
    }
    if (next.bloomRadius !== undefined) {
      bloomEffect.mipmapBlurPass.radius = next.bloomRadius;
    }
  }

  Object.assign(current, next);
}

/**
 * Toggle between EffectPass (bloom on) and CopyPass (bloom off).
 * Exactly one is enabled + renderToScreen at any time.
 */
function setBloomActive(enabled: boolean): void {
  if (effectPass && copyPass) {
    effectPass.enabled = enabled;
    effectPass.renderToScreen = enabled;
    copyPass.enabled = !enabled;
    copyPass.renderToScreen = !enabled;
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

  // BloomEffect
  bloomEffect = new BloomEffect({
    intensity: state.environment.bloomIntensity,
    luminanceThreshold: state.environment.bloomThreshold,
    luminanceSmoothing: 0.03,
    mipmapBlur: true,
    radius: state.environment.bloomRadius,
  });

  // EffectPass — bloom effects (disabled when bloom is off)
  effectPass = new EffectPass(camera, bloomEffect);
  composer.addPass(effectPass);

  // CopyPass — resolves MSAA FBO to screen when no effects are active
  copyPass = new CopyPass();
  composer.addPass(copyPass);

  // Manually manage which pass renders to screen
  composer.autoRenderToScreen = false;
  setBloomActive(state.bloomEnabled);

  // Sync current state
  current = {
    msaaSamples: state.msaaSamples,
    bloomEnabled: state.bloomEnabled,
    bloomIntensity: state.environment.bloomIntensity,
    bloomThreshold: state.environment.bloomThreshold,
    bloomRadius: state.environment.bloomRadius,
  };

  // Subscribe to store — react to settings changes
  unsubscribe = useGameStore.subscribe((state, prev) => {
    const changes: Partial<EffectsSettings> = {};

    if (state.msaaSamples !== prev.msaaSamples) changes.msaaSamples = state.msaaSamples;
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
    bloom: effectPass.enabled,
    bloomIntensity: bloomEffect.intensity,
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
