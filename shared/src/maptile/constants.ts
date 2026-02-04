/**
 * Map tile constants
 */

import { CHUNK_SIZE } from '../voxel/constants.js';

/** Pixels per map tile axis (matches chunk XZ voxels) */
export const MAP_TILE_SIZE = CHUNK_SIZE; // 32

/** Total pixels per map tile */
export const MAP_TILE_PIXELS = MAP_TILE_SIZE * MAP_TILE_SIZE; // 1024

/** Bytes for height data (int16 per pixel) */
export const MAP_TILE_HEIGHT_BYTES = MAP_TILE_PIXELS * 2; // 2048

/** Bytes for material data (uint8 per pixel) */
export const MAP_TILE_MATERIAL_BYTES = MAP_TILE_PIXELS; // 1024

/** Total data bytes per tile (excluding header) */
export const MAP_TILE_DATA_BYTES = MAP_TILE_HEIGHT_BYTES + MAP_TILE_MATERIAL_BYTES; // 3072
