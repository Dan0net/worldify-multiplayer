/**
 * Map tile data structure and utilities
 * 
 * A map tile represents the surface view of a chunk column (all Y levels).
 * Each pixel stores the height and material of the highest solid voxel.
 */

import { MAP_TILE_SIZE, MAP_TILE_PIXELS } from './constants.js';

/**
 * Map tile data for a single chunk column
 */
export interface MapTileData {
  /** Tile X coordinate (same as chunk X) */
  tx: number;
  /** Tile Z coordinate (same as chunk Z) */
  tz: number;
  /** Height per pixel (voxel Y of highest solid surface) */
  heights: Int16Array;
  /** Material ID per pixel (surface material) */
  materials: Uint8Array;
}

/**
 * Create an empty map tile
 */
export function createMapTile(tx: number, tz: number): MapTileData {
  return {
    tx,
    tz,
    heights: new Int16Array(MAP_TILE_PIXELS),
    materials: new Uint8Array(MAP_TILE_PIXELS),
  };
}

/**
 * Get tile key from coordinates
 */
export function mapTileKey(tx: number, tz: number): string {
  return `${tx},${tz}`;
}

/**
 * Parse tile key to coordinates
 */
export function parseMapTileKey(key: string): { tx: number; tz: number } {
  const [tx, tz] = key.split(',').map(Number);
  return { tx, tz };
}

/**
 * Get pixel index from local coordinates
 */
export function tilePixelIndex(lx: number, lz: number): number {
  return lz * MAP_TILE_SIZE + lx;
}

/**
 * Get height at a pixel position
 */
export function getTileHeight(tile: MapTileData, lx: number, lz: number): number {
  return tile.heights[tilePixelIndex(lx, lz)];
}

/**
 * Get material at a pixel position
 */
export function getTileMaterial(tile: MapTileData, lx: number, lz: number): number {
  return tile.materials[tilePixelIndex(lx, lz)];
}

/**
 * Set height and material at a pixel position
 */
export function setTilePixel(
  tile: MapTileData,
  lx: number,
  lz: number,
  height: number,
  material: number
): void {
  const index = tilePixelIndex(lx, lz);
  tile.heights[index] = height;
  tile.materials[index] = material;
}

/**
 * Copy tile data from one tile to another
 */
export function copyMapTile(source: MapTileData, dest: MapTileData): void {
  dest.tx = source.tx;
  dest.tz = source.tz;
  dest.heights.set(source.heights);
  dest.materials.set(source.materials);
}

/**
 * Clone a map tile
 */
export function cloneMapTile(tile: MapTileData): MapTileData {
  return {
    tx: tile.tx,
    tz: tile.tz,
    heights: new Int16Array(tile.heights),
    materials: new Uint8Array(tile.materials),
  };
}
