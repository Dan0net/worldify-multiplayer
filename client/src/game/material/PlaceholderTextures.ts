/**
 * Placeholder Textures
 * 
 * Creates minimal placeholder textures for immediate visual feedback
 * while full textures load from the network.
 */

import * as THREE from 'three';
import type { LoadedTextures } from './TerrainMaterial.js';
import { getMaterialPallet } from './MaterialPallet.js';

// ============== Color Utilities ==============

/** Parse hex color string to RGB values (0-255) */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const cleanHex = hex.startsWith('#') ? hex.slice(1) : hex;
  const num = parseInt(cleanHex, 16);
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

// ============== Texture Factory ==============

interface TextureOptions {
  width?: number;
  height?: number;
  layers: number;
  channels: 1 | 4;
}

/** Common texture property setup */
function configureTexture(texture: THREE.DataArrayTexture, channels: 1 | 4): void {
  texture.format = channels === 4 ? THREE.RGBAFormat : THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  if (channels === 1) {
    texture.internalFormat = 'R8';
  }
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
}

/**
 * Create a placeholder texture with a fill function per layer.
 * The fill function receives the layer index and returns channel values.
 */
function createPlaceholderTexture(
  options: TextureOptions,
  fillLayer: (layer: number) => number[]
): THREE.DataArrayTexture {
  const { width = 1, height = 1, layers, channels } = options;
  const size = width * height;
  const data = new Uint8Array(size * channels * layers);

  for (let layer = 0; layer < layers; layer++) {
    const values = fillLayer(layer);
    for (let i = 0; i < size; i++) {
      const idx = (layer * size + i) * channels;
      for (let c = 0; c < channels; c++) {
        data[idx + c] = values[c] ?? 0;
      }
    }
  }

  const texture = new THREE.DataArrayTexture(data, width, height, layers);
  configureTexture(texture, channels);
  return texture;
}

// ============== Placeholder Presets ==============

/** Create a uniform RGBA texture (same color for all layers) */
export function createUniformRGBA(
  layers: number,
  r: number, g: number, b: number, a: number = 255
): THREE.DataArrayTexture {
  return createPlaceholderTexture(
    { layers, channels: 4 },
    () => [r, g, b, a]
  );
}

/** Create a uniform single-channel texture (same value for all layers) */
export function createUniformR(layers: number, value: number): THREE.DataArrayTexture {
  return createPlaceholderTexture(
    { layers, channels: 1 },
    () => [value]
  );
}

/** Create an albedo texture from pallet hex colors (one color per layer) */
export function createAlbedoFromColors(colors: string[]): THREE.DataArrayTexture {
  return createPlaceholderTexture(
    { layers: colors.length, channels: 4 },
    (layer) => {
      const { r, g, b } = parseHexColor(colors[layer] || '#808080');
      return [r, g, b, 255];
    }
  );
}

// ============== Default Placeholder Set ==============

/** Default texture colors when no pallet is available */
const DEFAULTS = {
  albedo: { r: 128, g: 128, b: 128 },
  normal: { r: 128, g: 128, b: 255 },  // Flat normal pointing up
  ao: 255,                               // No occlusion
  roughness: 200,                        // Fairly rough
  metalness: 0,                          // Non-metallic
} as const;

/** Create default placeholder textures (single layer, neutral values) */
export function createDefaultPlaceholders(): LoadedTextures {
  return {
    albedo: createUniformRGBA(1, DEFAULTS.albedo.r, DEFAULTS.albedo.g, DEFAULTS.albedo.b),
    normal: createUniformRGBA(1, DEFAULTS.normal.r, DEFAULTS.normal.g, DEFAULTS.normal.b),
    ao: createUniformR(1, DEFAULTS.ao),
    roughness: createUniformR(1, DEFAULTS.roughness),
    metalness: createUniformR(1, DEFAULTS.metalness),
  };
}

/** Create placeholder textures from material pallet colors */
export function createPalletPlaceholders(colors: string[]): LoadedTextures {
  const layers = colors.length;
  return {
    albedo: createAlbedoFromColors(colors),
    normal: createUniformRGBA(layers, DEFAULTS.normal.r, DEFAULTS.normal.g, DEFAULTS.normal.b),
    ao: createUniformR(layers, DEFAULTS.ao),
    roughness: createUniformR(layers, DEFAULTS.roughness),
    metalness: createUniformR(layers, DEFAULTS.metalness),
  };
}

/** Fetch pallet and create placeholder textures from it */
export function loadPalletPlaceholders(): LoadedTextures {
  const pallet = getMaterialPallet();
  return createPalletPlaceholders(pallet.colors);
}
