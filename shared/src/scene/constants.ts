/**
 * Shared Scene Constants
 * 
 * Single source of truth for material and lighting defaults.
 * Used by both game client and pallet viewer for consistent rendering.
 */

// ============== Material Shader Defaults ==============

/** Default roughness multiplier - applied to roughness texture values */
export const MATERIAL_ROUGHNESS_MULTIPLIER = 1.0;

/** Default metalness multiplier - applied to metalness texture values */
export const MATERIAL_METALNESS_MULTIPLIER = 1.0;

/** Default AO intensity - 0 = no AO effect, 1 = full effect */
export const MATERIAL_AO_INTENSITY = 1.0;

/** Default normal map strength - multiplied with normal map values */
export const MATERIAL_NORMAL_STRENGTH = 1.0;

// ============== Lighting Defaults ==============

/** Ambient light intensity */
export const LIGHT_AMBIENT_INTENSITY = 0.4;

/** Main directional light (sun) intensity */
export const LIGHT_SUN_INTENSITY = 1.5;

/** Fill directional light intensity */
export const LIGHT_FILL_INTENSITY = 0.5;

// ============== Environment/IBL Defaults ==============

/** Environment map intensity for IBL reflections - lower = less washed out colors */
export const ENVIRONMENT_INTENSITY = 0.5;

/** Default skybox preset */
export const DEFAULT_SKYBOX = 'forest';

// ============== Placeholder Texture Defaults ==============
// Values for generated textures when no source texture exists

/** Default AO value (255 = no occlusion, white) */
export const PLACEHOLDER_AO = 255;

/** Default roughness value (200/255 ≈ 0.78 = fairly rough) */
export const PLACEHOLDER_ROUGHNESS = 200;

/** Default metalness value (0 = non-metallic) */
export const PLACEHOLDER_METALNESS = 0;

/** Default normal map color (flat normal pointing up: RGB 128, 128, 255) */
export const PLACEHOLDER_NORMAL = { r: 128, g: 128, b: 255 };
