/**
 * TerrainMaterial - PBR material with tri-planar texture mapping
 * 
 * Uses DataArrayTextures for efficient multi-material rendering.
 * Supports smooth blending between materials at vertex level.
 */

import * as THREE from 'three';
import { textureCache } from './TextureCache.js';
import { getMaterialPallet } from './MaterialPallet.js';
import { TERRAIN_MATERIAL_REPEAT_SCALE, TERRAIN_MATERIAL_BLEND_OFFSET_RAD } from './constants.js';
import { createDefaultPlaceholders, loadPalletPlaceholders } from './PlaceholderTextures.js';
import {
  terrainVertexPrefix,
  terrainVertexSuffix,
  terrainFragmentPrefix,
  terrainDiffuseFragment,
  terrainRoughnessFragment,
  terrainMetalnessFragment,
  terrainAoFragment,
  terrainNormalFragment,
  terrainDebugFragment,
  depthVertexPrefix,
  depthVertexSuffix,
  depthFragmentPrefix,
  depthAlphaDiscard,
} from './terrainShaders.js';

export type TextureResolution = 'low' | 'high';

/** Alpha threshold for shadow depth testing on transparent materials */
const ALPHA_CUTOFF = 0.5;

// Wind animation parameters
const WIND_STRENGTH = 0.1;
const WIND_SPEED = 0.7;
const WIND_FREQUENCY = 1.0;

export interface LoadedTextures {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  ao: THREE.DataArrayTexture;
  roughness: THREE.DataArrayTexture;
  metalness: THREE.DataArrayTexture;
}

// ============== Texture Loading ==============

/**
 * Load texture binary data, using cache if available.
 */
