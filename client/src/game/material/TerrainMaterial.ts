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

export type TextureResolution = 'low' | 'high';

/** Alpha threshold for shadow depth testing on transparent materials */
const ALPHA_CUTOFF = 0.5;

// Wind animation parameters
const WIND_STRENGTH = 0.1;   // Maximum displacement in meters
const WIND_SPEED = 0.7;       // Animation speed multiplier
const WIND_FREQUENCY = 1.0;    // Spatial frequency of wind waves

export interface LoadedTextures {
  albedo: THREE.DataArrayTexture;
  normal: THREE.DataArrayTexture;
  ao: THREE.DataArrayTexture;
  roughness: THREE.DataArrayTexture;
  metalness: THREE.DataArrayTexture;
}

/**
 * Load texture binary data, using cache if available.
 * Automatically checks for version updates and invalidates outdated cache.
 */
async function loadTextureData(
  resolution: TextureResolution,
  mapType: string,
  version: string,
  baseUrl: string
): Promise<ArrayBuffer> {
  // Try cache first, with version check
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
    
    // Save to cache with version tag
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
  
  // IMPORTANT: Pass the Uint8Array directly, not data.buffer
  // data.buffer may reference a larger ArrayBuffer if data is a view
  const texture = new THREE.DataArrayTexture(data as unknown as BufferSource, width, height, layers);
  
  // Set format based on channel count
  if (channelCount === 4) {
    texture.format = THREE.RGBAFormat;
  } else if (channelCount === 1) {
    texture.format = THREE.RedFormat;
  }
  
  texture.type = THREE.UnsignedByteType;
  texture.internalFormat = channelCount === 4 ? 'RGBA8' : 'R8';
  
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
  const mapTypes = ['albedo', 'normal', 'ao', 'roughness', 'metalness'] as const;
  const pallet = await getMaterialPallet();
  
  // Fetch latest version from R2 (cached for session)
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
  
  #ifdef USE_WIND
  uniform float uTime;
  uniform float uWindStrength;
  uniform float uWindFrequency;
  #endif
`;

const vertexShaderSuffix = /* glsl */ `
  vMaterialIds = materialIds;
  vMaterialWeights = materialWeights;
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  
  #ifdef USE_WIND
  // Wind animation - layered sine waves based on world position
  // vWorldPosition stays at original for texture sampling
  float windPhase = uTime + vWorldPosition.x * uWindFrequency + vWorldPosition.z * uWindFrequency * 0.7;
  float windX = sin(windPhase) * sin(windPhase * 0.4 + 1.3);
  float windY = sin(windPhase * 0.6 + 0.8) * sin(windPhase * 0.25) * 0.5;
  float windZ = sin(windPhase * 0.8 + 2.1) * sin(windPhase * 0.3);
  vec3 windOffset = vec3(windX, windY, windZ) * uWindStrength;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + windOffset, 1.0);
  #endif
