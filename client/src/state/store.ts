import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { BUILD_ROTATION_STEPS, GameMode, clamp, defaultHotbarMeta, slotIsEmpty, templateToSlotMeta, PRESET_TEMPLATES, type BuildConfig, type PresetSlotMeta } from '@worldify/shared';
import { QUALITY_PRESETS, type QualityLevel, type QualitySettings } from '../game/quality/QualityPresets';
import {
  MATERIAL_ROUGHNESS_MULTIPLIER,
  MATERIAL_METALNESS_OFFSET,
  MATERIAL_AO_INTENSITY,
  MATERIAL_NORMAL_STRENGTH,
  LIGHT_SUN_INTENSITY,
  LIGHT_MOON_COLOR,
  SUN_DISTANCE,
  SUN_ELEVATION_MAX,
  DEFAULT_TIME_OF_DAY,
  DEFAULT_TIME_SPEED,
  HEMISPHERE_SKY_DAY,
  HEMISPHERE_GROUND_DAY,
  HEMISPHERE_INTENSITY_DAY,
  HEMISPHERE_GROUND_NIGHT,
  SUN_COLOR_NOON,
  normalizeDayNightConfig,
  type DayNightKeyframe,
  type DayNightConfig,
} from '@worldify/shared';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/** Texture loading state */
export type TextureLoadingState = 'none' | 'loading-low' | 'low' | 'loading-high' | 'high';

/** Terrain shader debug modes */
export const TERRAIN_DEBUG_MODE_NAMES = ['Off', 'Sunlight', 'Albedo', 'Normal', 'AO', 'Roughness', 'Metalness', 'TriBlend', 'MatIDs', 'MatWeights', 'WorldNormal', 'MatHue', 'BlockLight'] as const;

/**
 * Display order for the debug-mode selector — decoupled from the numeric mode values
 * (which map to shader branches) so BlockLight can sit right after Sunlight without
 * renumbering the shader. Values index into TERRAIN_DEBUG_MODE_NAMES.
 */
