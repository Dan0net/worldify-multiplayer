/**
 * Quality Presets - Adaptive graphics settings for different hardware tiers
 *
 * Provides Ultra / High / Medium / Low presets that control:
 * - Post-processing (SSAO, bloom, color correction)
 * - Shadow quality (map size, shadow-casting lights)
 * - Pixel ratio (render resolution)
 * - Visibility radius (draw distance in chunks)
 * - Texture anisotropy
 * - Antialias
 * - Shader map toggles (normal, AO, metalness)
 */

export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low';

export const QUALITY_LEVELS: QualityLevel[] = ['ultra', 'high', 'medium', 'low'];

export const QUALITY_LABELS: Record<QualityLevel, string> = {
  ultra: 'Ultra',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export interface QualitySettings {
  // Post-processing (individual toggles)
  ssaoEnabled: boolean;
  bloomEnabled: boolean;
  colorCorrectionEnabled: boolean;

  // Shadows
  shadowMapSize: number;      // 0 (off), 512, 1024, 2048, 4096
  shadowsEnabled: boolean;
  moonShadows: boolean;       // Moon casts shadows too

  // Rendering
  maxPixelRatio: number;      // Cap for devicePixelRatio
  msaaSamples: number;        // MSAA samples for post-processing FBO (0, 2, or 4)

  // Terrain
  visibilityRadius: number;   // Chunk draw distance
  anisotropy: number;         // Texture anisotropic filtering

  // Shader map toggles (skip expensive texture samples)
  shaderNormalMaps: boolean;
  shaderAoMaps: boolean;
  shaderMetalnessMaps: boolean;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  ultra: {
    ssaoEnabled: true,
    bloomEnabled: true,
    colorCorrectionEnabled: true,
    shadowMapSize: 4096,
    shadowsEnabled: true,
    moonShadows: true,
    maxPixelRatio: 2,
    msaaSamples: 4,
    visibilityRadius: 8,
    anisotropy: 8,
    shaderNormalMaps: true,
    shaderAoMaps: true,
    shaderMetalnessMaps: true,
  },
  high: {
    ssaoEnabled: false,
    bloomEnabled: true,
    colorCorrectionEnabled: true,
    shadowMapSize: 2048,
    shadowsEnabled: true,
    moonShadows: false,
    maxPixelRatio: 1.5,
    msaaSamples: 2,
    visibilityRadius: 6,
    anisotropy: 4,
    shaderNormalMaps: true,
    shaderAoMaps: true,
    shaderMetalnessMaps: true,
  },
  medium: {
    ssaoEnabled: false,
    bloomEnabled: false,
    colorCorrectionEnabled: true,
    shadowMapSize: 1024,
    shadowsEnabled: true,
    moonShadows: false,
    maxPixelRatio: 1,
    msaaSamples: 0,
    visibilityRadius: 5,
    anisotropy: 2,
    shaderNormalMaps: false,
    shaderAoMaps: false,
    shaderMetalnessMaps: true,
  },
  low: {
    ssaoEnabled: false,
    bloomEnabled: false,
    colorCorrectionEnabled: false,
    shadowMapSize: 0,
    shadowsEnabled: false,
    moonShadows: false,
    maxPixelRatio: 1,
    msaaSamples: 0,
    visibilityRadius: 3,
    anisotropy: 1,
    shaderNormalMaps: false,
    shaderAoMaps: false,
    shaderMetalnessMaps: false,
  },
};

/** Next preset when cycling with F8 */
export function cycleQualityLevel(current: QualityLevel): QualityLevel {
  const idx = QUALITY_LEVELS.indexOf(current);
  return QUALITY_LEVELS[(idx + 1) % QUALITY_LEVELS.length];
}

/** localStorage key for persisted quality setting */
const QUALITY_STORAGE_KEY = 'worldify-quality-level';
const VISIBILITY_STORAGE_KEY = 'worldify-visibility-radius';

/** Save quality level to localStorage */
export function saveQualityLevel(level: QualityLevel): void {
  try {
    localStorage.setItem(QUALITY_STORAGE_KEY, level);
  } catch { /* ignore */ }
}

/** Load quality level from localStorage */
export function loadSavedQualityLevel(): QualityLevel | null {
  try {
    const saved = localStorage.getItem(QUALITY_STORAGE_KEY);
    if (saved && QUALITY_LEVELS.includes(saved as QualityLevel)) {
      return saved as QualityLevel;
    }
  } catch { /* ignore */ }
  return null;
}

/** Save custom visibility radius override to localStorage */
export function saveVisibilityRadius(radius: number): void {
  try {
    localStorage.setItem(VISIBILITY_STORAGE_KEY, String(radius));
  } catch { /* ignore */ }
}

/** Load custom visibility radius override from localStorage */
export function loadSavedVisibilityRadius(): number | null {
  try {
    const saved = localStorage.getItem(VISIBILITY_STORAGE_KEY);
    if (saved) {
      const val = parseInt(saved, 10);
      if (!isNaN(val) && val >= 2 && val <= 12) return val;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Auto-detect quality level from GPU capabilities.
 * Runs a lightweight heuristic: checks renderer string, max texture size,
 * device pixel ratio, and available memory hints.
 */
export function detectQualityLevel(renderer: WebGLRenderingContext | WebGL2RenderingContext): QualityLevel {
  const debugExt = renderer.getExtension('WEBGL_debug_renderer_info');
  const gpuRenderer = debugExt
    ? renderer.getParameter(debugExt.UNMASKED_RENDERER_WEBGL) as string
    : '';
  const maxTextureSize = renderer.getParameter(renderer.MAX_TEXTURE_SIZE) as number;

  console.log(`[Quality] GPU: ${gpuRenderer}, maxTex: ${maxTextureSize}, dpr: ${window.devicePixelRatio}`);

  // Heuristic scoring
  let score = 0;

  // GPU string heuristics
  const gpu = gpuRenderer.toLowerCase();
  if (/rtx\s*(40[5-9]0|4080|4090|50[5-9]0|5080|5090)/i.test(gpuRenderer)) {
    score += 4; // High-end desktop
  } else if (/rtx\s*(30[5-9]0|3080|3090)/i.test(gpuRenderer)) {
    score += 3;
  } else if (/rtx|radeon\s*rx\s*(6[7-9]|7[0-9])/i.test(gpuRenderer)) {
    score += 2;
  } else if (/gtx\s*1[0-9]{3}|radeon\s*rx\s*(5[5-9]|6[0-6])/i.test(gpuRenderer)) {
    score += 1;
  } else if (gpu.includes('intel') || gpu.includes('iris') || gpu.includes('uhd')) {
    score -= 1; // Integrated
  } else if (gpu.includes('apple') && gpu.includes('m')) {
    // Apple Silicon — M1/M2/M3 are decent
    score += 2;
  } else if (gpu.includes('mali') || gpu.includes('adreno') || gpu.includes('powervr')) {
    score -= 2; // Mobile
  }

  // Texture size as a proxy for GPU tier
  if (maxTextureSize >= 16384) score += 1;
  else if (maxTextureSize <= 4096) score -= 1;

  // High DPI display suggests laptop (more pixels to push)
  if (window.devicePixelRatio > 1.5) score -= 1;

  // Determine level from score
  if (score >= 3) return 'ultra';
  if (score >= 1) return 'high';
  if (score >= 0) return 'medium';
  return 'low';
}
