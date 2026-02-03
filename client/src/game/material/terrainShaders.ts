/**
 * Terrain Shader Code
 * 
 * GLSL shader snippets for terrain materials with tri-planar mapping.
 * Separated from TerrainMaterial.ts for better organization.
 */

// ============== Shared Shader Components ==============

/** Material attribute declarations (vertex) */
export const materialAttributesVertex = /* glsl */ `
  attribute vec3 materialIds;
  attribute vec3 materialWeights;
  
  flat varying vec3 vMaterialIds;
  varying vec3 vMaterialWeights;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
`;

/** Material varying assignments (vertex suffix) */
export const materialVaryingsSuffix = /* glsl */ `
  vMaterialIds = materialIds;
  vMaterialWeights = materialWeights;
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
`;

/** Wind animation code (vertex) - requires uniforms uTime, uWindStrength, uWindFrequency */
export const windAnimationVertex = /* glsl */ `
  // Wind animation - layered sine waves based on world position
  float windPhase = uTime + vWorldPosition.x * uWindFrequency + vWorldPosition.z * uWindFrequency * 0.7;
  float windX = sin(windPhase) * sin(windPhase * 0.4 + 1.3);
  float windY = sin(windPhase * 0.6 + 0.8) * sin(windPhase * 0.25) * 0.5;
  float windZ = sin(windPhase * 0.8 + 2.1) * sin(windPhase * 0.3);
  vec3 windOffset = vec3(windX, windY, windZ) * uWindStrength;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + windOffset, 1.0);
`;

/** Wind uniform declarations */
export const windUniformsVertex = /* glsl */ `
  uniform float uTime;
  uniform float uWindStrength;
  uniform float uWindFrequency;
`;

// ============== Shared Fragment Utilities ==============

/** Common fragment varyings (must match vertex outputs) */
const fragmentVaryings = /* glsl */ `
  flat varying vec3 vMaterialIds;
  varying vec3 vMaterialWeights;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
`;

/** Tri-planar and material blending core functions */
const blendingFunctions = /* glsl */ `
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
  
  vec4 sampleTriPlanarAt(sampler2DArray tex, vec3 pos, vec3 blend, float scale, float layer) {
    vec4 xaxis = texture(tex, vec3(pos.zy * scale, layer));
    vec4 yaxis = texture(tex, vec3(pos.xz * scale, layer));
    vec4 zaxis = texture(tex, vec3(pos.xy * scale, layer));
    return xaxis * blend.x + yaxis * blend.y + zaxis * blend.z;
  }
  
  vec4 sampleMaterialBlendAt(sampler2DArray tex, vec3 pos, vec3 triBlend, vec3 matBlend, vec3 matIds, float scale) {
    vec4 m0 = sampleTriPlanarAt(tex, pos, triBlend, scale, matIds.x);
    vec4 m1 = sampleTriPlanarAt(tex, pos, triBlend, scale, matIds.y);
    vec4 m2 = sampleTriPlanarAt(tex, pos, triBlend, scale, matIds.z);
    return m0 * matBlend.x + m1 * matBlend.y + m2 * matBlend.z;
  }
`;

// ============== TerrainMaterial Shaders ==============

export const terrainVertexPrefix = /* glsl */ `
  ${materialAttributesVertex}
  uniform float repeatScale;
  
  #ifdef USE_WIND
  ${windUniformsVertex}
  #endif
`;

export const terrainVertexSuffix = /* glsl */ `
  ${materialVaryingsSuffix}
  
  #ifdef USE_WIND
  ${windAnimationVertex}
  #endif
`;

