/**
 * Post-processing effects setup
 * 
 * Provides ambient occlusion, bloom, color correction and other screen-space effects
 * using Three.js built-in post-processing (matches worldify-app approach).
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// ============== Color Correction Shader ==============

/**
 * Custom color correction shader for saturation/vibrance control.
 * Uses luminance-preserving saturation adjustment.
 */
const ColorCorrectionShader = {
  name: 'ColorCorrectionShader',
  
  uniforms: {
    tDiffuse: { value: null },
    saturation: { value: 1.0 },
  },
  
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float saturation;
    
    varying vec2 vUv;
    
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      
      // Calculate luminance (perceptual weights)
      float luma = dot(color.rgb, vec3(0.299, 0.587, 0.114));
      
      // Adjust saturation by lerping between grayscale and original color
      vec3 gray = vec3(luma);
      vec3 saturated = mix(gray, color.rgb, saturation);
      
      gl_FragColor = vec4(saturated, color.a);
    }
  `,
};

let composer: EffectComposer | null = null;
let ssaoPass: SSAOPass | null = null;
let bloomPass: UnrealBloomPass | null = null;
let colorCorrectionPass: ShaderPass | null = null;
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
  
  // Color correction options
  /** Saturation (default: 1.2) - 0=grayscale, 1=normal, 2=highly saturated */
  saturation?: number;
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
  // Color correction defaults
  saturation: 1.2,  // Slightly boosted for more vivid colors
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
  
  // Color correction pass - saturation control
  colorCorrectionPass = new ShaderPass(ColorCorrectionShader);
  colorCorrectionPass.uniforms.saturation.value = opts.saturation;
  colorCorrectionPass.enabled = opts.enabled;
  composer.addPass(colorCorrectionPass);
  
  // Output pass - required for proper color output
  const outputPass = new OutputPass();
  composer.addPass(outputPass);
  
  effectsEnabled = opts.enabled;
  
  console.log('Post-processing initialized:', {
    ssao: ssaoPass.enabled,
    bloom: bloomPass.enabled,
    saturation: opts.saturation,
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
  if (options.saturation !== undefined && colorCorrectionPass) {
    colorCorrectionPass.uniforms.saturation.value = options.saturation;
  }
  if (options.enabled !== undefined) {
    effectsEnabled = options.enabled;
    if (ssaoPass) ssaoPass.enabled = options.enabled;
    if (bloomPass) bloomPass.enabled = options.enabled;
    if (colorCorrectionPass) colorCorrectionPass.enabled = options.enabled;
  }
}

/**
 * Set saturation directly (convenience function)
 */
export function setSaturation(value: number): void {
  if (colorCorrectionPass) {
    colorCorrectionPass.uniforms.saturation.value = value;
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
  colorCorrectionPass = null;
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
  if (colorCorrectionPass) colorCorrectionPass.enabled = effectsEnabled;
  
  console.log(`Post-processing: ${effectsEnabled ? 'ON' : 'OFF'}`);
  return effectsEnabled;
}
