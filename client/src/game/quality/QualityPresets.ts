/**
 * Quality Presets - Adaptive graphics settings for different hardware tiers
 *
 * Provides Ultra / High / Medium / Low presets that control:
 * - Post-processing (SSAO, bloom, god rays)
 * - Shadow quality (map size, distance, shadow-casting lights)
 * - Visibility radius (draw distance in chunks)
 * - Texture anisotropy
 * - Water quality
 *
 * Colour correction is always on (not a preset lever). MSAA, Resolution and FoV are
 * standalone user settings (see the store), not part of any preset. Normal/AO/metalness
 * shader maps are on for every preset; the debug panel keeps per-map toggles for shader
 * work, but presets never turn them off.
 *
 * `QUALITY_ROWS` (below) is the declarative source for the segmented Quality UI: each row
 * is one labelled control whose segments carry the exact `QualitySettings` patch they
 * apply. The preset table and the UI both read from it, so there is one place to edit.
 */

export type QualityLevel = 'ultra' | 'high' | 'medium' | 'low';

export const QUALITY_LEVELS: QualityLevel[] = ['low', 'medium', 'high', 'ultra'];

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
  godRaysEnabled: boolean;    // radial-blur rays from the sun/moon — high + ultra only
  godRaysSamples: number;     // radial-blur sample count (20 = Low, 60 = High)

  // Shadows
  shadowMapSize: number;      // 1024, 2048, 4096 (applied via environment settings)
  shadowsEnabled: boolean;    // false = "Off"; the moon casts too whenever this is on
  shadowRadius: number;       // Shadow casting distance in chunks (independent of visibility)

  // Terrain
  visibilityRadius: number;   // Chunk draw distance
  anisotropy: number;         // Texture anisotropic filtering (1/2/4/16)

  // Shader map toggles — on for every preset; debug panel may flip them for shader work
  shaderNormalMaps: boolean;
  shaderAoMaps: boolean;
  shaderMetalnessMaps: boolean;

  // Water: full 4-layer normals + second normal sample (ultra/high) vs cheap 2-layer (medium/low)
  waterHighQuality: boolean;
}

export const QUALITY_PRESETS: Record<QualityLevel, QualitySettings> = {
  ultra: {
    ssaoEnabled: true,
    bloomEnabled: true,
    godRaysEnabled: true,
    godRaysSamples: 60,   // High
    shadowMapSize: 4096,
    shadowsEnabled: true,
    shadowRadius: 8,
    visibilityRadius: 8,
    anisotropy: 16,
    shaderNormalMaps: true,
    shaderAoMaps: true,
    shaderMetalnessMaps: true,
    waterHighQuality: true,
  },
  high: {
    ssaoEnabled: true,
    bloomEnabled: true,
    godRaysEnabled: true,
    godRaysSamples: 20,   // Low
    shadowMapSize: 2048,
    shadowsEnabled: true,
    shadowRadius: 6,
    visibilityRadius: 6,
    anisotropy: 4,
    shaderNormalMaps: true,
    shaderAoMaps: true,
    shaderMetalnessMaps: true,
    waterHighQuality: true,
  },
  medium: {
    ssaoEnabled: false,
    bloomEnabled: false,
    godRaysEnabled: false,
    godRaysSamples: 20,   // unused (god rays off)
    shadowMapSize: 1024,
    shadowsEnabled: true,
    shadowRadius: 4,
    visibilityRadius: 4,
    anisotropy: 2,
    shaderNormalMaps: true,
    shaderAoMaps: true,
    shaderMetalnessMaps: true,
    waterHighQuality: false,
  },
  low: {
    ssaoEnabled: false,
    bloomEnabled: false,
    godRaysEnabled: false,
    godRaysSamples: 20,   // unused (god rays off)
    shadowMapSize: 1024,
    shadowsEnabled: false,
    shadowRadius: 2,
    visibilityRadius: 2,
    anisotropy: 1,
    shaderNormalMaps: true,
    shaderAoMaps: true,
    shaderMetalnessMaps: true,
    waterHighQuality: false,
  },
};

// ============== Segmented Quality UI descriptor ==============

