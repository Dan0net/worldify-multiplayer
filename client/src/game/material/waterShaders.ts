/**
 * Water Shader Code
 * 
 * GLSL shader snippets for animated water/liquid materials.
 * Creates choppy wave effects with animated normals for realistic water rendering.
 */

// ============== Water Uniform Declarations ==============

/** Water animation uniforms (vertex + fragment) */
export const waterUniformsVertex = /* glsl */ `
  uniform float uWaveTime;
  uniform float uWaveAmplitude;
  uniform float uWaveFrequency;
`;

export const waterUniformsFragment = /* glsl */ `
  uniform float uWaveTime;
  uniform float uNormalStrength;
  uniform float uNormalScale;
  uniform float uFresnelPower;
  uniform float uScatterStrength;
  uniform float uScatterScale;
  uniform float uWaterRoughness;
  uniform vec3 uWaterTint;
  uniform float uWaterOpacity;
`;

// ============== Vertex Shader - Wave Displacement ==============

/**
 * Simple wave vertex animation (wind-style)
 * Uses layered sine products for organic motion with XZ displacement.
 */
export const waterWaveVertex = /* glsl */ `
  // Get wave displacement for a position - wind-style layered sines
  vec3 getWaveDisplacement(vec3 pos, float time) {
    // Single phase from position (like wind shader)
    float phase = time + pos.x * uWaveFrequency + pos.z * uWaveFrequency * 0.7;
    
    // Layered sine products for organic motion
    float waveY = sin(phase) * sin(phase * 0.4 + 1.3);
    waveY += sin(phase * 0.6 + 0.8) * sin(phase * 0.35) * 0.5;
    
    // XZ displacement - slight horizontal sway
    float waveX = sin(phase * 0.8 + 2.1) * sin(phase * 0.3) * 0.3;
    float waveZ = cos(phase * 0.7 + 1.5) * sin(phase * 0.25) * 0.3;
    
    return vec3(waveX, waveY, waveZ) * uWaveAmplitude;
  }
`;

/** Apply wave displacement to vertex position */
export const waterVertexDisplacement = /* glsl */ `
  // Apply wave displacement to the vertex
  vec3 waveOffset = getWaveDisplacement(vWorldPosition, uWaveTime);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position + waveOffset, 1.0);
`;

// ============== Fragment Shader - Texture-Based Animated Normals ==============

/**
 * Sample water normal from texture at 4 scrolling UV layers
 * Uses opposing scroll directions to create standing wave patterns (no flow direction)
 */
export const waterNormalPerturbation = /* glsl */ `
  // Sample normal texture at scrolling UV
  vec3 sampleWaterNormal(sampler2DArray normalTex, float layer, vec2 uv) {
    vec4 n = texture(normalTex, vec3(uv, layer));
    return n.xyz * 2.0 - 1.0;
  }
  
  // Get animated water normal from texture layers
  // Uses paired counter-scrolling layers to create standing waves (no net flow)
  vec3 getWaterNormal(vec3 worldPos, float time, vec3 baseNormal, sampler2DArray normalTex, float layer) {
    // Safety check: ensure baseNormal is valid (avoid NaN from zero-length normalize)
    float baseLen = length(baseNormal);
    if (baseLen < 0.001) {
      return vec3(0.0, 1.0, 0.0); // Fallback to up
    }
    vec3 safeBaseNormal = baseNormal / baseLen;
    
    // Base UV from world position (XZ plane)
    vec2 baseUV = worldPos.xz;
    float scale = uNormalScale;
    
    // ===== MULTI-SCALE SCROLLING LAYERS =====
    // Different scales and directions create organic motion without obvious flow
    
    // Layer A: Fine ripples (fast, small scale)
    float fineScale = scale * 0.15;
    vec2 uvA = baseUV * fineScale + vec2(time * 0.045, time * 0.03);
    vec3 nA = sampleWaterNormal(normalTex, layer, uvA);
    
    // Layer B: Medium waves (slower, larger scale, opposite direction)
    float medScale = scale * 0.06;
    vec2 uvB = baseUV * medScale - vec2(time * 0.025, time * -0.02);
    vec3 nB = sampleWaterNormal(normalTex, layer, uvB);
    
    // Layer C: Large swell (slowest, largest scale, cross direction)
    float largeScale = scale * 0.03;
    vec2 uvC = baseUV * largeScale + vec2(time * -0.015, time * 0.018);
    vec3 nC = sampleWaterNormal(normalTex, layer, uvC);
    
    // Layer D: Detail (fastest, finest scale, diagonal)
    float detailScale = scale * 0.25;
    vec2 uvD = baseUV * detailScale + vec2(time * 0.035, time * -0.04);
    vec3 nD = sampleWaterNormal(normalTex, layer, uvD);
    
    // Weighted blend: primary layers stronger, detail layers add breakup
    vec3 blendedNormal = normalize(nA + nB * 0.8 + nC * 0.6 + nD * 0.4);
    
    // Apply strength and perturb base normal
    vec3 perturbedNormal = safeBaseNormal;
    perturbedNormal.x += blendedNormal.x * uNormalStrength;
    perturbedNormal.z += blendedNormal.y * uNormalStrength; // Swizzle XY->XZ
    
    // Safety: ensure we don't return a zero-length normal
    float perturbedLen = length(perturbedNormal);
    if (perturbedLen < 0.001) {
      return vec3(0.0, 1.0, 0.0); // Fallback to up
    }
    return perturbedNormal / perturbedLen;
  }
`;

