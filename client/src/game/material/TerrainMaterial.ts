/**
 * TerrainMaterial - PBR material with tri-planar texture mapping
 * 
 * Uses DataArrayTextures for efficient multi-material rendering.
 * Supports smooth blending between materials at vertex level.
 */

import * as THREE from 'three';
import { textureCache } from './TextureCache.js';
import { getMaterialPallet } from './MaterialPallet.js';
import { MATERIAL_BASE_URL, TERRAIN_MATERIAL_REPEAT_SCALE, TERRAIN_MATERIAL_BLEND_OFFSET_RAD } from './constants.js';

export type TextureResolution = 'low' | 'high';

export interface LoadedTextures {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  ao: THREE.DataArrayTexture;
  roughness: THREE.DataArrayTexture;
}

/**
 * Load texture binary data, using cache if available.
 */
async function loadTextureData(
  resolution: TextureResolution,
  mapType: string,
  version: string
): Promise<ArrayBuffer> {
  // Try cache first
  let arrayBuffer = await textureCache.getTexture(resolution, mapType);
  
  if (!arrayBuffer) {
    console.log(`Cache miss: Fetching ${resolution}/${mapType} from network`);
    
    const response = await fetch(`${MATERIAL_BASE_URL}/${resolution}/${mapType}.bin`, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    
    if (!response.ok) {
      throw new Error(`Failed to fetch ${resolution}/${mapType}: ${response.status}`);
    }
    
    arrayBuffer = await response.arrayBuffer();
    
    // Save to cache
    await textureCache.saveTexture(resolution, mapType, arrayBuffer, version);
    const sizeMB = (arrayBuffer.byteLength / (1024 * 1024)).toFixed(2);
    console.log(`Cached ${resolution}/${mapType} (${sizeMB} MB)`);
  } else {
    console.log(`Cache hit: Loaded ${resolution}/${mapType} from IndexedDB`);
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
  // Create a new typed array with a proper ArrayBuffer to satisfy Three.js types
  const texture = new THREE.DataArrayTexture(data.buffer as ArrayBuffer, width, height, layers);
  
  // Set format based on channel count
  if (channels.length === 4) {
    texture.format = THREE.RGBAFormat;
  } else if (channels.length === 1) {
    texture.format = THREE.RedFormat;
  }
  
  texture.type = THREE.UnsignedByteType;
  
  // Filtering based on resolution
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
  const mapTypes = ['albedo', 'normal', 'ao', 'roughness'] as const;
  const pallet = await getMaterialPallet();
  const version = 'v1'; // TODO: Get from latest.json
  
  const textures: Partial<LoadedTextures> = {};
  let loaded = 0;
  
  for (const mapType of mapTypes) {
    const meta = pallet.maps[resolution][mapType];
    if (!meta) {
      throw new Error(`Missing metadata for ${resolution}/${mapType}`);
    }
    
    const arrayBuffer = await loadTextureData(resolution, mapType, version);
    const data = new Uint8Array(arrayBuffer);
    
    textures[mapType] = createDataArrayTexture(
      data,
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

/**
 * Create a dummy placeholder texture.
 */
function createDummyTexture(color: { r: number; g: number; b: number; a: number }): THREE.DataArrayTexture {
  const width = 4;
  const height = 4;
  const layers = 1;
  const channels = 4;
  const size = width * height;
  const data = new Uint8Array(size * channels * layers);
  
  for (let layer = 0; layer < layers; layer++) {
    for (let i = 0; i < size; i++) {
      const idx = layer * size * channels + i * channels;
      data[idx] = color.r;
      data[idx + 1] = color.g;
      data[idx + 2] = color.b;
      data[idx + 3] = color.a;
    }
  }
  
  const texture = new THREE.DataArrayTexture(data, width, height, layers);
  texture.format = THREE.RGBAFormat;
  texture.type = THREE.UnsignedByteType;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  
  return texture;
}

// ============== Shader Code ==============

const vertexShaderPrefix = /* glsl */ `
  attribute vec3 materialIds;
  attribute vec3 materialWeights;
  
  flat varying vec3 vMaterialIds;
  varying vec3 vMaterialWeights;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  
  uniform float repeatScale;
`;

const vertexShaderSuffix = /* glsl */ `
  vMaterialIds = materialIds;
  vMaterialWeights = materialWeights;
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
`;

const fragmentShaderPrefix = /* glsl */ `
  uniform sampler2DArray mapArray;
  uniform sampler2DArray normalArray;
  uniform sampler2DArray aoArray;
  uniform sampler2DArray roughnessArray;
  uniform float repeatScale;
  uniform mat3 blendOffset;
  
  flat varying vec3 vMaterialIds;
  varying vec3 vMaterialWeights;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  
  vec3 getTriPlanarBlend(vec3 normal) {
    vec3 blending = blendOffset * normal;
    blending = pow(abs(blending), vec3(2.0));
    blending = normalize(max(blending, 0.00001));
    float b = blending.x + blending.y + blending.z;
    return blending / b;
  }
  
  vec3 getWeightedBlend() {
    vec3 w = vMaterialWeights;
    w = pow(abs(w), vec3(2.0));
    w = normalize(max(w, 0.00001));
    return w / (w.x + w.y + w.z);
  }
  
  vec4 sampleTriPlanar(sampler2DArray tex, vec3 pos, vec3 blend, float layer) {
    vec4 xaxis = texture(tex, vec3(pos.zy * repeatScale, layer));
    vec4 yaxis = texture(tex, vec3(pos.xz * repeatScale, layer));
    vec4 zaxis = texture(tex, vec3(pos.xy * repeatScale, layer));
    return xaxis * blend.x + yaxis * blend.y + zaxis * blend.z;
  }
  
  vec4 sampleMaterialBlend(sampler2DArray tex, vec3 pos, vec3 triBlend) {
    vec3 matBlend = getWeightedBlend();
    vec4 m0 = sampleTriPlanar(tex, pos, triBlend, vMaterialIds.x);
    vec4 m1 = sampleTriPlanar(tex, pos, triBlend, vMaterialIds.y);
    vec4 m2 = sampleTriPlanar(tex, pos, triBlend, vMaterialIds.z);
    return m0 * matBlend.x + m1 * matBlend.y + m2 * matBlend.z;
  }
`;

// ============== TerrainMaterial Class ==============

// Shader type for onBeforeCompile callback
interface ShaderWithUniforms {
  uniforms: Record<string, { value: unknown }>;
  vertexShader: string;
  fragmentShader: string;
}

export class TerrainMaterial extends THREE.MeshStandardMaterial {
  private _shader: ShaderWithUniforms | null = null;
  private textures: LoadedTextures | null = null;
  
  constructor(isTransparent: boolean = false) {
    super({
      roughness: 0.8,
      metalness: 0.05,
      transparent: isTransparent,
      side: isTransparent ? THREE.DoubleSide : THREE.FrontSide,
    });
    
    // Set up dummy textures initially
    this.setTextures({
      albedo: createDummyTexture({ r: 128, g: 128, b: 128, a: 255 }),
      normal: createDummyTexture({ r: 128, g: 128, b: 255, a: 255 }),
      ao: createDummyTexture({ r: 255, g: 255, b: 255, a: 255 }),
      roughness: createDummyTexture({ r: 200, g: 200, b: 200, a: 255 }),
    });
    
    this.onBeforeCompile = (shader) => {
      this._shader = shader;
      
      // Add uniforms
      shader.uniforms.mapArray = { value: this.textures?.albedo };
      shader.uniforms.normalArray = { value: this.textures?.normal };
      shader.uniforms.aoArray = { value: this.textures?.ao };
      shader.uniforms.roughnessArray = { value: this.textures?.roughness };
      shader.uniforms.repeatScale = { value: TERRAIN_MATERIAL_REPEAT_SCALE };
      shader.uniforms.blendOffset = { value: this.createBlendOffsetMatrix() };
      
      // Modify vertex shader
      shader.vertexShader = vertexShaderPrefix + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\n${vertexShaderSuffix}`
      );
      
      // Modify fragment shader
      shader.fragmentShader = fragmentShaderPrefix + shader.fragmentShader;
      
      // Replace diffuse color calculation
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        /* glsl */ `
          vec3 pos = vWorldPosition / 8.0;
          vec3 triBlend = getTriPlanarBlend(vWorldNormal);
          vec4 sampledAlbedo = sampleMaterialBlend(mapArray, pos, triBlend);
          vec4 diffuseColor = vec4(sampledAlbedo.rgb, opacity * sampledAlbedo.a);
        `
      );
      
      // Replace roughness calculation
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
          vec3 pos_r = vWorldPosition / 8.0;
          vec3 triBlend_r = getTriPlanarBlend(vWorldNormal);
          float roughnessFactor = sampleMaterialBlend(roughnessArray, pos_r, triBlend_r).r;
        `
      );
      
      // Replace AO calculation  
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        /* glsl */ `
          #ifdef USE_AOMAP
            vec3 pos_ao = vWorldPosition / 8.0;
            vec3 triBlend_ao = getTriPlanarBlend(vWorldNormal);
            float ambientOcclusion = sampleMaterialBlend(aoArray, pos_ao, triBlend_ao).r;
            reflectedLight.indirectDiffuse *= ambientOcclusion;
          #endif
        `
      );
    };
  }
  
  private createBlendOffsetMatrix(): THREE.Matrix3 {
    const rad = TERRAIN_MATERIAL_BLEND_OFFSET_RAD;
    const euler = new THREE.Euler(rad, rad, rad, 'XYZ');
    const quat = new THREE.Quaternion().setFromEuler(euler);
    const mat4 = new THREE.Matrix4().makeRotationFromQuaternion(quat);
    return new THREE.Matrix3().setFromMatrix4(mat4);
  }
  
  setTextures(textures: LoadedTextures): void {
    this.textures = textures;
    
    if (this._shader) {
      this._shader.uniforms.mapArray.value = textures.albedo;
      this._shader.uniforms.normalArray.value = textures.normal;
      this._shader.uniforms.aoArray.value = textures.ao;
      this._shader.uniforms.roughnessArray.value = textures.roughness;
      this.needsUpdate = true;
    }
  }
  
  setRepeatScale(scale: number): void {
    if (this._shader) {
      this._shader.uniforms.repeatScale.value = scale;
      this.needsUpdate = true;
    }
  }
}

// ============== Singleton Instances ==============

let solidMaterial: TerrainMaterial | null = null;
let transparentMaterial: TerrainMaterial | null = null;

/**
 * Get the shared solid terrain material instance.
 */
export function getTerrainMaterial(): TerrainMaterial {
  if (!solidMaterial) {
    solidMaterial = new TerrainMaterial(false);
  }
  return solidMaterial;
}

/**
 * Get the shared transparent terrain material instance.
 */
export function getTransparentTerrainMaterial(): TerrainMaterial {
  if (!transparentMaterial) {
    transparentMaterial = new TerrainMaterial(true);
  }
  return transparentMaterial;
}

/**
 * Initialize the material system by loading textures.
 * Call this at app startup.
 */
export async function initializeMaterials(
  resolution: TextureResolution = 'low',
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  const textures = await loadDataArrayTextures(resolution, onProgress);
  
  getTerrainMaterial().setTextures(textures);
  getTransparentTerrainMaterial().setTextures(textures);
  
  console.log(`Material system initialized with ${resolution} resolution`);
}

/**
 * Upgrade to high-resolution textures.
 * Call this after initial render with low-res textures.
 */
export async function upgradeToHighRes(
  onProgress?: (loaded: number, total: number) => void
): Promise<void> {
  const textures = await loadDataArrayTextures('high', onProgress);
  
  getTerrainMaterial().setTextures(textures);
  getTransparentTerrainMaterial().setTextures(textures);
  
  console.log('Upgraded to high resolution textures');
}

/**
 * Check if high-res textures are cached.
 */
export async function isHighResCached(): Promise<boolean> {
  return textureCache.hasResolution('high');
}
