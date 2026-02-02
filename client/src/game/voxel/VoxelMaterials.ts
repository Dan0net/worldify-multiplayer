/**
 * VoxelMaterials - Material definitions for voxel terrain rendering
 */

import * as THREE from 'three';
import { getTerrainMaterial, getTransparentTerrainMaterial, getLiquidTerrainMaterial, getTransparentDepthMaterial } from '../material/TerrainMaterial.js';

// Re-export terrain material getters for easy access
export { getTerrainMaterial, getTransparentTerrainMaterial, getLiquidTerrainMaterial, getTransparentDepthMaterial };

// ============== Material Color Palette ==============

/**
 * Color palette for material IDs.
 * Index corresponds to material ID (0-127).
 */
export const MATERIAL_COLORS: THREE.Color[] = [
  new THREE.Color(0x4CAF50), // 0: Green (grass)
  new THREE.Color(0xF44336), // 1: Red
  new THREE.Color(0x2196F3), // 2: Blue
  new THREE.Color(0xFFEB3B), // 3: Yellow
  new THREE.Color(0x00BCD4), // 4: Cyan
  new THREE.Color(0xE91E63), // 5: Magenta
  new THREE.Color(0xFF9800), // 6: Orange
  new THREE.Color(0x9C27B0), // 7: Purple
  new THREE.Color(0x795548), // 8: Brown (dirt)
  new THREE.Color(0x607D8B), // 9: Gray (stone)
  new THREE.Color(0xFFFFFF), // 10: White (snow)
  new THREE.Color(0x8BC34A), // 11: Light green
  new THREE.Color(0x3F51B5), // 12: Indigo
  new THREE.Color(0xCDDC39), // 13: Lime
  new THREE.Color(0x009688), // 14: Teal
  new THREE.Color(0xFFC107), // 15: Amber
];

// Fill remaining slots with procedurally generated colors
for (let i = MATERIAL_COLORS.length; i < 128; i++) {
  const hue = (i * 0.618033988749895) % 1; // Golden ratio for nice distribution
  const saturation = 0.5 + (i % 3) * 0.2;
  const lightness = 0.4 + (i % 5) * 0.1;
  MATERIAL_COLORS.push(new THREE.Color().setHSL(hue, saturation, lightness));
}

/**
 * Get the color for a material ID.
 */
export function getMaterialColor(materialId: number): THREE.Color {
  const id = Math.max(0, Math.min(127, materialId | 0));
  return MATERIAL_COLORS[id];
}

// ============== Shared Material ==============

/**
 * Shared material for voxel terrain meshes.
 * Uses vertex colors for per-vertex material coloring.
 */
export const voxelMaterial = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.8,
  metalness: 0.1,
  flatShading: false, // Smooth shading for SurfaceNets
});

/**
 * Create a new material instance (for cases where unique material is needed).
 */
export function createVoxelMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.8,
    metalness: 0.1,
    flatShading: false,
  });
}

/**
 * Wireframe material for debug visualization.
 */
export const wireframeMaterial = new THREE.MeshBasicMaterial({
  color: 0x000000,
  wireframe: true,
  transparent: true,
  opacity: 0.3,
});

/**
 * Set wireframe mode on terrain materials.
 * This affects all chunk meshes using TerrainMaterial.
 * @param enabled Whether to enable wireframe rendering
 */
export function setVoxelWireframe(enabled: boolean): void {
  voxelMaterial.wireframe = enabled;
  getTerrainMaterial().wireframe = enabled;
  getTransparentTerrainMaterial().wireframe = enabled;
  getLiquidTerrainMaterial().wireframe = enabled;
}