/** Fresnel effect for water transparency/reflectivity */
export const waterFresnelEffect = /* glsl */ `
  // Calculate fresnel factor for water
  // Higher values at glancing angles (edges more reflective/opaque)
  float getFresnelFactor(vec3 viewDir, vec3 normal) {
    // Clamp to 0-1 range to prevent pow() with negative base (causes NaN)
    float cosTheta = clamp(dot(viewDir, normal), 0.0, 1.0);
    // Schlick's approximation
    float f0 = 0.02; // Water's reflectivity at normal incidence
    return f0 + (1.0 - f0) * pow(1.0 - cosTheta, uFresnelPower);
  }
  
  // Scatter effect - makes normal variations visible in the color
  // Energy-conserving: redistributes brightness without changing overall level
  vec3 getScatterColor(vec3 viewDir, vec3 normal, vec3 baseColor) {
    // Scatter intensity based on how much surface faces viewer
    float scatter = clamp(dot(normal, viewDir), 0.0, 1.0);
    
    // Scale the normal perturbation effect on scatter (controls spatial contrast)
    // Higher scatterScale = more contrast between normal-facing and grazing areas
    float scaledScatter = mix(0.5, scatter, uScatterScale);
    
    // Energy-conserving: center variation around 1.0 so strength
    // only affects contrast, not overall brightness/opacity
    float variation = (scaledScatter - 0.5) * uScatterStrength;
    float factor = clamp(1.0 + variation, 0.2, 2.0);
    
    return baseColor * factor;
  }
`;

// ============== Full Shader Modifications ==============

/** Water vertex shader prefix (uniforms + functions) */
export const waterVertexPrefix = /* glsl */ `
  varying vec3 vWorldPosition;
  varying vec3 vWorldNormal;
  varying vec3 vViewPosition;
  
  ${waterUniformsVertex}
  ${waterWaveVertex}
`;

/** Water vertex shader suffix (after standard processing) */
export const waterVertexSuffix = /* glsl */ `
  vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
  vWorldNormal = normalize((modelMatrix * vec4(normal, 0.0)).xyz);
  vViewPosition = cameraPosition - vWorldPosition;
  
  ${waterVertexDisplacement}
`;

/** Water fragment shader prefix (uniforms + functions) */
export const waterFragmentPrefix = /* glsl */ `
  varying vec3 vViewPosition;
  
  ${waterUniformsFragment}
  ${waterNormalPerturbation}
  ${waterFresnelEffect}
`;

/** Water normal fragment replacement */
export const waterNormalFragment = /* glsl */ `
  // Apply animated water normal perturbation
  vec3 animatedNormal = getWaterNormal(vWorldPosition, uWaveTime, vWorldNormal);
  
  // Override the geometry normal with our animated water normal
  #ifdef USE_NORMALMAP
    // Blend with texture normal if present
    vec3 mapN = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
    mapN.xy *= normalScale;
    normal = normalize(tbn * mapN);
    normal = normalize(mix(normal, animatedNormal, 0.7));
  #else
    normal = animatedNormal;
  #endif
`;

/** Water color/opacity fragment modification */
export const waterColorFragment = /* glsl */ `
  // Apply water tint to the diffuse color
  diffuseColor.rgb *= uWaterTint;
  
  // Calculate fresnel for edge opacity
  vec3 viewDir = normalize(vViewPosition);
  float fresnel = getFresnelFactor(viewDir, normal);
  
  // Increase opacity at glancing angles (edges)
  diffuseColor.a = mix(uWaterOpacity, 1.0, fresnel * 0.5);
`;

// ============== Default Values ==============

export const DEFAULT_WATER_SETTINGS = {
  waveAmplitude: 0.1,       // Height of waves in world units
  waveFrequency: 0.5,       // Base frequency of wave pattern
  waveSpeed: 0.5,           // Speed of wave animation
  normalStrength: 2.5,      // Strength of normal perturbation (1-5 range)
  normalScale: 1.0,         // Scale of normal texture sampling
  scatterStrength: 1.2,     // Strength of scatter color contrast (0-3)
  scatterScale: 1.0,        // How much normals affect scatter (0=flat, 1=full)
  roughness: 0.15,          // Surface roughness (0=mirror, 1=matte)
  fresnelPower: 3.0,        // Fresnel falloff power
  waterTint: [0.6, 0.75, 0.85] as [number, number, number], // Slight blue tint
  waterOpacity: 0.7,        // Base opacity (edges will be more opaque)
};
