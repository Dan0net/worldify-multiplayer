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
  
  flat varying vec3 vMaterialIds;
  varying vec3 vMaterialWeights;
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
`;

/** Material varying assignments (vertex suffix) */
export const materialVaryingsSuffix = /* glsl */ `
  vMaterialIds = materialIds;
  // Compute barycentric weights from vertex index instead of storing per-vertex.
  // Vertices are laid out sequentially: 3 per triangle (0,1,2, 3,4,5, ...).
  // gl_VertexID % 3 gives 0->( 1,0,0), 1->(0,1,0), 2->(0,0,1).
  int baryIdx = gl_VertexID - (gl_VertexID / 3) * 3;
  vMaterialWeights = vec3(float(baryIdx == 0), float(baryIdx == 1), float(baryIdx == 2));
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
  // sRGB to linear conversion - required for correct albedo color handling
  // GPU hardware sRGB decode may not work correctly with sampler2DArray
  vec3 sRGBToLinear(vec3 srgb) {
    // Approximation: pow(srgb, 2.2) is close but not exact
    // Exact formula handles the linear segment below 0.04045
    return mix(
      srgb / 12.92,
      pow((srgb + 0.055) / 1.055, vec3(2.4)),
      step(0.04045, srgb)
    );
  }
  
  // HSV to RGB conversion for material ID coloring
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  
  // Get unique hue for material ID (using golden ratio for good distribution)
  float materialIdToHue(float id) {
    return fract(id * 0.618033988749895);
  }
  
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
  uniform float repeatScales[64];
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
  // Per-material UVs for tri-planar sampling
  vec2 gTriUV_zy_m0, gTriUV_zy_m1, gTriUV_zy_m2;
  vec2 gTriUV_xz_m0, gTriUV_xz_m1, gTriUV_xz_m2;
  vec2 gTriUV_xy_m0, gTriUV_xy_m1, gTriUV_xy_m2;
  
  ${blendingFunctions}
  
  // Sample tri-planar with per-material repeat scale
  // With QUALITY_REDUCED_TRIPLANAR: uses only the dominant axis (1 sample instead of 3)
  vec4 sampleTriPlanarMat(sampler2DArray tex, float layer, vec2 uv_zy, vec2 uv_xz, vec2 uv_xy) {
    #ifdef QUALITY_REDUCED_TRIPLANAR
      // Dominant-axis-only sampling: 1 texture fetch instead of 3
      if (gTriBlend.y >= gTriBlend.x && gTriBlend.y >= gTriBlend.z) {
        return texture(tex, vec3(uv_xz, layer));
      } else if (gTriBlend.x >= gTriBlend.z) {
        return texture(tex, vec3(uv_zy, layer));
      } else {
        return texture(tex, vec3(uv_xy, layer));
      }
    #else
      vec4 xaxis = texture(tex, vec3(uv_zy, layer));
      vec4 yaxis = texture(tex, vec3(uv_xz, layer));
      vec4 zaxis = texture(tex, vec3(uv_xy, layer));
      return xaxis * gTriBlend.x + yaxis * gTriBlend.y + zaxis * gTriBlend.z;
    #endif
  }
  
  // Convenience wrappers using precomputed globals (for backward compatibility)
  vec4 sampleTriPlanar(sampler2DArray tex, float layer) {
    #ifdef QUALITY_REDUCED_TRIPLANAR
      if (gTriBlend.y >= gTriBlend.x && gTriBlend.y >= gTriBlend.z) {
        return texture(tex, vec3(gTriUV_xz, layer));
      } else if (gTriBlend.x >= gTriBlend.z) {
        return texture(tex, vec3(gTriUV_zy, layer));
      } else {
        return texture(tex, vec3(gTriUV_xy, layer));
      }
    #else
      vec4 xaxis = texture(tex, vec3(gTriUV_zy, layer));
      vec4 yaxis = texture(tex, vec3(gTriUV_xz, layer));
      vec4 zaxis = texture(tex, vec3(gTriUV_xy, layer));
      return xaxis * gTriBlend.x + yaxis * gTriBlend.y + zaxis * gTriBlend.z;
    #endif
  }
  
  // Material blend with early-out for uniform materials (all 3 IDs equal).
  // Most terrain triangles have the same material on all vertices, so this
  // skips 2/3 of texture samples for the majority of fragments.
  vec4 sampleMaterialBlend(sampler2DArray tex) {
    if (vMaterialIds.x == vMaterialIds.y && vMaterialIds.y == vMaterialIds.z) {
      // Uniform material — sample once with tri-planar only
      return sampleTriPlanarMat(tex, vMaterialIds.x, gTriUV_zy_m0, gTriUV_xz_m0, gTriUV_xy_m0);
    }
    vec4 m0 = sampleTriPlanarMat(tex, vMaterialIds.x, gTriUV_zy_m0, gTriUV_xz_m0, gTriUV_xy_m0);
    vec4 m1 = sampleTriPlanarMat(tex, vMaterialIds.y, gTriUV_zy_m1, gTriUV_xz_m1, gTriUV_xy_m1);
    vec4 m2 = sampleTriPlanarMat(tex, vMaterialIds.z, gTriUV_zy_m2, gTriUV_xz_m2, gTriUV_xy_m2);
    return m0 * gMatBlend.x + m1 * gMatBlend.y + m2 * gMatBlend.z;
  }
  
  vec4 sampleAxisMaterialBlend(sampler2DArray tex, vec2 uv) {
    if (vMaterialIds.x == vMaterialIds.y && vMaterialIds.y == vMaterialIds.z) {
      return texture(tex, vec3(uv, vMaterialIds.x));
    }
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
  
  // Global UVs with default repeat scale (for backward compatibility)
  gTriUV_zy = triPos.zy * repeatScale;
  gTriUV_xz = triPos.xz * repeatScale;
  gTriUV_xy = triPos.xy * repeatScale;
  
  // Per-material UVs with individual repeat scales
  int m0 = int(vMaterialIds.x);
  int m1 = int(vMaterialIds.y);
  int m2 = int(vMaterialIds.z);
  float scale0 = repeatScales[m0];
  float scale1 = repeatScales[m1];
  float scale2 = repeatScales[m2];
  
  gTriUV_zy_m0 = triPos.zy * scale0;
  gTriUV_xz_m0 = triPos.xz * scale0;
  gTriUV_xy_m0 = triPos.xy * scale0;
  gTriUV_zy_m1 = triPos.zy * scale1;
  gTriUV_xz_m1 = triPos.xz * scale1;
  gTriUV_xy_m1 = triPos.xy * scale1;
  gTriUV_zy_m2 = triPos.zy * scale2;
  gTriUV_xz_m2 = triPos.xz * scale2;
  gTriUV_xy_m2 = triPos.xy * scale2;
  
  vec4 sampledAlbedo = sampleMaterialBlend(mapArray);
  // Convert albedo from sRGB to linear color space for correct PBR lighting
  vec3 linearAlbedo = sRGBToLinear(sampledAlbedo.rgb);
  
  // Debug mode 11: Material ID hue tinting (grayscale albedo + material hue)
  if (debugMode == 11) {
    // Convert to grayscale (luminance)
    float luma = dot(linearAlbedo, vec3(0.299, 0.587, 0.114));
    // Get dominant material ID (highest weight)
    float dominantId = (gMatBlend.x >= gMatBlend.y && gMatBlend.x >= gMatBlend.z) ? vMaterialIds.x :
                       (gMatBlend.y >= gMatBlend.z) ? vMaterialIds.y : vMaterialIds.z;
    // Blend hues based on material weights for smooth transitions
    float blendedHue = materialIdToHue(vMaterialIds.x) * gMatBlend.x +
                       materialIdToHue(vMaterialIds.y) * gMatBlend.y +
                       materialIdToHue(vMaterialIds.z) * gMatBlend.z;
    // Apply hue tint: HSV with blended hue, medium saturation, albedo luminance as value
    linearAlbedo = hsv2rgb(vec3(blendedHue, 0.6, luma));
  }
  
  #ifdef USE_TEXTURE_ALPHA
    vec4 diffuseColor = vec4(linearAlbedo, sampledAlbedo.a);
  #else
    vec4 diffuseColor = vec4(linearAlbedo, 1.0);
  #endif
`;

export const terrainRoughnessFragment = /* glsl */ `
  #ifdef QUALITY_METALNESS_MAPS
    float roughnessFactor = sampleMaterialBlend(roughnessArray).r * roughnessMultiplier;
  #else
    float roughnessFactor = roughnessMultiplier;
  #endif
  // Debug mode 17: force max roughness to isolate roughness as culprit
  if (debugMode == 17) roughnessFactor = 1.0;
`;

export const terrainMetalnessFragment = /* glsl */ `
  #ifdef QUALITY_METALNESS_MAPS
    float metalnessFactor = sampleMaterialBlend(metalnessArray).r * metalnessMultiplier;
  #else
    float metalnessFactor = 0.0;
  #endif
  // Debug mode 16: force zero metalness to isolate metalness as culprit
  if (debugMode == 16) metalnessFactor = 0.0;
`;

export const terrainAoFragment = /* glsl */ `
  #ifdef QUALITY_AO_MAPS
    float aoSample = sampleMaterialBlend(aoArray).r;
    float ambientOcclusion = mix(1.0, aoSample, aoIntensity);
  #else
    float ambientOcclusion = 1.0;
  #endif
  // Debug mode 18: force no AO to isolate AO as culprit
  if (debugMode == 18) ambientOcclusion = 1.0;
  reflectedLight.indirectDiffuse *= ambientOcclusion;
`;

export const terrainNormalFragment = /* glsl */ `
  #ifdef USE_NORMALMAP
    #ifdef QUALITY_NORMAL_MAPS
    // Early-out for uniform materials: sample only one material instead of three
    bool uniformMaterial = (vMaterialIds.x == vMaterialIds.y && vMaterialIds.y == vMaterialIds.z);
    
    vec3 normalSampleX, normalSampleY, normalSampleZ;
    
    if (uniformMaterial) {
      // Single material — 3 texture samples instead of 9
      #ifdef QUALITY_REDUCED_TRIPLANAR
        // Dominant-axis only — 1 texture sample for normals
        vec3 normalSample;
        if (gTriBlend.y >= gTriBlend.x && gTriBlend.y >= gTriBlend.z) {
          normalSample = texture(normalArray, vec3(gTriUV_xz_m0, vMaterialIds.x)).xyz * 2.0 - 1.0;
        } else if (gTriBlend.x >= gTriBlend.z) {
          normalSample = texture(normalArray, vec3(gTriUV_zy_m0, vMaterialIds.x)).xyz * 2.0 - 1.0;
        } else {
          normalSample = texture(normalArray, vec3(gTriUV_xy_m0, vMaterialIds.x)).xyz * 2.0 - 1.0;
        }
        // Assign to all three axis slots so the TBN blending below
        // still works — the dominant axis will dominate via gTriBlend weights
        normalSampleX = normalSample;
        normalSampleY = normalSample;
        normalSampleZ = normalSample;
      #else
        normalSampleX = texture(normalArray, vec3(gTriUV_zy_m0, vMaterialIds.x)).xyz * 2.0 - 1.0;
        normalSampleY = texture(normalArray, vec3(gTriUV_xz_m0, vMaterialIds.x)).xyz * 2.0 - 1.0;
        normalSampleZ = texture(normalArray, vec3(gTriUV_xy_m0, vMaterialIds.x)).xyz * 2.0 - 1.0;
      #endif
    } else {
      // Sample normals per-axis, per-material with individual repeat scales
      // Material 0
      vec3 normalSampleX_m0 = texture(normalArray, vec3(gTriUV_zy_m0, vMaterialIds.x)).xyz * 2.0 - 1.0;
      vec3 normalSampleY_m0 = texture(normalArray, vec3(gTriUV_xz_m0, vMaterialIds.x)).xyz * 2.0 - 1.0;
      vec3 normalSampleZ_m0 = texture(normalArray, vec3(gTriUV_xy_m0, vMaterialIds.x)).xyz * 2.0 - 1.0;
      // Material 1
      vec3 normalSampleX_m1 = texture(normalArray, vec3(gTriUV_zy_m1, vMaterialIds.y)).xyz * 2.0 - 1.0;
      vec3 normalSampleY_m1 = texture(normalArray, vec3(gTriUV_xz_m1, vMaterialIds.y)).xyz * 2.0 - 1.0;
      vec3 normalSampleZ_m1 = texture(normalArray, vec3(gTriUV_xy_m1, vMaterialIds.y)).xyz * 2.0 - 1.0;
      // Material 2
      vec3 normalSampleX_m2 = texture(normalArray, vec3(gTriUV_zy_m2, vMaterialIds.z)).xyz * 2.0 - 1.0;
      vec3 normalSampleY_m2 = texture(normalArray, vec3(gTriUV_xz_m2, vMaterialIds.z)).xyz * 2.0 - 1.0;
      vec3 normalSampleZ_m2 = texture(normalArray, vec3(gTriUV_xy_m2, vMaterialIds.z)).xyz * 2.0 - 1.0;
      
      // Blend materials per-axis
      normalSampleX = normalSampleX_m0 * gMatBlend.x + normalSampleX_m1 * gMatBlend.y + normalSampleX_m2 * gMatBlend.z;
      normalSampleY = normalSampleY_m0 * gMatBlend.x + normalSampleY_m1 * gMatBlend.y + normalSampleY_m2 * gMatBlend.z;
      normalSampleZ = normalSampleZ_m0 * gMatBlend.x + normalSampleZ_m1 * gMatBlend.y + normalSampleZ_m2 * gMatBlend.z;
    }
    
    normalSampleX.xy *= normalScale * normalStrength;
    normalSampleY.xy *= normalScale * normalStrength;
    normalSampleZ.xy *= normalScale * normalStrength;
    
    vec3 geomNormal = normalize(vNormal);
    
    // Use blended UVs for TBN (average of per-material UVs weighted by material blend)
    vec2 blendedUV_zy = gTriUV_zy_m0 * gMatBlend.x + gTriUV_zy_m1 * gMatBlend.y + gTriUV_zy_m2 * gMatBlend.z;
    vec2 blendedUV_xz = gTriUV_xz_m0 * gMatBlend.x + gTriUV_xz_m1 * gMatBlend.y + gTriUV_xz_m2 * gMatBlend.z;
    vec2 blendedUV_xy = gTriUV_xy_m0 * gMatBlend.x + gTriUV_xy_m1 * gMatBlend.y + gTriUV_xy_m2 * gMatBlend.z;
    
    mat3 tbnX = getTangentFrame(-vViewPosition, geomNormal, blendedUV_zy);
    mat3 tbnY = getTangentFrame(-vViewPosition, geomNormal, blendedUV_xz);
    mat3 tbnZ = getTangentFrame(-vViewPosition, geomNormal, blendedUV_xy);
    
    vec3 normalX = normalize(tbnX * normalSampleX);
    vec3 normalY = normalize(tbnY * normalSampleY);
    vec3 normalZ = normalize(tbnZ * normalSampleZ);
    
    normal = normalize(normalX * gTriBlend.x + normalY * gTriBlend.y + normalZ * gTriBlend.z);
    #else
    // Normal maps disabled by quality setting - use geometry normal
    normal = normalize(vNormal);
    #endif
    // Debug mode 19: force geometry normals to isolate normal map as culprit
    if (debugMode == 19) normal = normalize(vNormal);
  #endif
`;

export const terrainDebugFragment = /* glsl */ `
  #include <dithering_fragment>
  
  if (debugMode > 0) {
    if (debugMode == 1) {
      // Apply sRGB to linear conversion like normal rendering mode
      gl_FragColor = vec4(sRGBToLinear(sampleMaterialBlend(mapArray).rgb), 1.0);
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
    } else if (debugMode == 12) {
      // LAYER_ZERO_RAW: Force-sample layer 0, no sRGB, no material blend
      // If this looks correct, the texture data is fine and the bug is in blending/conversion
      vec4 raw0 = sampleTriPlanarMat(mapArray, 0.0, gTriUV_zy_m0, gTriUV_xz_m0, gTriUV_xy_m0);
      gl_FragColor = vec4(raw0.rgb, 1.0);
    } else if (debugMode == 13) {
      // LAYER_ZERO_SRGB: Force-sample layer 0 WITH sRGB conversion
      // Compare with mode 12 - if this looks wrong but 12 looks right, sRGB is the issue
      vec4 raw0 = sampleTriPlanarMat(mapArray, 0.0, gTriUV_zy_m0, gTriUV_xz_m0, gTriUV_xy_m0);
      gl_FragColor = vec4(sRGBToLinear(raw0.rgb), 1.0);
    } else if (debugMode == 14) {
      // PRIMARY_ONLY: Sample only the primary material (m0) with sRGB, ignoring blend
      // This isolates whether the blending math causes the issue
      vec4 m0raw = sampleTriPlanarMat(mapArray, vMaterialIds.x, gTriUV_zy_m0, gTriUV_xz_m0, gTriUV_xy_m0);
      gl_FragColor = vec4(sRGBToLinear(m0raw.rgb), 1.0);
    } else if (debugMode == 15) {
      // ALBEDO_NO_SRGB: Normal material blend but WITHOUT sRGB conversion
      // Compare with mode 1 (which HAS sRGB) - reveals double-conversion
      gl_FragColor = vec4(sampleMaterialBlend(mapArray).rgb, 1.0);
    } else if (debugMode == 20) {
      // OUTGOING_LIGHT: Show pre-tonemapping light output
      // Reveals what PBR computed before tone mapping changes it
      gl_FragColor = vec4(outgoingLight, 1.0);
    } else if (debugMode == 21) {
      // EFFECTIVE_DIFFUSE: Show diffuseColor * (1 - metalness)
      // This is what PBR uses as diffuse - if moss2 is dark here, metalness is too high
      vec3 effDiffuse = diffuseColor.rgb * (1.0 - metalnessFactor);
      gl_FragColor = vec4(effDiffuse, 1.0);
    }
    // Modes 16-19 don't write gl_FragColor - they override PBR inputs and let normal rendering proceed
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
  uniform float repeatScales[64];
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
  
  // Sample alpha with per-material repeat scales
  int m0 = int(vMaterialIds.x);
  int m1 = int(vMaterialIds.y);
  int m2 = int(vMaterialIds.z);
  float scale0 = repeatScales[m0];
  float scale1 = repeatScales[m1];
  float scale2 = repeatScales[m2];
  
  vec4 a0 = sampleTriPlanarAt(mapArray, pos, triBlend, scale0, vMaterialIds.x);
  vec4 a1 = sampleTriPlanarAt(mapArray, pos, triBlend, scale1, vMaterialIds.y);
  vec4 a2 = sampleTriPlanarAt(mapArray, pos, triBlend, scale2, vMaterialIds.z);
  float alpha = (a0.a * matBlend.x + a1.a * matBlend.y + a2.a * matBlend.z);
  
  if (alpha < alphaCutoff) {
    discard;
  }
`;

