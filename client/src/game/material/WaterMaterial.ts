/**
 * WaterMaterial - Animated water/liquid material with choppy waves
 * 
 * Extends the terrain material system to provide realistic water rendering
 * with vertex-based wave displacement and animated normal perturbation.
 */

import * as THREE from 'three';
import {
  MATERIAL_METALNESS_OFFSET,
  MATERIAL_AO_INTENSITY,
  MATERIAL_NORMAL_STRENGTH,
  MATERIAL_REPEAT_SCALES,
} from '@worldify/shared';
import { useGameStore } from '../../state/store';
import type { LoadedTextures } from './TerrainMaterial';
import { createDefaultPlaceholders } from './PlaceholderTextures.js';
import { TERRAIN_MATERIAL_REPEAT_SCALE, TERRAIN_MATERIAL_BLEND_OFFSET_RAD } from './constants.js';
import {
  materialAttributesVertex,
  materialVaryingsSuffix,
} from './terrainShaders.js';
import {
  waterUniformsVertex,
  waterUniformsFragment,
  waterWaveVertex,
  waterVertexDisplacement,
  waterNormalPerturbation,
  waterFresnelEffect,
  DEFAULT_WATER_SETTINGS,
} from './waterShaders.js';

// ============== Helper Functions ==============

function createBlendOffsetMatrix(): THREE.Matrix3 {
  const angle = TERRAIN_MATERIAL_BLEND_OFFSET_RAD;
  const cos1 = Math.cos(angle);
  const sin1 = Math.sin(angle);
  const cos2 = Math.cos(angle * 0.7);
  const sin2 = Math.sin(angle * 0.7);
  
  return new THREE.Matrix3().set(
    cos1, sin1 * 0.5, -sin2 * 0.3,
    -sin1 * 0.3, cos2, sin1 * 0.5,
    sin2 * 0.2, -sin1 * 0.4, cos1
  );
}

// ============== Water Material ==============

/**
 * Animated water material with choppy waves and shimmering reflections.
 * Uses vertex displacement for wave geometry and animated normals for surface detail.
 */
export class WaterMaterial extends THREE.MeshStandardMaterial {
  private _shader: THREE.WebGLProgramParametersWithUniforms | null = null;
  private textures: LoadedTextures | null = null;
  private _waveSpeed: number = DEFAULT_WATER_SETTINGS.waveSpeed;

