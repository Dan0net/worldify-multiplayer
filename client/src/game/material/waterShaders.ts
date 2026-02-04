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
  
  // Get animated water normal from 4 scrolling texture layers
  // Opposing directions cancel out to prevent flow appearance
  vec3 getWaterNormal(vec3 worldPos, float time, vec3 baseNormal, sampler2DArray normalTex, float layer) {
    // Base UV from world position (XZ plane)
    vec2 baseUV = worldPos.xz;
    float scale = uNormalScale;
    
    // Layer 0: Fine detail, moving +X +Z
    vec2 uv0 = baseUV * scale * 0.1 + vec2(time * 0.06, time * 0.035);
    vec3 n0 = sampleWaterNormal(normalTex, layer, uv0);
    
    // Layer 1: Fine detail (similar scale), moving +X -Z (opposing Z!)
    vec2 uv1 = baseUV * scale * 0.095 - vec2(time * -0.05, time * 0.03);
    vec3 n1 = sampleWaterNormal(normalTex, layer, uv1);
    
    // Layer 2: Medium detail, moving -X +Z
    vec2 uv2 = baseUV * scale * 0.01 + vec2(time * 0.01, time * 0.01);
    vec3 n2 = sampleWaterNormal(normalTex, layer, uv2);
    
    // Layer 3: Coarse slow-moving, moving -X -Z (fully opposing)
    vec2 uv3 = baseUV * scale * 0.001 - vec2(time * 0.009, time * -0.008);
    vec3 n3 = sampleWaterNormal(normalTex, layer, uv3);
    
    // Sum and normalize (like Three.js: noise * 0.5 - 1.0 then sum)
    vec3 blendedNormal = n0 + n1 + n2 + n3;
    blendedNormal = blendedNormal * 0.5; // Average down
    
    // Apply strength and perturb base normal
    // Three.js uses: surfaceNormal = normalize(noise.xzy * vec3(1.5, 1.0, 1.5))
    vec3 perturbedNormal = baseNormal;
    perturbedNormal.x += blendedNormal.x * uNormalStrength;
    perturbedNormal.z += blendedNormal.y * uNormalStrength; // Swizzle like Three.js
    
    return normalize(perturbedNormal);
  }
`;

/** Fresnel effect for water transparency/reflectivity */
export const waterFresnelEffect = /* glsl */ `
  // Calculate fresnel factor for water
  // Higher values at glancing angles (edges more reflective/opaque)
  float getFresnelFactor(vec3 viewDir, vec3 normal) {
    float cosTheta = max(dot(viewDir, normal), 0.0);
    // Schlick's approximation
    float f0 = 0.02; // Water's reflectivity at normal incidence
    return f0 + (1.0 - f0) * pow(1.0 - cosTheta, uFresnelPower);
  }
  
  // Scatter effect - makes normal variations visible in the color
  // Direct approach like Three.js: scatter = dot(normal, viewDir) * waterColor
  vec3 getScatterColor(vec3 viewDir, vec3 normal, vec3 baseColor) {
    // Scatter intensity based on how much surface faces viewer
    float scatter = max(0.0, dot(normal, viewDir));
    
    // Three.js style: scatter directly multiplies color
    // Higher scatter = brighter, creates visible surface variation
    return baseColor * (0.5 + scatter * uScatterStrength);
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
  normalStrength: 1.5,      // Strength of normal perturbation (1-5 range)
  normalScale: 1.0,         // Scale of normal texture sampling
  scatterStrength: 1.0,     // Strength of scatter color variation (0-2)
  fresnelPower: 3.0,        // Fresnel falloff power
  waterTint: [0.6, 0.75, 0.85] as [number, number, number], // Slight blue tint
  waterOpacity: 0.7,        // Base opacity (edges will be more opaque)
};