`;

const fragmentShaderPrefix = /* glsl */ `
  uniform sampler2DArray mapArray;
  uniform sampler2DArray normalArray;
  uniform sampler2DArray aoArray;
  uniform sampler2DArray roughnessArray;
  uniform sampler2DArray metalnessArray;
  uniform float repeatScale;
  uniform mat3 blendOffset;
  uniform int debugMode; // 0=off, 1=albedo, 2=normal, 3=ao, 4=roughness, 5=triBlend, 6=materialIds
  
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
  
  // Sample a single axis with material blending
  vec4 sampleAxisMaterialBlend(sampler2DArray tex, vec2 uv) {
    vec3 matBlend = getWeightedBlend();
    vec4 m0 = texture(tex, vec3(uv * repeatScale, vMaterialIds.x));
    vec4 m1 = texture(tex, vec3(uv * repeatScale, vMaterialIds.y));
    vec4 m2 = texture(tex, vec3(uv * repeatScale, vMaterialIds.z));
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
      roughness: 1.0,  // Let texture maps define roughness fully
      metalness: 1.0,  // Let texture maps define metalness fully
      transparent: isTransparent,
      side: isTransparent ? THREE.DoubleSide : THREE.FrontSide,
      // Enable alpha testing for transparent materials - used for shadow depth culling
      // Fragments with alpha < 0.5 will be discarded from shadows
      alphaTest: isTransparent ? ALPHA_CUTOFF : 0,
      // Enable normal mapping - requires a dummy texture to activate USE_NORMALMAP
      normalMap: new THREE.Texture(),
      normalScale: new THREE.Vector2(-1, -1),
    });
    
    // Set up dummy textures initially
    this.setTextures({
      albedo: createDummyTexture({ r: 128, g: 128, b: 128, a: 255 }),
      normal: createDummyTexture({ r: 128, g: 128, b: 255, a: 255 }),
      ao: createDummyTexture({ r: 255, g: 255, b: 255, a: 255 }),
      roughness: createDummyTexture({ r: 200, g: 200, b: 200, a: 255 }),
      metalness: createDummyTexture({ r: 0, g: 0, b: 0, a: 255 }),
    });
    
    this.onBeforeCompile = (shader) => {
      this._shader = shader;
      
      // Add uniforms
      shader.uniforms.mapArray = { value: this.textures?.albedo };
      shader.uniforms.normalArray = { value: this.textures?.normal };
      shader.uniforms.aoArray = { value: this.textures?.ao };
      shader.uniforms.roughnessArray = { value: this.textures?.roughness };
      shader.uniforms.metalnessArray = { value: this.textures?.metalness };
      shader.uniforms.repeatScale = { value: TERRAIN_MATERIAL_REPEAT_SCALE };
      shader.uniforms.blendOffset = { value: this.createBlendOffsetMatrix() };
      shader.uniforms.debugMode = { value: 0 };
      
      // Add compile-time define for transparent materials
      if (isTransparent) {
        shader.defines = shader.defines || {};
        shader.defines.USE_TEXTURE_ALPHA = '';
        shader.defines.USE_WIND = '';
        
        // Wind uniforms
        shader.uniforms.uTime = { value: 0.0 };
        shader.uniforms.uWindStrength = { value: WIND_STRENGTH };
        shader.uniforms.uWindFrequency = { value: WIND_FREQUENCY };
      }
      
      // Modify vertex shader
      shader.vertexShader = vertexShaderPrefix + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>\n${vertexShaderSuffix}`
      );
      
      // Modify fragment shader
      shader.fragmentShader = fragmentShaderPrefix + shader.fragmentShader;
      
      // Replace diffuse color calculation
      // Compute triPos and triBlend ONCE here - reused by roughness, metalness, AO, normal, and debug
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        /* glsl */ `
          vec3 triPos = vWorldPosition / 8.0;
          vec3 triBlend = getTriPlanarBlend(vWorldNormal);
          vec4 sampledAlbedo = sampleMaterialBlend(mapArray, triPos, triBlend);
          #ifdef USE_TEXTURE_ALPHA
            vec4 diffuseColor = vec4(sampledAlbedo.rgb, sampledAlbedo.a);
          #else
            vec4 diffuseColor = vec4(sampledAlbedo.rgb, 1.0);
          #endif
        `
      );
      
      // Replace roughness calculation (reuses triPos/triBlend from diffuseColor)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
          float roughnessFactor = sampleMaterialBlend(roughnessArray, triPos, triBlend).r;
        `
      );
      
      // Replace metalness calculation (reuses triPos/triBlend from diffuseColor)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `
          float metalnessFactor = sampleMaterialBlend(metalnessArray, triPos, triBlend).r;
        `
      );
      
      // Replace AO calculation (reuses triPos/triBlend from diffuseColor)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <aomap_fragment>',
        /* glsl */ `
          float ambientOcclusion = sampleMaterialBlend(aoArray, triPos, triBlend).r;
          reflectedLight.indirectDiffuse *= ambientOcclusion;
        `
      );
      
      // Replace normal map calculation with tri-planar tangent frame (reuses triPos/triBlend from diffuseColor)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
          #ifdef USE_NORMALMAP
            // Sample normal maps for each axis with material blending
            vec3 normalSampleX = sampleAxisMaterialBlend(normalArray, triPos.zy).xyz * 2.0 - 1.0;
            normalSampleX.xy *= normalScale;
            vec3 normalSampleY = sampleAxisMaterialBlend(normalArray, triPos.xz).xyz * 2.0 - 1.0;
            normalSampleY.xy *= normalScale;
            vec3 normalSampleZ = sampleAxisMaterialBlend(normalArray, triPos.xy).xyz * 2.0 - 1.0;
            normalSampleZ.xy *= normalScale;
            
            // Compute tangent frames for each projection axis
            mat3 tbnX = getTangentFrame(-vViewPosition, normalize(vNormal), triPos.zy);
            mat3 tbnY = getTangentFrame(-vViewPosition, normalize(vNormal), triPos.xz);
            mat3 tbnZ = getTangentFrame(-vViewPosition, normalize(vNormal), triPos.xy);
            
            // Transform normals to world space and blend
            vec3 normalX = normalize(tbnX * normalSampleX);
            vec3 normalY = normalize(tbnY * normalSampleY);
            vec3 normalZ = normalize(tbnZ * normalSampleZ);
            
            normal = normalize(normalX * triBlend.x + normalY * triBlend.y + normalZ * triBlend.z);
          #endif
        `
      );
      
      // Add debug output before final color output (reuses triPos/triBlend from diffuseColor)
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <dithering_fragment>',
        /* glsl */ `
          #include <dithering_fragment>
          
          // Debug mode visualization
          if (debugMode > 0) {
            if (debugMode == 1) {
              // Albedo only
              gl_FragColor = vec4(sampleMaterialBlend(mapArray, triPos, triBlend).rgb, 1.0);
            } else if (debugMode == 2) {
              // Normal map (remap from -1,1 to 0,1 for visualization)
              vec3 nSample = sampleMaterialBlend(normalArray, triPos, triBlend).xyz;
              gl_FragColor = vec4(nSample, 1.0);
            } else if (debugMode == 3) {
              // AO
              float ao = sampleMaterialBlend(aoArray, triPos, triBlend).r;
              gl_FragColor = vec4(ao, ao, ao, 1.0);
            } else if (debugMode == 4) {
              // Roughness
              float r = sampleMaterialBlend(roughnessArray, triPos, triBlend).r;
              gl_FragColor = vec4(r, r, r, 1.0);
            } else if (debugMode == 5) {
              // Tri-planar blend weights
              gl_FragColor = vec4(triBlend, 1.0);
            } else if (debugMode == 6) {
              // Material IDs - use modulo and color mapping for visibility
              // Each channel shows different material, with distinct colors
              vec3 ids = vMaterialIds;
              // Create distinct colors by using sine waves at different phases
              vec3 idColor = vec3(
                sin(ids.x * 0.5) * 0.5 + 0.5,
                sin(ids.y * 0.7 + 2.0) * 0.5 + 0.5,
                sin(ids.z * 0.9 + 4.0) * 0.5 + 0.5
              );
              // Also show primary material ID as brightness
              float primaryId = ids.x;
              vec3 hue = vec3(
                sin(primaryId * 0.4) * 0.5 + 0.5,
                sin(primaryId * 0.4 + 2.094) * 0.5 + 0.5,
                sin(primaryId * 0.4 + 4.188) * 0.5 + 0.5
              );
              gl_FragColor = vec4(hue, 1.0);
            } else if (debugMode == 7) {
              // Material weights
              gl_FragColor = vec4(getWeightedBlend(), 1.0);
            } else if (debugMode == 8) {
              // World normal
              gl_FragColor = vec4(vWorldNormal * 0.5 + 0.5, 1.0);
            }
          }
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
  
  /**
   * Set debug visualization mode.
   * 0=off, 1=albedo, 2=normal, 3=ao, 4=roughness, 5=triBlend, 6=materialIds, 7=materialWeights, 8=worldNormal
   */
  setDebugMode(mode: number): void {
    if (this._shader) {
      this._shader.uniforms.debugMode.value = mode;
    }
  }
  
  /**
   * Update wind animation time. Call each frame for transparent materials.
   */
  setWindTime(time: number): void {
    if (this._shader?.uniforms.uTime) {
      this._shader.uniforms.uTime.value = time * WIND_SPEED;
    }
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

// ============== Custom Depth Material for Transparent Shadows ==============

/**
 * Custom depth material for transparent terrain.
 * Samples the albedo texture alpha and discards fragments below the threshold.
 * This allows transparent materials (like leaves) to cast correct shadows.
 */
class TransparentDepthMaterial extends THREE.MeshDepthMaterial {
  private _shader: ShaderWithUniforms | null = null;
  private textures: LoadedTextures | null = null;

  constructor() {
    super({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.DoubleSide,
    });

    // Set up dummy texture initially
    this.setTextures({
      albedo: createDummyTexture({ r: 128, g: 128, b: 128, a: 255 }),
      normal: createDummyTexture({ r: 128, g: 128, b: 255, a: 255 }),
      ao: createDummyTexture({ r: 255, g: 255, b: 255, a: 255 }),
      roughness: createDummyTexture({ r: 200, g: 200, b: 200, a: 255 }),
      metalness: createDummyTexture({ r: 0, g: 0, b: 0, a: 255 }),
    });

    this.onBeforeCompile = (shader) => {
      this._shader = shader;

      // Add uniforms for texture sampling
      shader.uniforms.mapArray = { value: this.textures?.albedo };
      shader.uniforms.repeatScale = { value: TERRAIN_MATERIAL_REPEAT_SCALE };
      shader.uniforms.blendOffset = { value: this.createBlendOffsetMatrix() };
      shader.uniforms.alphaCutoff = { value: ALPHA_CUTOFF };
      
      // Wind uniforms for matching vertex displacement
      shader.uniforms.uTime = { value: 0.0 };
      shader.uniforms.uWindStrength = { value: WIND_STRENGTH };
      shader.uniforms.uWindFrequency = { value: WIND_FREQUENCY };

      // Add vertex shader prefix for attributes and varyings
      const depthVertexPrefix = /* glsl */ `
        attribute vec3 materialIds;
        attribute vec3 materialWeights;
        
        flat varying vec3 vMaterialIds;
        varying vec3 vMaterialWeights;
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        
        uniform float repeatScale;
        uniform float uTime;
        uniform float uWindStrength;
        uniform float uWindFrequency;
      `;

      const depthVertexSuffix = /* glsl */ `
        vMaterialIds = materialIds;
        vMaterialWeights = materialWeights;
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
        
        // Wind animation - must match TerrainMaterial displacement
        // vWorldPosition stays at original for texture sampling
        float windPhase = uTime + vWorldPosition.x * uWindFrequency + vWorldPosition.z * uWindFrequency * 0.7;
        float windX = sin(windPhase) * sin(windPhase * 0.4 + 1.3);
        float windY = sin(windPhase * 0.6 + 0.8) * sin(windPhase * 0.25) * 0.5;
        float windZ = sin(windPhase * 0.8 + 2.1) * sin(windPhase * 0.3);
        vec3 windOffset = vec3(windX, windY, windZ) * uWindStrength;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position + windOffset, 1.0);
      `;

      // Add fragment shader prefix for texture sampling
      const depthFragmentPrefix = /* glsl */ `
        uniform sampler2DArray mapArray;
        uniform float repeatScale;
        uniform mat3 blendOffset;
        uniform float alphaCutoff;
        
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

      // Alpha discard code to insert before depth packing
      const alphaDiscardCode = /* glsl */ `
        // Sample alpha from albedo texture and discard if below threshold
        vec3 pos = vWorldPosition / 8.0;
        vec3 triBlend = getTriPlanarBlend(vWorldNormal);
        float alpha = sampleMaterialBlend(mapArray, pos, triBlend).a;
        if (alpha < alphaCutoff) {
          discard;
        }
      `;

      // Modify vertex shader
      shader.vertexShader = depthVertexPrefix + shader.vertexShader;
      // MeshDepthMaterial uses #include <beginnormal_vertex> or #include <begin_vertex>
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

      // Modify fragment shader
      shader.fragmentShader = depthFragmentPrefix + shader.fragmentShader;
      
      // MeshDepthMaterial fragment shader structure:
      // - starts with void main() { 
      // - has vec4 diffuseColor = vec4( 1.0 );
      // - then #include <map_fragment> (optional)
      // - then #include <alphamap_fragment> (optional)
      // - then #include <alphatest_fragment>
      // - then depth packing with packDepthToRGBA or gl_FragColor
      
      // Insert our alpha test after diffuseColor declaration
      if (shader.fragmentShader.includes('vec4 diffuseColor = vec4( 1.0 );')) {
        shader.fragmentShader = shader.fragmentShader.replace(
          'vec4 diffuseColor = vec4( 1.0 );',
          `vec4 diffuseColor = vec4( 1.0 );\n${alphaDiscardCode}`
        );
      } else {
        // Fallback: insert after clipping_planes_fragment
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <clipping_planes_fragment>',
          `#include <clipping_planes_fragment>\n${alphaDiscardCode}`
        );
      }
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
      this.needsUpdate = true;
    }
  }
  
  setWindTime(time: number): void {
    if (this._shader?.uniforms.uTime) {
      this._shader.uniforms.uTime.value = time * WIND_SPEED;
    }
  }
}