/**
 * One segment of a Quality row — a label plus the exact `QualitySettings` patch it applies
 * when selected. `applyQualityPatch` (QualityManager) routes the patch to the right
 * subsystems, so the segment table below is the single source for both the preset values
 * and the in-game control.
 */
export interface QualitySegment {
  label: string;
  patch: Partial<QualitySettings>;
}

export interface QualityRow {
  key: string;
  label: string;
  segments: QualitySegment[];
  /** Index of the segment matching the given settings, or -1 if none match. */
  match: (q: QualitySettings) => number;
}

const shadowMapIndex: Record<number, number> = { 1024: 1, 2048: 2, 4096: 3 };

export const QUALITY_ROWS: QualityRow[] = [
  {
    key: 'shadows',
    label: 'Shadows',
    segments: [
      { label: 'Off', patch: { shadowsEnabled: false } },
      { label: '1024', patch: { shadowsEnabled: true, shadowMapSize: 1024 } },
      { label: '2048', patch: { shadowsEnabled: true, shadowMapSize: 2048 } },
      { label: '4096', patch: { shadowsEnabled: true, shadowMapSize: 4096 } },
    ],
    match: (q) => (!q.shadowsEnabled ? 0 : shadowMapIndex[q.shadowMapSize] ?? -1),
  },
  {
    key: 'shadowDistance',
    label: 'Shadow Distance',
    segments: [2, 4, 6, 8].map((n) => ({ label: String(n), patch: { shadowRadius: n } })),
    match: (q) => [2, 4, 6, 8].indexOf(q.shadowRadius),
  },
  {
    key: 'ssao',
    label: 'Ambient Occlusion',
    segments: [
      { label: 'Off', patch: { ssaoEnabled: false } },
      { label: 'On', patch: { ssaoEnabled: true } },
    ],
    match: (q) => (q.ssaoEnabled ? 1 : 0),
  },
  {
    key: 'bloom',
    label: 'Bloom',
    segments: [
      { label: 'Off', patch: { bloomEnabled: false } },
      { label: 'On', patch: { bloomEnabled: true } },
    ],
    match: (q) => (q.bloomEnabled ? 1 : 0),
  },
  {
    key: 'godRays',
    label: 'God Rays',
    segments: [
      { label: 'Off', patch: { godRaysEnabled: false } },
      { label: '20', patch: { godRaysEnabled: true, godRaysSamples: 20 } },
      { label: '60', patch: { godRaysEnabled: true, godRaysSamples: 60 } },
    ],
    match: (q) => (!q.godRaysEnabled ? 0 : q.godRaysSamples >= 60 ? 2 : 1),
  },
  {
    key: 'viewDistance',
    label: 'View Distance',
    segments: [2, 4, 6, 8].map((n) => ({ label: String(n), patch: { visibilityRadius: n } })),
    match: (q) => [2, 4, 6, 8].indexOf(q.visibilityRadius),
  },
  {
    key: 'anisotropy',
    label: 'Texture Filtering',
    segments: [1, 2, 4, 16].map((n) => ({ label: String(n), patch: { anisotropy: n } })),
    match: (q) => [1, 2, 4, 16].indexOf(q.anisotropy),
  },
  {
    key: 'water',
    label: 'Water',
    segments: [
      { label: 'Low', patch: { waterHighQuality: false } },
      { label: 'High', patch: { waterHighQuality: true } },
    ],
    match: (q) => (q.waterHighQuality ? 1 : 0),
  },
];

/**
 * Whether the live quality settings still match a preset exactly (ignoring `visibilityRadius`,
 * which is commonly overridden per-device without counting as "Custom"). Used by the UI to
 * highlight the active preset button or show a "Custom" badge.
 */
export function qualityMatchesPreset(q: QualitySettings, level: QualityLevel): boolean {
  const p = QUALITY_PRESETS[level];
  const keys = Object.keys(p) as (keyof QualitySettings)[];
  return keys.every((k) => k === 'visibilityRadius' || q[k] === p[k]);
}

/** MSAA is a standalone user setting (not preset-driven); shown as a Quality row for grouping. */
export const MSAA_OPTIONS: { label: string; value: number }[] = [
  { label: 'Off', value: 0 },
  { label: '2×', value: 2 },
  { label: '4×', value: 4 },
];

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