export const terrainFragmentPrefix = /* glsl */ `
  uniform sampler2DArray mapArray;
  uniform sampler2DArray normalArray;
  uniform sampler2DArray aoArray;
  uniform sampler2DArray roughnessArray;
  uniform sampler2DArray metalnessArray;
  uniform float repeatScale;
  uniform mat3 blendOffset;
  uniform int debugMode;
  
  // Material adjustment uniforms
  uniform float roughnessMultiplier;
  uniform float metalnessMultiplier;
  uniform float aoIntensity;
  uniform float normalStrength;
  uniform float blendSharpness;
  
  ${fragmentVaryings}
  
  // Precomputed blend weights - set once in main(), reused everywhere
  vec3 gTriBlend;
  vec3 gMatBlend;
  vec2 gTriUV_zy;
  vec2 gTriUV_xz;
  vec2 gTriUV_xy;
  
  ${blendingFunctions}
  
  // Convenience wrappers using precomputed globals
  vec4 sampleTriPlanar(sampler2DArray tex, float layer) {
    vec4 xaxis = texture(tex, vec3(gTriUV_zy, layer));
    vec4 yaxis = texture(tex, vec3(gTriUV_xz, layer));
    vec4 zaxis = texture(tex, vec3(gTriUV_xy, layer));
    return xaxis * gTriBlend.x + yaxis * gTriBlend.y + zaxis * gTriBlend.z;
  }
  
  vec4 sampleMaterialBlend(sampler2DArray tex) {
    vec4 m0 = sampleTriPlanar(tex, vMaterialIds.x);
    vec4 m1 = sampleTriPlanar(tex, vMaterialIds.y);
    vec4 m2 = sampleTriPlanar(tex, vMaterialIds.z);
    return m0 * gMatBlend.x + m1 * gMatBlend.y + m2 * gMatBlend.z;
  }
  
  vec4 sampleAxisMaterialBlend(sampler2DArray tex, vec2 uv) {
    vec4 m0 = texture(tex, vec3(uv, vMaterialIds.x));
    vec4 m1 = texture(tex, vec3(uv, vMaterialIds.y));
    vec4 m2 = texture(tex, vec3(uv, vMaterialIds.z));
    return m0 * gMatBlend.x + m1 * gMatBlend.y + m2 * gMatBlend.z;
  }
`;

export const terrainDiffuseFragment = /* glsl */ `
  // Precompute all blend weights and scaled UVs once
  vec3 triPos = vWorldPosition / 8.0;
  gTriBlend = calcTriPlanarBlend(vWorldNormal, blendOffset);
  gMatBlend = calcMaterialBlend(vMaterialWeights);
  gTriUV_zy = triPos.zy * repeatScale;
  gTriUV_xz = triPos.xz * repeatScale;
  gTriUV_xy = triPos.xy * repeatScale;
  
  vec4 sampledAlbedo = sampleMaterialBlend(mapArray);
  #ifdef USE_TEXTURE_ALPHA
    vec4 diffuseColor = vec4(sampledAlbedo.rgb, sampledAlbedo.a);
  #else
    vec4 diffuseColor = vec4(sampledAlbedo.rgb, 1.0);
  #endif
`;

export const terrainRoughnessFragment = /* glsl */ `
  float roughnessFactor = sampleMaterialBlend(roughnessArray).r * roughnessMultiplier;
`;

export const terrainMetalnessFragment = /* glsl */ `
  float metalnessFactor = sampleMaterialBlend(metalnessArray).r * metalnessMultiplier;
`;

export const terrainAoFragment = /* glsl */ `
  float aoSample = sampleMaterialBlend(aoArray).r;
  float ambientOcclusion = mix(1.0, aoSample, aoIntensity);
  reflectedLight.indirectDiffuse *= ambientOcclusion;
`;

export const terrainNormalFragment = /* glsl */ `
  #ifdef USE_NORMALMAP
    vec3 normalSampleX = sampleAxisMaterialBlend(normalArray, gTriUV_zy).xyz * 2.0 - 1.0;
    normalSampleX.xy *= normalScale * normalStrength;
    vec3 normalSampleY = sampleAxisMaterialBlend(normalArray, gTriUV_xz).xyz * 2.0 - 1.0;
    normalSampleY.xy *= normalScale * normalStrength;
    vec3 normalSampleZ = sampleAxisMaterialBlend(normalArray, gTriUV_xy).xyz * 2.0 - 1.0;
    normalSampleZ.xy *= normalScale * normalStrength;
    
    vec3 geomNormal = normalize(vNormal);
    mat3 tbnX = getTangentFrame(-vViewPosition, geomNormal, gTriUV_zy);
    mat3 tbnY = getTangentFrame(-vViewPosition, geomNormal, gTriUV_xz);
    mat3 tbnZ = getTangentFrame(-vViewPosition, geomNormal, gTriUV_xy);
    
    vec3 normalX = normalize(tbnX * normalSampleX);
    vec3 normalY = normalize(tbnY * normalSampleY);
    vec3 normalZ = normalize(tbnZ * normalSampleZ);
    
    normal = normalize(normalX * gTriBlend.x + normalY * gTriBlend.y + normalZ * gTriBlend.z);
  #endif
`;

