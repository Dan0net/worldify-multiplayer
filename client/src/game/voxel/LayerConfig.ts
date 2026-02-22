/**
 * LayerConfig - Shared mesh layer configuration for terrain rendering
 *
 * Defines the three terrain layers (solid, transparent, liquid) and provides
 * a factory function to create Three.js meshes with the correct material,
 * shadow, and render-order settings. Used by both ChunkMesh (standalone
 * per-chunk meshes) and TerrainBatch (merged group meshes).
 */

import * as THREE from 'three';
import {
  getTerrainMaterial,
  getTransparentTerrainMaterial,
  getLiquidTerrainMaterial,
  getTransparentDepthMaterial,
} from './VoxelMaterials.js';

// ============== Layer Indices ==============

export const LAYER_SOLID = 0;
export const LAYER_TRANSPARENT = 1;
export const LAYER_LIQUID = 2;
export const LAYER_COUNT = 3;

// ============== Layer Configuration ==============

interface MeshLayerConfig {
  material: () => THREE.Material;
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  customDepthMaterial?: () => THREE.Material;
  meshType: string;
}

const LAYER_CONFIGS: readonly MeshLayerConfig[] = [
  { // SOLID
    material: getTerrainMaterial,
    castShadow: true,
    receiveShadow: true,
    renderOrder: 0,
    meshType: 'solid',
  },
  { // TRANSPARENT
    material: getTransparentTerrainMaterial,
    castShadow: true,
    receiveShadow: true,
    renderOrder: 1,
    customDepthMaterial: getTransparentDepthMaterial,
    meshType: 'transparent',
  },
  { // LIQUID
    material: getLiquidTerrainMaterial,
    castShadow: false,
    receiveShadow: true,
    renderOrder: 2,
    meshType: 'liquid',
  },
];

// ============== Factory ==============

/**
 * Create a Three.js mesh with the correct material, shadow, and render-order
 * settings for the given terrain layer.
 */
export function createLayerMesh(
  geometry: THREE.BufferGeometry,
  layer: number,
  chunkKey?: string,
): THREE.Mesh {
  const config = LAYER_CONFIGS[layer];
  const mesh = new THREE.Mesh(geometry, config.material());
  if (chunkKey) {
    mesh.userData.chunkKey = chunkKey;
    mesh.userData.meshType = config.meshType;
  }
  mesh.castShadow = config.castShadow;
  mesh.receiveShadow = config.receiveShadow;
  mesh.renderOrder = config.renderOrder;
  if (config.customDepthMaterial) {
    mesh.customDepthMaterial = config.customDepthMaterial();
  }
  return mesh;
}