async function loadTextureData(
  resolution: TextureResolution,
  mapType: string,
  version: string,
  baseUrl: string
): Promise<ArrayBuffer> {
  let arrayBuffer = await textureCache.getTexture(resolution, mapType, version);
  
  if (!arrayBuffer) {
    console.log(`Cache miss: Fetching ${resolution}/${mapType} from network`);
    
    const response = await fetch(`${baseUrl}/${resolution}/${mapType}.bin`, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch ${resolution}/${mapType}: ${response.status}`);
    }
    
    arrayBuffer = await response.arrayBuffer();
    await textureCache.saveTexture(resolution, mapType, arrayBuffer, version);
    
    const sizeMB = (arrayBuffer.byteLength / (1024 * 1024)).toFixed(2);
    console.log(`Cached ${resolution}/${mapType} (${sizeMB} MB) [${version}]`);
  } else {
    console.log(`Cache hit: Loaded ${resolution}/${mapType} from IndexedDB [${version}]`);
  }
  
  return arrayBuffer;
}

/**
 * Create a DataArrayTexture from loaded binary data.
 */
function createDataArrayTexture(
  data: Uint8Array,
  width: number,
  height: number,
  layers: number,
  channels: string,
  resolution: TextureResolution
): THREE.DataArrayTexture {
  const channelCount = channels.length;
  const texture = new THREE.DataArrayTexture(data as unknown as BufferSource, width, height, layers);
  
  texture.format = channelCount === 4 ? THREE.RGBAFormat : THREE.RedFormat;
  texture.type = THREE.UnsignedByteType;
  texture.internalFormat = channelCount === 4 ? 'RGBA8' : 'R8';
  
  if (resolution === 'low') {
    texture.minFilter = THREE.NearestMipmapLinearFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.anisotropy = 1;
  } else {
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 8;
  }
  
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  
  return texture;
}

/**
 * Load all textures for a given resolution.
 */
export async function loadDataArrayTextures(
  resolution: TextureResolution,
  onProgress?: (loaded: number, total: number) => void
): Promise<LoadedTextures> {
  const mapTypes = ['albedo', 'normal', 'ao', 'roughness', 'metalness'] as const;
  const pallet = getMaterialPallet();
  const version = await textureCache.getLatestVersion();
  const baseUrl = await textureCache.getLatestMaterialUrl();
  
  const textures: Partial<LoadedTextures> = {};
  let loaded = 0;
  
  for (const mapType of mapTypes) {
    const meta = pallet.maps[resolution][mapType];
    if (!meta) {
      throw new Error(`Missing metadata for ${resolution}/${mapType}`);
    }
    
    const arrayBuffer = await loadTextureData(resolution, mapType, version, baseUrl);
    textures[mapType] = createDataArrayTexture(
      new Uint8Array(arrayBuffer),
      meta.width,
      meta.height,
      meta.layers,
      meta.channels,
      resolution
    );
    
    loaded++;
    onProgress?.(loaded, mapTypes.length);
  }
  
  return textures as LoadedTextures;
}

// ============== Shader Utilities ==============

interface ShaderWithUniforms {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
  defines?: Record<string, string | number | boolean>;
}

function createBlendOffsetMatrix(): THREE.Matrix3 {
  const rad = TERRAIN_MATERIAL_BLEND_OFFSET_RAD;
  const euler = new THREE.Euler(rad, rad, rad, 'XYZ');
  const quat = new THREE.Quaternion().setFromEuler(euler);
  const mat4 = new THREE.Matrix4().makeRotationFromQuaternion(quat);
  return new THREE.Matrix3().setFromMatrix4(mat4);
}

// ============== TerrainMaterial Class ==============

export class TerrainMaterial extends THREE.MeshStandardMaterial {
  private _shader: ShaderWithUniforms | null = null;
  private textures: LoadedTextures | null = null;
  private _windSpeed: number = WIND_SPEED;
  
  constructor(isTransparent: boolean = false) {
    super({
      roughness: 1.0,
      metalness: 1.0,
      transparent: isTransparent,
      side: isTransparent ? THREE.DoubleSide : THREE.FrontSide,
      alphaTest: isTransparent ? ALPHA_CUTOFF : 0,
      normalMap: new THREE.Texture(),
      normalScale: new THREE.Vector2(-1, -1),
    });
    
    this.setTextures(createDefaultPlaceholders());
    
    this.onBeforeCompile = (shader) => {
      this._shader = shader;
      
      shader.uniforms.mapArray = { value: this.textures?.albedo };
      shader.uniforms.normalArray = { value: this.textures?.normal };
      shader.uniforms.aoArray = { value: this.textures?.ao };
      shader.uniforms.roughnessArray = { value: this.textures?.roughness };
      shader.uniforms.metalnessArray = { value: this.textures?.metalness };
      shader.uniforms.repeatScale = { value: TERRAIN_MATERIAL_REPEAT_SCALE };
      shader.uniforms.blendOffset = { value: createBlendOffsetMatrix() };
      shader.uniforms.debugMode = { value: 0 };
      
      // Material adjustment uniforms
      shader.uniforms.roughnessMultiplier = { value: 0.6 };
      shader.uniforms.metalnessMultiplier = { value: 1.0 };
      shader.uniforms.aoIntensity = { value: 1.0 };
      shader.uniforms.normalStrength = { value: 2.0 };
      shader.uniforms.blendSharpness = { value: 8.0 };
      
      if (isTransparent) {
        shader.defines = shader.defines || {};
        shader.defines.USE_TEXTURE_ALPHA = '';
        shader.defines.USE_WIND = '';
        shader.uniforms.uTime = { value: 0.0 };
        shader.uniforms.uWindStrength = { value: WIND_STRENGTH };
        shader.uniforms.uWindFrequency = { value: WIND_FREQUENCY };
      }
      
      // Vertex shader modifications
      shader.vertexShader = terrainVertexPrefix + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\n${terrainVertexSuffix}`
      );
      
      // Fragment shader modifications
      shader.fragmentShader = terrainFragmentPrefix + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        terrainDiffuseFragment
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        terrainRoughnessFragment
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <metalnessmap_fragment>',
        terrainMetalnessFragment
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        terrainAoFragment
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        terrainNormalFragment
      );
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        terrainDebugFragment
      );
    };
  }
  
  setTextures(textures: LoadedTextures): void {
    this.textures = textures;
    if (this._shader) {
      this._shader.uniforms.mapArray.value = textures.albedo;
      this._shader.uniforms.normalArray.value = textures.normal;
      this._shader.uniforms.aoArray.value = textures.ao;
      this._shader.uniforms.roughnessArray.value = textures.roughness;
      this._shader.uniforms.metalnessArray.value = textures.metalness;
      this.needsUpdate = true;
    }
  }
  
  setRepeatScale(scale: number): void {
    if (this._shader) {
      this._shader.uniforms.repeatScale.value = scale;
      this.needsUpdate = true;
    }
  }
  
  setDebugMode(mode: number): void {
    if (this._shader) {
      this._shader.uniforms.debugMode.value = mode;
    }
  }
  
  setWindTime(time: number): void {
    if (this._shader?.uniforms.uTime) {
      this._shader.uniforms.uTime.value = time * this._windSpeed;
    }
  }
  
  // ============== Material Adjustment Setters ==============
  
  setRoughnessMultiplier(value: number): void {
    if (this._shader) {
      this._shader.uniforms.roughnessMultiplier.value = value;
    }
  }
  
  setMetalnessMultiplier(value: number): void {
    if (this._shader) {
      this._shader.uniforms.metalnessMultiplier.value = value;
    }
  }
  
  setAoIntensity(value: number): void {
    if (this._shader) {
      this._shader.uniforms.aoIntensity.value = value;
    }
  }
  
  setNormalStrength(value: number): void {
    if (this._shader) {
      this._shader.uniforms.normalStrength.value = value;
    }
  }
  
  setBlendSharpness(value: number): void {
    if (this._shader) {
      this._shader.uniforms.blendSharpness.value = value;
    }
  }
  
  setWindStrength(value: number): void {
    if (this._shader?.uniforms.uWindStrength) {
      this._shader.uniforms.uWindStrength.value = value;
    }
  }
  
  setWindFrequency(value: number): void {
    if (this._shader?.uniforms.uWindFrequency) {
      this._shader.uniforms.uWindFrequency.value = value;
    }
  }
  
  setWindSpeed(value: number): void {
    this._windSpeed = value;
  }
}