// ============== Wind Normal Material for SSAO ==============

/**
 * Custom MeshNormalMaterial with wind animation for SSAO pass.
 * This ensures the depth/normal buffers used by SSAO match the displaced vertices.
 */
class WindNormalMaterial extends THREE.MeshNormalMaterial {
  private _shader: ShaderWithUniforms | null = null;

  constructor() {
    super({
      blending: THREE.NoBlending,
    });

    this.onBeforeCompile = (shader) => {
      this._shader = shader;

      // Add wind uniforms
      shader.uniforms.uTime = { value: 0.0 };
      shader.uniforms.uWindStrength = { value: WIND_STRENGTH };
      shader.uniforms.uWindFrequency = { value: WIND_FREQUENCY };

      // Inject wind uniforms into vertex shader
      const windUniforms = /* glsl */ `
        uniform float uTime;
        uniform float uWindStrength;
        uniform float uWindFrequency;
      `;

      shader.vertexShader = windUniforms + shader.vertexShader;

      // Add wind displacement before project_vertex
      const windDisplacement = /* glsl */ `
        // Wind animation for SSAO normal/depth - matches TerrainMaterial
        vec3 worldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        float windPhase = uTime + worldPos.x * uWindFrequency + worldPos.z * uWindFrequency * 0.7;
        float windX = sin(windPhase) * sin(windPhase * 0.4 + 1.3);
        float windY = sin(windPhase * 0.6 + 0.8) * sin(windPhase * 0.25) * 0.5;
        float windZ = sin(windPhase * 0.8 + 2.1) * sin(windPhase * 0.3);
        transformed += vec3(windX, windY, windZ) * uWindStrength;
      `;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `${windDisplacement}\n#include <project_vertex>`
      );
    };
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
let windNormalMaterial: WindNormalMaterial | null = null;

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
 * Get the shared liquid terrain material instance.
 * Currently uses the same shader as transparent materials.
 * TODO: Add specialized water shader with refraction/caustics.
 */
export function getLiquidTerrainMaterial(): TerrainMaterial {
  if (!liquidMaterial) {
    liquidMaterial = new TerrainMaterial(true);
  }
  return liquidMaterial;
}

/**
 * Get the shared wind normal material for SSAO.
 * This material includes wind animation to match displaced vertices.
 */
export function getWindNormalMaterial(): WindNormalMaterial {
  if (!windNormalMaterial) {
    windNormalMaterial = new WindNormalMaterial();
  }
  return windNormalMaterial;
}

/**
 * Get the shared transparent depth material instance.
 * Used as customDepthMaterial for transparent meshes to enable
 * alpha-tested shadow casting.
 */
export function getTransparentDepthMaterial(): TransparentDepthMaterial {
  if (!transparentDepthMaterial) {
    transparentDepthMaterial = new TransparentDepthMaterial();
  }
  return transparentDepthMaterial;
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
  getLiquidTerrainMaterial().setTextures(textures);
  getTransparentDepthMaterial().setTextures(textures);
  
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
  getLiquidTerrainMaterial().setTextures(textures);
  getTransparentDepthMaterial().setTextures(textures);
  
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
 * Use TERRAIN_DEBUG_MODES constants or numbers 0-8.
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
 * Call this each frame with elapsedTime from the game loop.
 */
export function updateWindTime(elapsedTime: number): void {
  // Only transparent materials have wind animation
  if (transparentMaterial) {
    transparentMaterial.setWindTime(elapsedTime);
  }
  if (liquidMaterial) {
    liquidMaterial.setWindTime(elapsedTime);
  }
  // Keep depth material in sync for matching shadow positions
  if (transparentDepthMaterial) {
    transparentDepthMaterial.setWindTime(elapsedTime);
  }
  // Keep SSAO normal material in sync
  if (windNormalMaterial) {
    windNormalMaterial.setWindTime(elapsedTime);
  }
}

// Expose debug controls to window for console access
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
