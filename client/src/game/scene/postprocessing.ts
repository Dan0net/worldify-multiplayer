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

// Store renderer reference and original settings for F8 toggle
let rendererRef: THREE.WebGLRenderer | null = null;
let originalToneMapping: THREE.ToneMapping = THREE.ACESFilmicToneMapping;
let originalToneMappingExposure = 1.0;
let originalSaturation = 1.2;

export interface PostProcessingOptions {
  /** Enable/disable all effects (default: true) */
  enabled?: boolean;
  
  // MSAA options
  /** Number of MSAA samples for the composer render target (0 = off, 2, 4) */
  msaaSamples?: number;
  
  // SSAO options
  /** Enable/disable SSAO independently */
  ssaoEnabled?: boolean;
  /** SSAO kernel radius (default: 1) */
  ssaoKernelRadius?: number;
  /** SSAO min distance (default: 0.002) */
  ssaoMinDistance?: number;
  
  // Bloom options
  /** Enable bloom effect (default: true) */
  bloomEnabled?: boolean;
  /** Bloom intensity/strength (default: 0.5) */
  bloomIntensity?: number;
  /** Bloom luminance threshold (default: 0.8) */
  bloomThreshold?: number;
  /** Bloom radius/smoothing (default: 1) */
  bloomRadius?: number;
  
  // Color correction options
  /** Enable color correction pass (default: true) */
  colorCorrectionEnabled?: boolean;
  /** Saturation (default: 1.2) - 0=grayscale, 1=normal, 2=highly saturated */
  saturation?: number;
}

const defaultOptions: Required<PostProcessingOptions> = {
  enabled: true,
  // MSAA
  msaaSamples: 4,
  // SSAO defaults from worldify-app
  ssaoEnabled: true,
  ssaoKernelRadius: 0.5,
  ssaoMinDistance: 0.002,
  // Bloom defaults
  bloomEnabled: true,
  bloomIntensity: 0.5,
  bloomThreshold: 0.8,
  bloomRadius: 1,
  // Color correction defaults
  colorCorrectionEnabled: true,
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
  
  // Store renderer reference and original settings for F8 toggle
  rendererRef = renderer;
  originalToneMapping = renderer.toneMapping;
  originalToneMappingExposure = renderer.toneMappingExposure;
  originalSaturation = opts.saturation;
  
  // Create composer with an MSAA render target (when samples > 0).
  // Canvas-level antialias is disabled (it only antialiases the final quad,
  // not the 3D scene).  Multisampled FBOs give proper scene MSAA through the
  // entire post-processing chain.
  const msaaTarget = new THREE.WebGLRenderTarget(width, height, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    samples: opts.msaaSamples,
  });
  composer = new EffectComposer(renderer, msaaTarget);
  
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
    msaaSamples: opts.msaaSamples,
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
  if (options.ssaoEnabled !== undefined && ssaoPass) {
    ssaoPass.enabled = options.ssaoEnabled && effectsEnabled;
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
  if (options.bloomEnabled !== undefined && bloomPass) {
    bloomPass.enabled = options.bloomEnabled && effectsEnabled;
  }
  if (options.colorCorrectionEnabled !== undefined && colorCorrectionPass) {
    colorCorrectionPass.enabled = options.colorCorrectionEnabled && effectsEnabled;
  }
  if (options.saturation !== undefined && colorCorrectionPass) {
    colorCorrectionPass.uniforms.saturation.value = options.saturation;
    originalSaturation = options.saturation;
  }
  if (options.enabled !== undefined) {
    effectsEnabled = options.enabled;
    if (ssaoPass) ssaoPass.enabled = options.enabled && (options.ssaoEnabled ?? ssaoPass.enabled);
    if (bloomPass) bloomPass.enabled = options.enabled && (options.bloomEnabled ?? bloomPass.enabled);
    if (colorCorrectionPass) colorCorrectionPass.enabled = options.enabled && (options.colorCorrectionEnabled ?? colorCorrectionPass.enabled);
  }
}

/**
 * Set saturation directly (convenience function)
 */
export function setSaturation(value: number): void {
  if (colorCorrectionPass) {
    colorCorrectionPass.uniforms.saturation.value = value;
    // Update the original value so F8 toggle restores correctly
    originalSaturation = value;
  }
}

/**
 * Update the MSAA sample count on the composer render target at runtime.
 * A value of 0 disables MSAA entirely.
 */
export function updateMsaaSamples(samples: number): void {
  if (!composer) return;
  const rt = composer.renderTarget1;
  if (rt.samples === samples) return;
  rt.samples = samples;
  rt.dispose(); // force WebGL to recreate the FBO with the new sample count
  const rt2 = composer.renderTarget2;
  rt2.samples = samples;
  rt2.dispose();
  console.log(`[PostProcessing] MSAA samples set to ${samples}`);
}

/**
 * Get the current MSAA sample count.
 */
export function getMsaaSamples(): number {
  if (!composer) return 0;
  return composer.renderTarget1.samples;
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
 * When off: disables SSAO, bloom, color correction, AND tone mapping
 * This provides a "raw" view for debugging material/lighting issues.
 */
export function togglePostProcessing(): boolean {
  effectsEnabled = !effectsEnabled;
  
  if (ssaoPass) ssaoPass.enabled = effectsEnabled;
  if (bloomPass) bloomPass.enabled = effectsEnabled;
  if (colorCorrectionPass) {
    colorCorrectionPass.enabled = effectsEnabled;
    // Restore saturation when re-enabled
    if (effectsEnabled) {
      colorCorrectionPass.uniforms.saturation.value = originalSaturation;
    }
  }
  
  // Toggle tone mapping on the renderer
  if (rendererRef) {
    if (effectsEnabled) {
      rendererRef.toneMapping = originalToneMapping;
      rendererRef.toneMappingExposure = originalToneMappingExposure;
    } else {
      rendererRef.toneMapping = THREE.NoToneMapping;
      rendererRef.toneMappingExposure = 1.0;
    }
  }
  
  console.log(`Post-processing: ${effectsEnabled ? 'ON' : 'OFF'} (tone mapping: ${effectsEnabled ? 'ACES' : 'None'})`);
  return effectsEnabled;
}