// ============== Debug Mode Constants ==============

export const TERRAIN_DEBUG_MODES = {
  OFF: 0,
  ALBEDO: 1,
  NORMAL: 2,
  AO: 3,
  ROUGHNESS: 4,
  TRI_BLEND: 5,
  MATERIAL_IDS: 6,
  MATERIAL_WEIGHTS: 7,
  WORLD_NORMAL: 8,
} as const;

export type TerrainDebugMode = typeof TERRAIN_DEBUG_MODES[keyof typeof TERRAIN_DEBUG_MODES];

// ============== TransparentDepthMaterial ==============

class TransparentDepthMaterial extends THREE.MeshDepthMaterial {
  private _shader: ShaderWithUniforms | null = null;
  private textures: LoadedTextures | null = null;

  constructor() {
    super({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.DoubleSide,
    });

    this.setTextures(createDefaultPlaceholders());

    this.onBeforeCompile = (shader) => {
      this._shader = shader;

      shader.uniforms.mapArray = { value: this.textures?.albedo };
      shader.uniforms.repeatScale = { value: TERRAIN_MATERIAL_REPEAT_SCALE };
      shader.uniforms.blendOffset = { value: createBlendOffsetMatrix() };
      shader.uniforms.alphaCutoff = { value: ALPHA_CUTOFF };
      shader.uniforms.blendSharpness = { value: 2.0 };
      shader.uniforms.uTime = { value: 0.0 };
      shader.uniforms.uWindStrength = { value: WIND_STRENGTH };
      shader.uniforms.uWindFrequency = { value: WIND_FREQUENCY };

      // Vertex shader
      shader.vertexShader = depthVertexPrefix + shader.vertexShader;
      if (shader.vertexShader.includes('#include <skinning_vertex>')) {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <skinning_vertex>',
          `#include <skinning_vertex>\n${depthVertexSuffix}`
        );
      } else if (shader.vertexShader.includes('#include <project_vertex>')) {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <project_vertex>',
          `${depthVertexSuffix}\n#include <project_vertex>`
        );
      }

