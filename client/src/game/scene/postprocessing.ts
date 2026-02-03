/**
 * Post-processing effects setup
 * 
 * Provides ambient occlusion, bloom, and other screen-space effects
 * using Three.js built-in post-processing (matches worldify-app approach).
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

let composer: EffectComposer | null = null;
let ssaoPass: SSAOPass | null = null;
let bloomPass: UnrealBloomPass | null = null;
let effectsEnabled = true;

export interface PostProcessingOptions {
  /** Enable/disable all effects (default: true) */
  enabled?: boolean;
  
  // SSAO options
  /** SSAO kernel radius (default: 12) - based on worldify-app */
  ssaoKernelRadius?: number;
  /** SSAO min distance (default: 0.002) - based on worldify-app */
  ssaoMinDistance?: number;
  
  // Bloom options
  /** Enable bloom effect (default: true) */
  bloomEnabled?: boolean;
  /** Bloom intensity/strength (default: 0.3) - based on worldify-app */
  bloomIntensity?: number;
  /** Bloom luminance threshold (default: 0.85) - based on worldify-app */
  bloomThreshold?: number;
  /** Bloom radius/smoothing (default: 0.4) - based on worldify-app */
  bloomRadius?: number;
}

const defaultOptions: Required<PostProcessingOptions> = {
  enabled: true,
  // SSAO defaults from worldify-app
  ssaoKernelRadius: 12,
  ssaoMinDistance: 0.002,
  // Bloom defaults from worldify-app
  bloomEnabled: true,
  bloomIntensity: 0.3,
  bloomThreshold: 0.85,
  bloomRadius: 0.4,
};

/**
 * Initialize post-processing composer with ambient occlusion and bloom
 * Uses Three.js built-in passes (same approach as worldify-app)
 */
export function initPostProcessing(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  options: PostProcessingOptions = {}
): EffectComposer {
  const opts = { ...defaultOptions, ...options };
  const width = window.innerWidth;
  const height = window.innerHeight;
  
  // Create composer
  composer = new EffectComposer(renderer);
  
  // Render pass - renders the scene
  const renderPass = new RenderPass(scene, camera);
  composer.addPass(renderPass);
  
  // SSAO pass - ambient occlusion (same setup as worldify-app)
  ssaoPass = new SSAOPass(scene, camera, width, height);
  ssaoPass.kernelRadius = opts.ssaoKernelRadius;
  ssaoPass.minDistance = opts.ssaoMinDistance;
  ssaoPass.enabled = opts.enabled;
  
  // Use standard MeshNormalMaterial for SSAO normal pass.
  // Wind displacement only applies to transparent meshes (leaves, etc.) and is subtle enough
  // that the SSAO mismatch is not noticeable. Applying wind to all meshes via the normal
  // override caused solid terrain to incorrectly wobble in the SSAO calculation.
  
  composer.addPass(ssaoPass);
  
  // Bloom pass - glow effect (same setup as worldify-app)
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    opts.bloomIntensity,  // strength
    opts.bloomRadius,     // radius
    opts.bloomThreshold   // threshold
  );
  bloomPass.enabled = opts.enabled && opts.bloomEnabled;
  composer.addPass(bloomPass);
  
  // Output pass - required for proper color output
  const outputPass = new OutputPass();
  composer.addPass(outputPass);
  
  effectsEnabled = opts.enabled;
  
  console.log('Post-processing initialized:', {
    ssao: ssaoPass.enabled,
    bloom: bloomPass.enabled,
    passes: composer.passes.length,
  });
  
  return composer;
}

/**
 * Render a frame through the post-processing pipeline
 */
export function renderWithPostProcessing(): void {
  if (composer) {
    composer.render();
  }
}

/**
 * Check if post-processing is initialized
 */
export function isPostProcessingEnabled(): boolean {
  return composer !== null;
}

/**
 * Update post-processing options at runtime
 */
export function updatePostProcessing(options: PostProcessingOptions): void {
  if (options.ssaoKernelRadius !== undefined && ssaoPass) {
    ssaoPass.kernelRadius = options.ssaoKernelRadius;
  }
  if (options.ssaoMinDistance !== undefined && ssaoPass) {
    ssaoPass.minDistance = options.ssaoMinDistance;
  }
  if (options.bloomIntensity !== undefined && bloomPass) {
    bloomPass.strength = options.bloomIntensity;
  }
  if (options.bloomThreshold !== undefined && bloomPass) {
    bloomPass.threshold = options.bloomThreshold;
  }
  if (options.bloomRadius !== undefined && bloomPass) {
    bloomPass.radius = options.bloomRadius;
  }
  if (options.enabled !== undefined) {
    effectsEnabled = options.enabled;
    if (ssaoPass) ssaoPass.enabled = options.enabled;
    if (bloomPass) bloomPass.enabled = options.enabled;
  }
}

/**
 * Handle window resize
 */
export function resizePostProcessing(width: number, height: number): void {
  if (composer) {
    composer.setSize(width, height);
  }
}

/**
 * Dispose of all post-processing resources
 */
export function disposePostProcessing(): void {
  if (composer) {
    composer.dispose();
    composer = null;
  }
  ssaoPass = null;
  bloomPass = null;
}

/**
 * Get the effect composer for external use
 */
export function getComposer(): EffectComposer | null {
  return composer;
}

/**
 * Toggle post-processing on/off. Returns new enabled state.
 */
export function togglePostProcessing(): boolean {
  effectsEnabled = !effectsEnabled;
  
  if (ssaoPass) ssaoPass.enabled = effectsEnabled;
  if (bloomPass) bloomPass.enabled = effectsEnabled;
  
  console.log(`Post-processing: ${effectsEnabled ? 'ON' : 'OFF'}`);
  return effectsEnabled;
}