export const TERRAIN_DEBUG_MODE_ORDER: readonly TerrainDebugMode[] = [0, 1, 12, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
export type TerrainDebugMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

/**
 * Build-preview lighting mode (debug):
 *  - 'off'      — no preview lighting at all; the preview mesh shows inherited (pre-edit) light and
 *                 nothing relights until the edit is committed.
 *  - 'deferred' — drawn+margin lit immediately; spill into neighbours is deferred to when the cursor
 *                 settles (cheap while dragging; neighbours light a beat after you stop). Default.
 *  - 'full'     — real-time spill: the full relight (drawn+margin+spill) runs on every preview batch,
 *                 never deferred (correct while moving, but pays the spill cost every frame).
 */
export type BuildPreviewLighting = 'off' | 'deferred' | 'full';
export const BUILD_PREVIEW_LIGHTING_ORDER: readonly BuildPreviewLighting[] = ['off', 'deferred', 'full'];
export const BUILD_PREVIEW_LIGHTING_LABELS: Record<BuildPreviewLighting, string> = {
  off: 'Off (commit only)',
  deferred: 'Deferred',
  full: 'Full real-time',
};

/** Voxel debug visualization toggles */
export interface VoxelDebugToggles {
  showChunkBounds: boolean;
  showEmptyChunks: boolean;
  showCollisionMesh: boolean;
  showChunkCoords: boolean;
  showWireframe: boolean;
  /** Reconcile vertex normals across chunk seams (on by default; toggle to compare). */
  stitchSeams: boolean;
}

/** Voxel world statistics */
/** Per-coarse-ring diagnostics (one entry per resident coarse LOD level, finest→coarsest). */
export interface CoarseLevelStat {
  level: number;
  chunks: number;
  drawn: number;
  incomplete: number;
  quiet: boolean;
}

export interface VoxelStats {
  chunksLoaded: number;
  meshesVisible: number;
  debugObjects: number;
  /** Per-coarse-ring breakdown for the debug panel; empty when no rings are resident. */
  coarseLevels: CoarseLevelStat[];
}

/** Performance timing snapshot (updated from game loop) */
export interface PerfSnapshot {
  // Per-subsystem times in ms (rolling averages)
  gameUpdate: number;
  physics: number;
  voxelUpdate: number;
  remesh: number;
  lighting: number;
  grouper: number;
  buildPreview: number;
  players: number;
  environment: number;
  render: number;
  // Three.js renderer info
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  // Voxel-specific
  remeshQueueSize: number;
  pendingChunks: number;
  colliderQueueSize: number;
  groupsRebuilt: number;
  bufferReallocs: number;
  meshDispatches: number;
  // Memory
  jsHeapMB: number;
}

/** Build tool state */
export interface BuildState {
  /** Whether build mode is active (the player is building, not just walking) */
  buildMode: boolean;
  /** Currently selected preset ID (0-9) — the "current build item" */
  presetId: number;
  /** Current rotation in steps (0 to BUILD_ROTATION_STEPS-1) */
  rotationSteps: number;
  /** Whether a valid build target is found */
  hasValidTarget: boolean;
  /** Reason the target is invalid, or null if valid */
  invalidReason: 'tooClose' | null;
  /** Whether point-snapping is enabled */
  snapPoint: boolean;
  /** Whether grid-snapping is enabled */
  snapGrid: boolean;
  /** Whether the build menu overlay is open */
  menuOpen: boolean;
  /** Per-slot metadata + geometry (parts, align, snapShape, baseRotation, autoRotateY, templateName) */
  presetMeta: PresetSlotMeta[];
}

/** Environment/lighting settings (everything NOT driven by the day-night keyframes). */
export interface EnvironmentSettings {
  // Day-Night Cycle master + clock. When enabled, the cycle derives sun/moon/hemisphere/sky
  // from `timeOfDay` + the `DayNightConfig` keyframes (single source of truth). When disabled,
  // the scene holds at the palette/position for the current `timeOfDay`.
  dayNightEnabled: boolean;
  timeOfDay: number;              // 0-1 normalized time
  timeSpeed: number;              // Game-minutes per real-second (0 = paused)

  // Shadow settings
  shadowBias: number;       // -0.01 to 0.01
  shadowNormalBias: number; // 0 to 0.1
  shadowMapSize: number;    // 512, 1024, 2048, 4096
  shadowBlurRadius: number; // 1-25, controls shadow edge softness

  // Post-processing effects
  ssaoIntensity: number;        // 0-4
  ssaoRadius: number;           // 0-0.5
  bloomIntensity: number;       // 0-3
  bloomThreshold: number;       // 0-1
  bloomRadius: number;          // 0-3
  godRaysDecay: number;         // 0-1
  godRaysExposure: number;      // 0-1

  // Color correction
  saturation: number;           // 0-2, 1.0 = no change

  // Voxel light fill curves — exponents applied to the per-vertex light channels.
  skyFillPower: number;         // sky-light channel: <1 lifts dark areas (0.5 = sqrt)
  blockFillPower: number;       // block-light channel: >1 = tighter drop-off (2 = square)

  // Block light (emitters, e.g. lava) — warm, sun-independent glow
  blockLightColor: string;      // hex colour, e.g. '#ffb050'
  blockLightIntensity: number;  // 0-4, brightness multiplier of the block-light term
}

/**
 * `DayNightConfig` (defined in `@worldify/shared`) — the single source of truth for the day-night
 * look. Sun/moon appearance + arc are global; timing is four transition-window boundaries; the four
 * `keyframes` are the phase palettes [Night, Sunrise, Day, Sunset]. `deriveLighting(cfg, time)` is
 * the one place that turns this into lighting.
 */
export type { DayNightKeyframe, DayNightConfig };

export const DEFAULT_DAY_NIGHT_CONFIG: DayNightConfig = {
  sunHeight: SUN_ELEVATION_MAX, sunDistance: SUN_DISTANCE, sunSize: 1.0, sunIntensity: LIGHT_SUN_INTENSITY,
  moonHeight: 55, moonDistance: SUN_DISTANCE, moonSize: 0.5, moonIntensity: 1.0,
  // Long day: dawn ~04:34–06:58, dusk ~19:55–22:05 (sunset centre ≈ 21:00).
  sunriseStart: 0.19, sunriseEnd: 0.29, sunsetStart: 0.83, sunsetEnd: 0.92,
  twilightAngle: 6,  // ± elevation band for the twilight fade / hand-off overlap
  keyframes: [
    {
      name: 'Night',
      sunColor: '#334466', moonColor: LIGHT_MOON_COLOR,
      skyZenithColor: '#0b1a33', skyHorizonColor: '#243b66', groundColor: HEMISPHERE_GROUND_NIGHT,
      hemisphereIntensity: 0.6,
    },
    {
      name: 'Sunrise',
      sunColor: '#ffb066', moonColor: LIGHT_MOON_COLOR,
      skyZenithColor: '#5577aa', skyHorizonColor: '#ff9d5c', groundColor: '#887766',
      hemisphereIntensity: 1.0,
    },
    {
      name: 'Day',
      sunColor: SUN_COLOR_NOON, moonColor: LIGHT_MOON_COLOR,
      skyZenithColor: HEMISPHERE_SKY_DAY, skyHorizonColor: '#bfe3f5', groundColor: HEMISPHERE_GROUND_DAY,
      hemisphereIntensity: HEMISPHERE_INTENSITY_DAY,
    },
    {
      name: 'Sunset',
      sunColor: '#ff5522', moonColor: LIGHT_MOON_COLOR,
      skyZenithColor: '#4d3380', skyHorizonColor: '#ff6622', groundColor: '#553322',
      hemisphereIntensity: 1.0,
    },
  ],
};

/** Material shader settings for debug/tweaking */
export interface MaterialSettings {
  // Texture multipliers (applied in shader)
  roughnessMultiplier: number;    // 0-2, multiplied with texture value
  metalnessOffset: number;        // 0-1, added to metalness texture value
  aoIntensity: number;            // 0-2, AO effect strength
  normalStrength: number;         // 0-2, normal map intensity
  
  // Tri-planar blending
  blendSharpness: number;         // 1-8, higher = sharper blending
  repeatScale: number;            // 0.5-4, texture repeat scale
  
  // Wind animation (transparent materials)
  windStrength: number;           // 0-0.5
  windSpeed: number;              // 0-2
  windFrequency: number;          // 0.1-3
}

/** Water shader settings for debug/tweaking */
export interface WaterSettings {
  waveAmplitude: number;          // 0-0.5, wave height
  waveFrequency: number;          // 0.1-3, wave pattern frequency
  waveSpeed: number;              // 0-2, wave animation speed
  normalStrength: number;         // 1-5, normal perturbation strength
  normalScale: number;            // 0.1-3, texture sampling scale
  scatterStrength: number;        // 0-3, scatter color contrast
  scatterScale: number;           // 0-1, how much normals affect scatter
  roughness: number;              // 0-1, surface roughness
  fresnelPower: number;           // 1-8, edge reflection falloff
  waterOpacity: number;           // 0-1, base transparency
  waterTint: [number, number, number]; // RGB tint values 0-1
}

/** Default material settings - uses shared constants for consistency with pallet viewer */
export const DEFAULT_MATERIAL_SETTINGS: MaterialSettings = {
  roughnessMultiplier: MATERIAL_ROUGHNESS_MULTIPLIER,
  metalnessOffset: MATERIAL_METALNESS_OFFSET,
  aoIntensity: MATERIAL_AO_INTENSITY,
  normalStrength: MATERIAL_NORMAL_STRENGTH,
  blendSharpness: 8.0,
  repeatScale: 2.0,
  windStrength: 0.1,
  windSpeed: 0.7,
  windFrequency: 1.0,
};

/** Default water settings */
export const DEFAULT_WATER_SETTINGS: WaterSettings = {
  waveAmplitude: 0.1,
  waveFrequency: 0.5,
  waveSpeed: 0.5,
  normalStrength: 2.5,
  normalScale: 1.0,
  scatterStrength: 1.2,
  scatterScale: 1.0,
  roughness: 0.15,
  fresnelPower: 3.0,
  waterOpacity: 0.7,
  waterTint: [0.6, 0.75, 0.85],
};

/** Default environment settings - uses shared constants for consistency with pallet viewer */
export const DEFAULT_ENVIRONMENT: EnvironmentSettings = {
  // Day-Night Cycle - enabled by default for dynamic lighting
  dayNightEnabled: true,
  timeOfDay: DEFAULT_TIME_OF_DAY,
  timeSpeed: DEFAULT_TIME_SPEED,

  shadowBias: -0.0001,
  shadowNormalBias: 0.02,
  shadowMapSize: 4096,
  shadowBlurRadius: 8,

  ssaoIntensity: 4,
  ssaoRadius: 0.1,
  bloomIntensity: 1,
  bloomThreshold: 0.8,
  bloomRadius: 0.5,
  godRaysDecay: 0.90,
  godRaysExposure: 0.25,
  saturation: 1.2,  // Slightly boosted for more vivid colors
  skyFillPower: 0.5,    // sqrt → lifts dark sky-lit areas
  blockFillPower: 2.0,  // square → tighter block-light drop-off
  blockLightColor: '#ffd397',
  blockLightIntensity: 4.0,
};

/** Debug panel section collapse state */
export interface DebugPanelSections {
  performance: boolean;   // merged client-side stats + frame timing
  debug: boolean;
  quality: boolean;
  materials: boolean;
  water: boolean;
  dayNightCycle: boolean;
  environment: boolean;   // advanced tuning (post-FX magnitudes, manual lights)
}

export interface GameState {
  // Connection
  connectionStatus: ConnectionStatus;
  roomId: string | null;
  playerId: number | null;
  playerCount: number;
  ping: number;

  // Game mode
  gameMode: GameMode;

  // Spawn readiness (terrain found at spawn point)
  spawnReady: boolean;

  /** True once the explore→first-person camera intro has finished — reveals the arm + hotbar. */
  firstPersonReady: boolean;

  /** True when the explore camera has settled (no play→explore outro in flight) — shows explore UI. */
  exploreReady: boolean;

  // Network chunk streaming
  useServerChunks: boolean;

  // Material/texture loading
  textureState: TextureLoadingState;
  textureProgress: number; // 0-1 for loading progress

  // Voxel build system
  build: BuildState;

  // Debug
  fps: number;
  tickMs: number;
  serverTick: number;

  // Performance stats (detailed subsystem timing)
  perfStats: PerfSnapshot;

  // Voxel debug
  voxelDebug: VoxelDebugToggles;
  voxelStats: VoxelStats;
  
  // Terrain shader debug
  terrainDebugMode: TerrainDebugMode;

  // Build-preview lighting mode (debug)
  buildPreviewLighting: BuildPreviewLighting;

  // Quality settings.
  // `quality` is the single source of truth for the active QualitySettings
  // (seeded from QUALITY_PRESETS, overridden at runtime). `qualityLevel` is the
  // selected preset name (for UI highlighting). `fov`/`renderScale` are separate
  // user controls, not part of a preset.
  qualityLevel: QualityLevel;
  quality: QualitySettings;
  fov: number;
  renderScale: number;          // 0.5-1.0 — sub-native render resolution (fill-rate lever)
  msaaSamples: number;          // 0/2/4 — standalone AA (composer FBO), independent of preset

  // Dev mode - force regenerate chunks on server
  forceRegenerateChunks: boolean;

  // Environment settings
  environment: EnvironmentSettings;

  // Day-night stage keyframes (single source of truth for the cycle)
  dayNightConfig: DayNightConfig;
  
  // Material shader settings
  materialSettings: MaterialSettings;
  
  // Water shader settings
  waterSettings: WaterSettings;
  
  // Debug panel section collapse state
  debugPanelSections: DebugPanelSections;
  
  // Map overlay
  showMapOverlay: boolean;
  mapTileCount: number;

  // Actions
  setConnectionStatus: (status: ConnectionStatus) => void;
  setRoomInfo: (roomId: string, playerId: number) => void;
  setPlayerCount: (count: number) => void;
  setPing: (ping: number) => void;
  setGameMode: (mode: GameMode) => void;
  setSpawnReady: (ready: boolean) => void;
  setFirstPersonReady: (ready: boolean) => void;
  setExploreReady: (ready: boolean) => void;
  setUseServerChunks: (enabled: boolean) => void;
  setDebugStats: (fps: number, tickMs: number) => void;
  setServerTick: (tick: number) => void;
  setPerfStats: (stats: PerfSnapshot) => void;
  
  // Voxel debug actions
  toggleVoxelDebug: (key: keyof VoxelDebugToggles) => void;
  setVoxelDebug: (updates: Partial<VoxelDebugToggles>) => void;
  setVoxelStats: (stats: Partial<VoxelStats>) => void;
  
  // Terrain debug actions
  setTerrainDebugMode: (mode: TerrainDebugMode) => void;
  cycleTerrainDebugMode: () => void;

  // Build-preview lighting mode action
  setBuildPreviewLighting: (mode: BuildPreviewLighting) => void;

  // Quality actions
  setQualityLevel: (level: QualityLevel) => void;
  setQuality: (settings: QualitySettings) => void;
  updateQuality: (partial: Partial<QualitySettings>) => void;
  setFov: (fov: number) => void;
  setRenderScale: (scale: number) => void;
  setMsaaSamples: (samples: number) => void;

  // Build actions
  setBuildMode: (on: boolean) => void;
  toggleBuildMode: () => void;
  setBuildPreset: (presetId: number) => void;
  cycleBuildPreset: (dir: 1 | -1) => void;
  setBuildRotation: (rotationSteps: number) => void;
  rotateBuild: (direction: number) => void;
  setBuildHasValidTarget: (valid: boolean) => void;
  setBuildInvalidReason: (reason: 'tooClose' | null) => void;
  toggleBuildSnapPoint: () => void;
  toggleBuildSnapGrid: () => void;
  setBuildMenuOpen: (open: boolean) => void;
  toggleBuildMenu: () => void;
  updatePresetConfig: (presetId: number, updates: Partial<BuildConfig>) => void;
  updatePresetMeta: (presetId: number, updates: Partial<PresetSlotMeta>) => void;
  applyPresetTemplate: (slotId: number, templateIndex: number) => void;
  
  // Material/texture actions
  setTextureState: (state: TextureLoadingState) => void;
  setTextureProgress: (progress: number) => void;
  
  // Dev mode actions
  setForceRegenerateChunks: (enabled: boolean) => void;
  toggleForceRegenerate: () => void;
  toggleForceRegenerateChunks: () => void;
  
  // Environment actions
  setEnvironment: (updates: Partial<EnvironmentSettings>) => void;
  setTimeOfDay: (time: number) => void;
  setTimeSpeed: (speed: number) => void;

  // Day-night config actions
  updateKeyframe: (index: number, updates: Partial<DayNightKeyframe>) => void;
  setDayNightConfig: (updates: Partial<Omit<DayNightConfig, 'keyframes'>>) => void;

  // Material settings actions
  setMaterialSettings: (updates: Partial<MaterialSettings>) => void;
  resetMaterialSettings: () => void;
  
  // Water settings actions
  setWaterSettings: (updates: Partial<WaterSettings>) => void;
  resetWaterSettings: () => void;
  
  // Debug panel actions
  debugPanelExpanded: boolean;
  toggleDebugPanelExpanded: () => void;
  toggleDebugSection: (section: keyof DebugPanelSections) => void;
  
  // Map overlay actions
  toggleMapOverlay: () => void;
  setMapTileCount: (count: number) => void;
}

// Persist store across HMR to prevent React/game code store instance mismatch
const storeKey = '__GAME_STORE__' as const;
declare global {
  interface Window {
    [storeKey]?: UseBoundStore<StoreApi<GameState>>;
  }
}

/** First buildable (non-empty) hotbar slot — used when build mode is entered on an empty slot. */
const firstBuildableSlot = (metas: PresetSlotMeta[]): number => {
  const idx = metas.findIndex((m) => !slotIsEmpty(m));
  return idx >= 0 ? idx : 0;
};

// Use existing store if available (HMR), otherwise create new one
export const useGameStore: UseBoundStore<StoreApi<GameState>> = window[storeKey] ?? create<GameState>((set) => ({
  // Initial state
  connectionStatus: 'disconnected',
  roomId: null,
  playerId: null,
  playerCount: 0,
  ping: 0,
  gameMode: GameMode.Explore, // Start in explore mode (free camera home screen)
  spawnReady: false, // Terrain not found yet
  firstPersonReady: false, // Camera intro not finished yet
  exploreReady: true, // Start on the home/explore screen with the explore UI shown
  useServerChunks: true, // Default to server chunks in multiplayer
  textureState: 'none',
  textureProgress: 0,
  fps: 0,
  tickMs: 0,
  serverTick: 0,
  perfStats: {
    gameUpdate: 0, physics: 0, voxelUpdate: 0, remesh: 0, lighting: 0, grouper: 0,
    buildPreview: 0, players: 0, environment: 0, render: 0,
    drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0,
    remeshQueueSize: 0, pendingChunks: 0, colliderQueueSize: 0,
    groupsRebuilt: 0, bufferReallocs: 0, meshDispatches: 0, jsHeapMB: 0,
  },
  
  // Build initial state
  build: {
    buildMode: false,   // Not building by default — walk/explore first
    presetId: 1,        // Torch selected at spawn (shown in hand); RMB enters build mode
    rotationSteps: 0,   // No rotation
    hasValidTarget: false,
    invalidReason: null,
    snapPoint: true,    // Point snapping on by default
    snapGrid: false,    // Grid snapping off by default
    menuOpen: false,
    presetMeta: defaultHotbarMeta(),
  },
  
  // Voxel debug initial state
  voxelDebug: {
    showChunkBounds: false,
    showEmptyChunks: false,
    showCollisionMesh: false,
    showChunkCoords: false,
    showWireframe: false,
    stitchSeams: true,
  },
  voxelStats: {
    chunksLoaded: 0,
    meshesVisible: 0,
    debugObjects: 0,
    coarseLevels: [],
  },
  
  // Terrain debug initial state
  terrainDebugMode: 0 as TerrainDebugMode,
  buildPreviewLighting: 'deferred' as BuildPreviewLighting,
  
  // Quality initial state (auto-detect / restore overrides on first load)
  qualityLevel: 'ultra' as QualityLevel,
  quality: { ...QUALITY_PRESETS.ultra },
  fov: 90,
  renderScale: 1,
  msaaSamples: 0,

  // Dev mode initial state
  forceRegenerateChunks: false,

  // Environment initial state
  environment: { ...DEFAULT_ENVIRONMENT },

  // Day-night config (globals + timing + phase palettes)
  dayNightConfig: {
    ...DEFAULT_DAY_NIGHT_CONFIG,
    keyframes: DEFAULT_DAY_NIGHT_CONFIG.keyframes.map((k) => ({ ...k })),
  },

  // Material settings initial state
  materialSettings: { ...DEFAULT_MATERIAL_SETTINGS },
  
  // Water settings initial state
  waterSettings: { ...DEFAULT_WATER_SETTINGS },
  
  // Debug panel starts compact (FPS only)
  debugPanelExpanded: false,
  
  // Debug panel sections (Performance open by default; rest collapsed)
  debugPanelSections: {
    performance: true,
    debug: false,
    quality: false,
    materials: false,
    water: false,
    dayNightCycle: false,
    environment: false,
  },
  
  // Map overlay initial state
  showMapOverlay: true,
  mapTileCount: 0,

  // Actions
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setRoomInfo: (roomId, playerId) => set({ roomId, playerId }),
  setPlayerCount: (count) => set({ playerCount: count }),
  setPing: (ping) => set({ ping }),
  setGameMode: (mode) => set({ gameMode: mode }),
  setSpawnReady: (ready) => set({ spawnReady: ready }),
  setFirstPersonReady: (ready) => set({ firstPersonReady: ready }),
  setExploreReady: (ready) => set({ exploreReady: ready }),
  setUseServerChunks: (enabled) => set({ useServerChunks: enabled }),
  setDebugStats: (fps, tickMs) => set({ fps, tickMs }),
  setServerTick: (tick) => set({ serverTick: tick }),
  setPerfStats: (stats) => set({ perfStats: stats }),
  
  // Voxel debug actions
  toggleVoxelDebug: (key) => set((state) => ({
    voxelDebug: {
      ...state.voxelDebug,
      [key]: !state.voxelDebug[key],
    },
  })),
  setVoxelDebug: (updates) => set((state) => ({
    voxelDebug: {
      ...state.voxelDebug,
      ...updates,
    },
  })),
  setVoxelStats: (stats) => set((state) => ({
    voxelStats: {
      ...state.voxelStats,
      ...stats,
    },
  })),
  
  // Terrain debug actions
  setTerrainDebugMode: (mode) => set({ terrainDebugMode: mode }),
  cycleTerrainDebugMode: () => set((state) => ({
    terrainDebugMode: ((state.terrainDebugMode + 1) % 13) as TerrainDebugMode,
  })),

  setBuildPreviewLighting: (mode) => set({ buildPreviewLighting: mode }),

  // Quality actions
  setQualityLevel: (level) => set({ qualityLevel: level }),
  setQuality: (settings) => set({ quality: settings }),
  updateQuality: (partial) => set((state) => ({ quality: { ...state.quality, ...partial } })),
  setFov: (fov) => set({ fov }),
  setRenderScale: (scale) => set({ renderScale: scale }),
  setMsaaSamples: (samples) => set({ msaaSamples: samples }),

  // Build actions
  setBuildMode: (on) => set((state) => {
    const presetId = on && slotIsEmpty(state.build.presetMeta[state.build.presetId])
      ? firstBuildableSlot(state.build.presetMeta) : state.build.presetId;
    // Leaving build mode also closes the menu.
    return { build: { ...state.build, buildMode: on, presetId, menuOpen: on ? state.build.menuOpen : false } };
  }),
  toggleBuildMode: () => set((state) => {
    const on = !state.build.buildMode;
    const presetId = on && slotIsEmpty(state.build.presetMeta[state.build.presetId])
      ? firstBuildableSlot(state.build.presetMeta) : state.build.presetId;
    return { build: { ...state.build, buildMode: on, presetId, menuOpen: on ? state.build.menuOpen : false } };
  }),
  setBuildPreset: (presetId) => set((state) => ({
    // Switching the selected item always drops out of build mode (and closes the menu); the item
    // shows in hand, and the player re-enters build mode with RMB / R.
    build: { ...state.build, presetId, buildMode: false, menuOpen: false },
  })),
  cycleBuildPreset: (dir) => set((state) => {
    // Step one slot in display order (keys 1..9,0). Empty slots are selectable too (bare hand).
    const order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
    const start = order.indexOf(state.build.presetId);
    const idx = order[((start + dir) % order.length + order.length) % order.length];
    return { build: { ...state.build, presetId: idx, buildMode: false, menuOpen: false } };
  }),
  setBuildRotation: (rotationSteps) => set((state) => ({
    build: { ...state.build, rotationSteps: rotationSteps & (BUILD_ROTATION_STEPS - 1) },
  })),
  rotateBuild: (direction) => set((state) => ({
    build: {
      ...state.build,
      rotationSteps: (state.build.rotationSteps + direction + BUILD_ROTATION_STEPS) % BUILD_ROTATION_STEPS,
    },
  })),
  setBuildHasValidTarget: (hasValidTarget) => set((state) => ({
    build: { ...state.build, hasValidTarget },
  })),
  setBuildInvalidReason: (invalidReason) => set((state) => ({
    build: { ...state.build, invalidReason },
  })),
  toggleBuildSnapPoint: () => set((state) => ({
    build: { ...state.build, snapPoint: !state.build.snapPoint },
  })),
  toggleBuildSnapGrid: () => set((state) => ({
    build: { ...state.build, snapGrid: !state.build.snapGrid },
  })),
  setBuildMenuOpen: (open) => set((state) => (
    // The menu is just an assignable picker now — it does not force build mode.
    { build: { ...state.build, menuOpen: open } }
  )),
  toggleBuildMenu: () => set((state) => (
    { build: { ...state.build, menuOpen: !state.build.menuOpen } }
  )),
  updatePresetConfig: (presetId, updates) => set((state) => {
    // The config tab edits the primary part (parts[0]) of the slot's geometry.
    const metas = [...state.build.presetMeta];
    const meta = metas[presetId];
    if (!meta || !meta.parts.length) return state;
    const parts = meta.parts.map((p, i) =>
      i === 0 ? { ...p, config: { ...p.config, ...updates } } : p);
    metas[presetId] = { ...meta, parts };
    return { build: { ...state.build, presetMeta: metas } };
  }),
  updatePresetMeta: (presetId, updates) => set((state) => {
    const metas = [...state.build.presetMeta];
    metas[presetId] = { ...metas[presetId], ...updates };
    return { build: { ...state.build, presetMeta: metas } };
  }),
  applyPresetTemplate: (slotId, templateIndex) => set((state) => {
    const template = PRESET_TEMPLATES[templateIndex];
    if (!template) return state;
    const metas = [...state.build.presetMeta];
    metas[slotId] = templateToSlotMeta(template);
    return { build: { ...state.build, presetMeta: metas } };
  }),
  
  // Material/texture actions
  setTextureState: (textureState) => set({ textureState }),
  setTextureProgress: (textureProgress) => set({ textureProgress }),
  
  // Dev mode actions
  setForceRegenerateChunks: (forceRegenerateChunks) => set({ forceRegenerateChunks }),
  toggleForceRegenerate: () => set((state) => ({ forceRegenerateChunks: !state.forceRegenerateChunks })),
  toggleForceRegenerateChunks: () => set((state) => ({
    forceRegenerateChunks: !state.forceRegenerateChunks,
  })),
  
  // Environment actions
  setEnvironment: (updates) => set((state) => ({
    environment: { ...state.environment, ...updates },
  })),
  setTimeOfDay: (time) => set((state) => ({
    environment: { ...state.environment, timeOfDay: clamp(time, 0, 1) },
  })),
  setTimeSpeed: (speed) => set((state) => ({
    environment: { ...state.environment, timeSpeed: Math.max(0, speed) },
  })),

  updateKeyframe: (index, updates) => set((state) => {
    const keyframes = state.dayNightConfig.keyframes.map((k, i) =>
      i === index ? { ...k, ...updates } : k
    );
    return { dayNightConfig: { ...state.dayNightConfig, keyframes } };
  }),
  setDayNightConfig: (updates) => set((state) => ({
    dayNightConfig: normalizeDayNightConfig({ ...state.dayNightConfig, ...updates }),
  })),

  // Material settings actions
  setMaterialSettings: (updates) => set((state) => ({
    materialSettings: { ...state.materialSettings, ...updates },
  })),
  resetMaterialSettings: () => set({
    materialSettings: { ...DEFAULT_MATERIAL_SETTINGS },
  }),
  
  // Water settings actions
  setWaterSettings: (updates) => set((state) => ({
    waterSettings: { ...state.waterSettings, ...updates },
  })),
  resetWaterSettings: () => set({
    waterSettings: { ...DEFAULT_WATER_SETTINGS },
  }),
  
  // Debug panel actions
  toggleDebugPanelExpanded: () => set((state) => ({
    debugPanelExpanded: !state.debugPanelExpanded,
  })),
  toggleDebugSection: (section) => set((state) => ({
    debugPanelSections: {
      ...state.debugPanelSections,
      [section]: !state.debugPanelSections[section],
    },
  })),
  
  // Map overlay actions
  toggleMapOverlay: () => set((state) => ({
    showMapOverlay: !state.showMapOverlay,
  })),
  setMapTileCount: (count) => set({ mapTileCount: count }),
}));

// Store the instance on window for HMR persistence
window[storeKey] = useGameStore;