export const terrainDebugFragment = /* glsl */ `
  #include <dithering_fragment>
  
  if (debugMode > 0) {
    if (debugMode == 1) {
      gl_FragColor = vec4(sampleMaterialBlend(mapArray).rgb, 1.0);
    } else if (debugMode == 2) {
      vec3 nSample = sampleMaterialBlend(normalArray).xyz;
      gl_FragColor = vec4(nSample, 1.0);
    } else if (debugMode == 3) {
      float ao = sampleMaterialBlend(aoArray).r;
      gl_FragColor = vec4(ao, ao, ao, 1.0);
    } else if (debugMode == 4) {
      float r = sampleMaterialBlend(roughnessArray).r;
      gl_FragColor = vec4(r, r, r, 1.0);
    } else if (debugMode == 5) {
      gl_FragColor = vec4(gTriBlend, 1.0);
    } else if (debugMode == 6) {
      float primaryId = vMaterialIds.x;
      vec3 hue = vec3(
        sin(primaryId * 0.4) * 0.5 + 0.5,
        sin(primaryId * 0.4 + 2.094) * 0.5 + 0.5,
        sin(primaryId * 0.4 + 4.188) * 0.5 + 0.5
      );
      gl_FragColor = vec4(hue, 1.0);
    } else if (debugMode == 7) {
      gl_FragColor = vec4(gMatBlend, 1.0);
    } else if (debugMode == 8) {
      gl_FragColor = vec4(vWorldNormal * 0.5 + 0.5, 1.0);
    } else if (debugMode == 9) {
      // Metalness debug - shows raw metalness texture value
      float m = sampleMaterialBlend(metalnessArray).r;
      gl_FragColor = vec4(m, m, m, 1.0);
    } else if (debugMode == 10) {
      // Metalness with multiplier applied (what's actually used)
      float mFinal = sampleMaterialBlend(metalnessArray).r * metalnessMultiplier;
      gl_FragColor = vec4(mFinal, mFinal, mFinal, 1.0);
    }
  }
`;

// ============== Depth Material Shaders ==============

export const depthVertexPrefix = /* glsl */ `
  ${materialAttributesVertex}
  uniform float repeatScale;
  ${windUniformsVertex}
`;

export const depthVertexSuffix = /* glsl */ `
  ${materialVaryingsSuffix}
  
  // Wind animation - must match TerrainMaterial displacement
  float windPhase = uTime + vWorldPosition.x * uWindFrequency + vWorldPosition.z * uWindFrequency * 0.7;
  float windX = sin(windPhase) * sin(windPhase * 0.4 + 1.3);
  float windY = sin(windPhase * 0.6 + 0.8) * sin(windPhase * 0.25) * 0.5;
  float windZ = sin(windPhase * 0.8 + 2.1) * sin(windPhase * 0.3);
  vec3 windOffset = vec3(windX, windY, windZ) * uWindStrength;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + windOffset, 1.0);
`;

export const depthFragmentPrefix = /* glsl */ `
  uniform sampler2DArray mapArray;
  uniform float repeatScale;
  uniform mat3 blendOffset;
  uniform float alphaCutoff;
  uniform float blendSharpness;
  
  ${fragmentVaryings}
  
  ${blendingFunctions}
`;

export const depthAlphaDiscard = /* glsl */ `
  vec3 pos = vWorldPosition / 8.0;
  vec3 triBlend = calcTriPlanarBlend(vWorldNormal, blendOffset);
  vec3 matBlend = calcMaterialBlend(vMaterialWeights);
  float alpha = sampleMaterialBlendAt(mapArray, pos, triBlend, matBlend, vMaterialIds, repeatScale).a;
  if (alpha < alphaCutoff) {
    discard;
  }
`;