  constructor() {
    super({
      roughness: 0.0,           // Fully reflective
      metalness: 0.0,           // Non-metallic (dielectric)
      transparent: true,
      side: THREE.DoubleSide,
      opacity: DEFAULT_WATER_SETTINGS.waterOpacity,
      normalMap: new THREE.Texture(),
      normalScale: new THREE.Vector2(-1, -1),
    });
    
    this.setTextures(createDefaultPlaceholders());
    
    this.onBeforeCompile = (shader) => {
      this._shader = shader;
      
      // Standard terrain texture uniforms
      shader.uniforms.mapArray = { value: this.textures?.albedo };
      shader.uniforms.normalArray = { value: this.textures?.normal };
      shader.uniforms.aoArray = { value: this.textures?.ao };
      shader.uniforms.roughnessArray = { value: this.textures?.roughness };
      shader.uniforms.metalnessArray = { value: this.textures?.metalness };
      shader.uniforms.repeatScale = { value: TERRAIN_MATERIAL_REPEAT_SCALE };
      shader.uniforms.repeatScales = { value: MATERIAL_REPEAT_SCALES };
      shader.uniforms.blendOffset = { value: createBlendOffsetMatrix() };
      shader.uniforms.debugMode = { value: 0 };
      
      // Material adjustment uniforms
      shader.uniforms.roughnessMultiplier = { value: 0.0 }; // Water is smooth
      shader.uniforms.metalnessOffset = { value: MATERIAL_METALNESS_OFFSET };
      shader.uniforms.aoIntensity = { value: MATERIAL_AO_INTENSITY };
      shader.uniforms.normalStrength = { value: MATERIAL_NORMAL_STRENGTH };
      shader.uniforms.blendSharpness = { value: 8.0 };
      
      // Water-specific uniforms
      shader.uniforms.uWaveTime = { value: 0.0 };
      shader.uniforms.uWaveAmplitude = { value: DEFAULT_WATER_SETTINGS.waveAmplitude };
      shader.uniforms.uWaveFrequency = { value: DEFAULT_WATER_SETTINGS.waveFrequency };
      shader.uniforms.uNormalStrength = { value: DEFAULT_WATER_SETTINGS.normalStrength };
      shader.uniforms.uNormalScale = { value: DEFAULT_WATER_SETTINGS.normalScale };
      shader.uniforms.uScatterStrength = { value: DEFAULT_WATER_SETTINGS.scatterStrength };
      shader.uniforms.uScatterScale = { value: DEFAULT_WATER_SETTINGS.scatterScale };
      shader.uniforms.uWaterRoughness = { value: DEFAULT_WATER_SETTINGS.roughness };
      shader.uniforms.uFresnelPower = { value: DEFAULT_WATER_SETTINGS.fresnelPower };
      shader.uniforms.uWaterTint = { value: new THREE.Vector3(...DEFAULT_WATER_SETTINGS.waterTint) };
      shader.uniforms.uWaterOpacity = { value: DEFAULT_WATER_SETTINGS.waterOpacity };
      
      // ============== Vertex Shader Modifications ==============
      
      // Add attribute declarations and uniforms
      shader.vertexShader = /* glsl */ `
        ${materialAttributesVertex}
        uniform float repeatScale;
        ${waterUniformsVertex}
        varying vec3 vWaterViewDir;
        
        ${waterWaveVertex}
      ` + shader.vertexShader;
      
      // Add varying assignments and wave displacement after worldpos
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        /* glsl */ `
          #include <worldpos_vertex>
          ${materialVaryingsSuffix}
          vWaterViewDir = cameraPosition - vWorldPosition;
          
          ${waterVertexDisplacement}
        `
      );
      
      // ============== Fragment Shader Modifications ==============
      
      // Add uniforms and functions
      shader.fragmentShader = /* glsl */ `
        uniform sampler2DArray mapArray;
        uniform sampler2DArray normalArray;
        uniform sampler2DArray aoArray;
        uniform sampler2DArray roughnessArray;
        uniform sampler2DArray metalnessArray;
        uniform float repeatScale;
        uniform float repeatScales[64];
        uniform mat3 blendOffset;
        uniform int debugMode;
        
        uniform float roughnessMultiplier;
        uniform float metalnessOffset;
        uniform float aoIntensity;
        uniform float normalStrength;
        uniform float blendSharpness;
        
        flat varying vec3 vMaterialIds;
        varying vec3 vMaterialWeights;
        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;
        varying vec3 vWaterViewDir;
        
        ${waterUniformsFragment}
        ${waterNormalPerturbation}
        ${waterFresnelEffect}
        
        // Tri-planar blending functions
        vec3 calcTriPlanarBlend(vec3 normal, mat3 offset) {
          vec3 blending = offset * normal;
          blending = pow(abs(blending), vec3(blendSharpness));
          blending = max(blending, 0.00001);
          return blending / (blending.x + blending.y + blending.z);
        }
        
        vec3 calcMaterialBlend(vec3 weights) {
          vec3 w = weights * weights;
          w = max(w, 0.00001);
          return w / (w.x + w.y + w.z);
        }
        
        // Precomputed blend weights
        vec3 gTriBlend;
        vec3 gMatBlend;
        
        vec4 sampleTriPlanar(sampler2DArray tex, float layer) {
          vec3 pos = vWorldPosition / 8.0;
          float scale = repeatScale * repeatScales[int(layer)];
          vec4 xaxis = texture(tex, vec3(pos.zy * scale, layer));
          vec4 yaxis = texture(tex, vec3(pos.xz * scale, layer));
          vec4 zaxis = texture(tex, vec3(pos.xy * scale, layer));
          return xaxis * gTriBlend.x + yaxis * gTriBlend.y + zaxis * gTriBlend.z;
        }
        
        vec4 sampleMaterialBlend(sampler2DArray tex) {
          vec4 m0 = sampleTriPlanar(tex, vMaterialIds.x);
          vec4 m1 = sampleTriPlanar(tex, vMaterialIds.y);
          vec4 m2 = sampleTriPlanar(tex, vMaterialIds.z);
          return m0 * gMatBlend.x + m1 * gMatBlend.y + m2 * gMatBlend.z;
        }
      ` + shader.fragmentShader;
      
      // Replace diffuse color calculation with water version
      shader.fragmentShader = shader.fragmentShader.replace(
        'vec4 diffuseColor = vec4( diffuse, opacity );',
        /* glsl */ `
          // Initialize blend weights
          gTriBlend = calcTriPlanarBlend(vWorldNormal, blendOffset);
          gMatBlend = calcMaterialBlend(vMaterialWeights);
          
          // Sample albedo from texture array
          vec4 texColor = sampleMaterialBlend(mapArray);
          
          // Apply water tint to texture color
          vec3 baseWaterColor = texColor.rgb * uWaterTint;
          
          // Calculate view direction and animated normal
          // Safety: ensure view direction is valid (avoid NaN if camera is at water surface)
          float viewLen = length(vWaterViewDir);
          vec3 viewDir = viewLen > 0.001 ? vWaterViewDir / viewLen : vec3(0.0, 1.0, 0.0);
          vec3 animatedNormal = getWaterNormal(vWorldPosition, uWaveTime, normalize(vWorldNormal), normalArray, vMaterialIds.x);
          
          // Apply scatter effect - makes normal variations visible in diffuse color
          vec3 waterColor = getScatterColor(viewDir, animatedNormal, baseWaterColor);
          
          // Calculate fresnel for edge opacity
          float fresnel = getFresnelFactor(viewDir, animatedNormal);
          
          // Increase opacity at glancing angles (edges)
          float waterAlpha = mix(uWaterOpacity, 1.0, fresnel * 0.5) * texColor.a;
          
          vec4 diffuseColor = vec4(waterColor, waterAlpha);
        `
      );
      
      // Replace normal map fragment with animated water normals
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `
          // Use animated water normal from texture sampling
          vec3 waterNormal = getWaterNormal(vWorldPosition, uWaveTime, normal, normalArray, vMaterialIds.x);
          normal = waterNormal;
        `
      );
      