      // Fragment shader
      shader.fragmentShader = depthFragmentPrefix + shader.fragmentShader;
      if (shader.fragmentShader.includes('vec4 diffuseColor = vec4( 1.0 );')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          'vec4 diffuseColor = vec4( 1.0 );',
          `vec4 diffuseColor = vec4( 1.0 );\n${depthAlphaDiscard}`
        );
      } else {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>\n${depthAlphaDiscard}`
        );
      }
    };
  }

  setTextures(textures: LoadedTextures): void {
    this.textures = textures;
    if (this._shader) {
      this._shader.uniforms.mapArray.value = textures.albedo;
      this.needsUpdate = true;
    }
  }
  
  setWindTime(time: number): void {
    if (this._shader?.uniforms.uTime) {
      this._shader.uniforms.uTime.value = time * WIND_SPEED;
    }
  }
}

// ============== Singleton Instances ==============

let solidMaterial: TerrainMaterial | null = null;
let transparentMaterial: TerrainMaterial | null = null;
let liquidMaterial: TerrainMaterial | null = null;
let transparentDepthMaterial: TransparentDepthMaterial | null = null;

export function getTerrainMaterial(): TerrainMaterial {
  if (!solidMaterial) solidMaterial = new TerrainMaterial(false);
  return solidMaterial;
}

export function getTransparentTerrainMaterial(): TerrainMaterial {
  if (!transparentMaterial) transparentMaterial = new TerrainMaterial(true);
  return transparentMaterial;
}

export function getLiquidTerrainMaterial(): TerrainMaterial {
  if (!liquidMaterial) liquidMaterial = new TerrainMaterial(true);
  return liquidMaterial;
}

export function getTransparentDepthMaterial(): TransparentDepthMaterial {
  if (!transparentDepthMaterial) transparentDepthMaterial = new TransparentDepthMaterial();
  return transparentDepthMaterial;
}

// ============== Material Management ==============

/** Set textures on all terrain materials */
function setAllMaterialTextures(textures: LoadedTextures): void {
  getTerrainMaterial().setTextures(textures);
  getTransparentTerrainMaterial().setTextures(textures);
  getLiquidTerrainMaterial().setTextures(textures);
  getTransparentDepthMaterial().setTextures(textures);
}

/**
 * Initialize placeholder textures from the pallet.
 * Call this early to show colored terrain while full textures load.
 */
export function initializePlaceholderTextures(): void {
  const textures = loadPalletPlaceholders();
  setAllMaterialTextures(textures);
  console.log('Placeholder textures initialized from pallet');
}

/**
 * Initialize the material system by loading textures.
 */
export async function initializeMaterials(
  resolution: TextureResolution = 'low',
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  const textures = await loadDataArrayTextures(resolution, onProgress);
  setAllMaterialTextures(textures);
  console.log(`Material system initialized with ${resolution} resolution`);
}

/**
 * Upgrade to high-resolution textures.
 */
export async function upgradeToHighRes(
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  const textures = await loadDataArrayTextures('high', onProgress);
  setAllMaterialTextures(textures);
  console.log('Upgraded to high resolution textures');
}

/**
 * Check if high-res textures are cached.
 */
export async function isHighResCached(): Promise<boolean> {
  return textureCache.hasResolution('high');
}

/**
 * Set debug mode for all terrain materials.
 */
export function setTerrainDebugMode(mode: TerrainDebugMode): void {
  getTerrainMaterial().setDebugMode(mode);
  getTransparentTerrainMaterial().setDebugMode(mode);
  getLiquidTerrainMaterial().setDebugMode(mode);
  
  const modeNames = ['OFF', 'ALBEDO', 'NORMAL', 'AO', 'ROUGHNESS', 'TRI_BLEND', 'MATERIAL_IDS', 'MATERIAL_WEIGHTS', 'WORLD_NORMAL'];
  console.log(`Terrain debug mode: ${modeNames[mode] || mode}`);
}

/**
 * Update wind animation time for transparent materials.
 */
export function updateWindTime(elapsedTime: number): void {
  transparentMaterial?.setWindTime(elapsedTime);
  liquidMaterial?.setWindTime(elapsedTime);
  transparentDepthMaterial?.setWindTime(elapsedTime);
}

// ============== Material Settings API ==============

/** Material settings interface matching store */
export interface MaterialSettingsUpdate {
  roughnessMultiplier?: number;
  metalnessMultiplier?: number;
  aoIntensity?: number;
  normalStrength?: number;
  blendSharpness?: number;
  repeatScale?: number;
  windStrength?: number;
  windSpeed?: number;
  windFrequency?: number;
}

/**
 * Apply material settings to all terrain materials.
 * Called from the bridge when store state changes.
 */
export function applyMaterialSettings(settings: MaterialSettingsUpdate): void {
  const materials = [solidMaterial, transparentMaterial, liquidMaterial];
  
  for (const mat of materials) {
    if (!mat) continue;
    
    if (settings.roughnessMultiplier !== undefined) {
      mat.setRoughnessMultiplier(settings.roughnessMultiplier);
    }
    if (settings.metalnessMultiplier !== undefined) {
      mat.setMetalnessMultiplier(settings.metalnessMultiplier);
    }
    if (settings.aoIntensity !== undefined) {
      mat.setAoIntensity(settings.aoIntensity);
    }
    if (settings.normalStrength !== undefined) {
      mat.setNormalStrength(settings.normalStrength);
    }
    if (settings.blendSharpness !== undefined) {
      mat.setBlendSharpness(settings.blendSharpness);
    }
    if (settings.repeatScale !== undefined) {
      mat.setRepeatScale(settings.repeatScale);
    }
    if (settings.windStrength !== undefined) {
      mat.setWindStrength(settings.windStrength);
    }
    if (settings.windSpeed !== undefined) {
      mat.setWindSpeed(settings.windSpeed);
    }
    if (settings.windFrequency !== undefined) {
      mat.setWindFrequency(settings.windFrequency);
    }
  }
}

/**
 * Set repeat scale for all terrain materials.
 */
export function setTerrainRepeatScale(scale: number): void {
  solidMaterial?.setRepeatScale(scale);
  transparentMaterial?.setRepeatScale(scale);
  liquidMaterial?.setRepeatScale(scale);
}

// ============== Debug Console Access ==============

if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).terrainDebug = {
    modes: TERRAIN_DEBUG_MODES,
    set: setTerrainDebugMode,
    off: () => setTerrainDebugMode(TERRAIN_DEBUG_MODES.OFF),
    albedo: () => setTerrainDebugMode(TERRAIN_DEBUG_MODES.ALBEDO),
    normal: () => setTerrainDebugMode(TERRAIN_DEBUG_MODES.NORMAL),
    ao: () => setTerrainDebugMode(TERRAIN_DEBUG_MODES.AO),
    roughness: () => setTerrainDebugMode(TERRAIN_DEBUG_MODES.ROUGHNESS),
    triBlend: () => setTerrainDebugMode(TERRAIN_DEBUG_MODES.TRI_BLEND),
    materialIds: () => setTerrainDebugMode(TERRAIN_DEBUG_MODES.MATERIAL_IDS),
    materialWeights: () => setTerrainDebugMode(TERRAIN_DEBUG_MODES.MATERIAL_WEIGHTS),
    worldNormal: () => setTerrainDebugMode(TERRAIN_DEBUG_MODES.WORLD_NORMAL),
  };
  console.log('Terrain debug controls available: window.terrainDebug.albedo(), .normal(), .ao(), .roughness(), .off(), etc.');
}
