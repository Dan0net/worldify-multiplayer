/**
 * Material system constants
 */

/**
 * Base URL for material binaries.
 * In development, this points to /materials which serves from the output folder.
 * In production, set VITE_MATERIAL_URL to your CDN/R2 URL.
 */
export const MATERIAL_BASE_URL = import.meta.env.VITE_MATERIAL_URL || '/materials';