      // Override roughness - controlled by uWaterRoughness uniform
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <roughnessmap_fragment>',
        /* glsl */ `
          // Water roughness - controlled via debug panel
          float roughnessFactor = uWaterRoughness;
        `
      );
      
      // Override metalness to 0 - water is a dielectric, not metallic
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <metalnessmap_fragment>',
        /* glsl */ `
          // Water is non-metallic (dielectric)
          float metalnessFactor = 0.0;
        `
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
  
  /** Update wave animation time */
  setWaveTime(time: number): void {
    if (this._shader?.uniforms.uWaveTime) {
      this._shader.uniforms.uWaveTime.value = time * this._waveSpeed;
    }
  }
  
  // ============== Water Parameter Setters ==============
  
  setWaveAmplitude(value: number): void {
    if (this._shader?.uniforms.uWaveAmplitude) {
      this._shader.uniforms.uWaveAmplitude.value = value;
    }
  }
  
  setWaveFrequency(value: number): void {
    if (this._shader?.uniforms.uWaveFrequency) {
      this._shader.uniforms.uWaveFrequency.value = value;
    }
  }
  
  setWaveSpeed(value: number): void {
    this._waveSpeed = value;
  }
  
  setNormalStrength(value: number): void {
    if (this._shader?.uniforms.uNormalStrength) {
      this._shader.uniforms.uNormalStrength.value = value;
    }
  }
  
  setNormalScale(value: number): void {
    if (this._shader?.uniforms.uNormalScale) {
      this._shader.uniforms.uNormalScale.value = value;
    }
  }
  
  setScatterStrength(value: number): void {
    if (this._shader?.uniforms.uScatterStrength) {
      this._shader.uniforms.uScatterStrength.value = value;
    }
  }
  
  setScatterScale(value: number): void {
    if (this._shader?.uniforms.uScatterScale) {
      this._shader.uniforms.uScatterScale.value = value;
    }
  }
  
  setWaterRoughness(value: number): void {
    if (this._shader?.uniforms.uWaterRoughness) {
      this._shader.uniforms.uWaterRoughness.value = value;
    }
  }
  
  setFresnelPower(value: number): void {
    if (this._shader?.uniforms.uFresnelPower) {
      this._shader.uniforms.uFresnelPower.value = value;
    }
  }
  
  setWaterTint(r: number, g: number, b: number): void {
    if (this._shader?.uniforms.uWaterTint) {
      this._shader.uniforms.uWaterTint.value.set(r, g, b);
    }
  }
  
  setWaterOpacity(value: number): void {
    if (this._shader?.uniforms.uWaterOpacity) {
      this._shader.uniforms.uWaterOpacity.value = value;
    }
    this.opacity = value;
  }
  
  setDebugMode(mode: number): void {
    if (this._shader) {
      this._shader.uniforms.debugMode.value = mode;
    }
  }
}

// ============== Singleton Instance ==============

let waterMaterial: WaterMaterial | null = null;

export function getWaterMaterial(): WaterMaterial {
  if (!waterMaterial) {
    waterMaterial = new WaterMaterial();
    waterMaterial.envMapIntensity = useGameStore.getState().environment.environmentIntensity;
  }
  return waterMaterial;
}

/** Update water animation time */
export function updateWaterTime(time: number): void {
  getWaterMaterial().setWaveTime(time);
}

/** Apply water settings from store */
export function applyWaterSettings(settings: {
  waveAmplitude?: number;
  waveFrequency?: number;
  waveSpeed?: number;
  normalStrength?: number;
  normalScale?: number;
  scatterStrength?: number;
  scatterScale?: number;
  roughness?: number;
  fresnelPower?: number;
  waterTint?: [number, number, number];
  waterOpacity?: number;
}): void {
  const mat = getWaterMaterial();
  
  if (settings.waveAmplitude !== undefined) mat.setWaveAmplitude(settings.waveAmplitude);
  if (settings.waveFrequency !== undefined) mat.setWaveFrequency(settings.waveFrequency);
  if (settings.waveSpeed !== undefined) mat.setWaveSpeed(settings.waveSpeed);
  if (settings.normalStrength !== undefined) mat.setNormalStrength(settings.normalStrength);
  if (settings.normalScale !== undefined) mat.setNormalScale(settings.normalScale);
  if (settings.scatterStrength !== undefined) mat.setScatterStrength(settings.scatterStrength);
  if (settings.scatterScale !== undefined) mat.setScatterScale(settings.scatterScale);
  if (settings.roughness !== undefined) mat.setWaterRoughness(settings.roughness);
  if (settings.fresnelPower !== undefined) mat.setFresnelPower(settings.fresnelPower);
  if (settings.waterTint !== undefined) mat.setWaterTint(...settings.waterTint);
  if (settings.waterOpacity !== undefined) mat.setWaterOpacity(settings.waterOpacity);
}
