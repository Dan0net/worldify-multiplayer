/**
 * Material system constants
 */

/**
 * Base URL for material binaries on R2.
 * Set via VITE_MATERIAL_URL environment variable.
 * Falls back to a placeholder if not set.
 */
export const MATERIAL_BASE_URL = import.meta.env.VITE_MATERIAL_URL || '/materials';

/**
 * Texture repeat scale for tri-planar mapping.
 * Lower values = more zoomed in, higher = more repetition.
 */
export const TERRAIN_MATERIAL_REPEAT_SCALE = 0.6;

/**
 * Blend offset for tri-planar normal rotation (radians).
 */
export const TERRAIN_MATERIAL_BLEND_OFFSET_RAD = 0.2;
