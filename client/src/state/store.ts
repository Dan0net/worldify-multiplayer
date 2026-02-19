import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { BUILD_ROTATION_STEPS, GameMode, clamp, NONE_PRESET_ID, DEFAULT_BUILD_PRESETS, presetToSlotMeta, templateToSlotMeta, PRESET_TEMPLATES, type BuildConfig, type PresetSlotMeta } from '@worldify/shared';
import type { QualityLevel } from '../game/quality/QualityPresets';
import {
  MATERIAL_ROUGHNESS_MULTIPLIER,
  MATERIAL_METALNESS_OFFSET,
  MATERIAL_AO_INTENSITY,
  MATERIAL_NORMAL_STRENGTH,
  ENVIRONMENT_INTENSITY,
  DEFAULT_SKYBOX,
  LIGHT_SUN_COLOR,
  LIGHT_SUN_INTENSITY,
  LIGHT_MOON_COLOR,
  LIGHT_MOON_INTENSITY,
  SUN_DISTANCE,
  DEFAULT_TIME_OF_DAY,
  DEFAULT_TIME_SPEED,
  HEMISPHERE_SKY_DAY,
  HEMISPHERE_GROUND_DAY,
  HEMISPHERE_INTENSITY_DAY,
} from '@worldify/shared';
import * as THREE from 'three';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/** Texture loading state */
export type TextureLoadingState = 'none' | 'loading-low' | 'low' | 'loading-high' | 'high';

/** Terrain shader debug modes */
export const TERRAIN_DEBUG_MODE_NAMES = ['Off', 'VoxelLight', 'Albedo', 'Normal', 'AO', 'Roughness', 'Metalness', 'TriBlend', 'MatIDs', 'MatWeights', 'WorldNormal', 'MatHue'] as const;
export type TerrainDebugMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

/** Voxel debug visualization toggles */
export interface VoxelDebugToggles {
  showChunkBounds: boolean;
  showEmptyChunks: boolean;
  showCollisionMesh: boolean;
  showChunkCoords: boolean;
  showWireframe: boolean;
}

/** Voxel world statistics */
export interface VoxelStats {
  chunksLoaded: number;
  meshesVisible: number;
  debugObjects: number;
}

/** Performance timing snapshot (updated from game loop) */
export interface PerfSnapshot {
  // Per-subsystem times in ms (rolling averages)
  gameUpdate: number;
  physics: number;
  voxelUpdate: number;
  remesh: number;
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
  // Memory
  jsHeapMB: number;
}

/** Build tool state */
export interface BuildState {
  /** Currently selected preset ID (0-9, 0 = disabled) */
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
  /** Mutable preset configs (user can change material/shape) */
  presetConfigs: BuildConfig[];
  /** Per-slot metadata (align, snapShape, baseRotation, autoRotateY, templateName) */
  presetMeta: PresetSlotMeta[];
}

/** Environment/lighting settings */
export interface EnvironmentSettings {
  // Day-Night Cycle
  dayNightEnabled: boolean;       // Master toggle for automatic calculations
  timeOfDay: number;              // 0-1 normalized time
  timeSpeed: number;              // Game-minutes per real-second (0 = paused)
  
  // Auto-calculation overrides (when false, use manual values below)
  autoSunPosition: boolean;       // Calculate sun position from time
  autoSunColor: boolean;          // Calculate sun color from time
  autoSunIntensity: boolean;      // Calculate sun intensity from time
  autoMoonPosition: boolean;      // Calculate moon position from time
  autoMoonIntensity: boolean;     // Calculate moon intensity from time
  autoEnvironmentIntensity: boolean; // Calculate IBL intensity from time
  
  // Sun settings (manual values, or calculated when auto is enabled)
  sunColor: string;         // Hex color
  sunIntensity: number;     // 0-10
  sunDistance: number;      // Distance from origin for light positioning
  sunAzimuth: number;       // Horizontal angle in degrees (0-360)
  sunElevation: number;     // Vertical angle in degrees (-90 to 90)
  
  // Moon settings
  moonColor: string;        // Hex color
  moonIntensity: number;    // 0-2
  moonAzimuth: number;      // Horizontal angle in degrees
  moonElevation: number;    // Vertical angle in degrees
  
  // Hemisphere light (sky/ground gradient)
  hemisphereEnabled: boolean;     // Toggle hemisphere light
  autoHemisphereColors: boolean;  // Calculate colors from time
  autoHemisphereIntensity: boolean; // Calculate intensity from time
  hemisphereSkyColor: string;     // Hex color (from above)
  hemisphereGroundColor: string;  // Hex color (from below)
  hemisphereIntensity: number;    // 0-2
  
  // Sunset/sunrise colors for sky shader
  sunsetHorizonColor: string;     // Warm orange-red at horizon
  sunsetZenithColor: string;      // Cool purple at zenith
  
  // Environment (IBL)
  skybox: string;                 // Skybox image filename
  environmentIntensity: number; // 0-2
  
  // Shadow settings
  shadowBias: number;       // -0.01 to 0.01
  shadowNormalBias: number; // 0 to 0.1
  shadowMapSize: number;    // 512, 1024, 2048, 4096
  
  // Tone mapping
  toneMapping: THREE.ToneMapping;
  toneMappingExposure: number; // 0.1 to 3
  
  // Post-processing effects
  ssaoKernelRadius: number;     // 0-32
  ssaoMinDistance: number;      // 0.001-0.02
  bloomIntensity: number;       // 0-3
  bloomThreshold: number;       // 0-1
  bloomRadius: number;          // 0-3
  
  // Color correction
  saturation: number;           // 0-2, 1.0 = no change
  
  // Voxel light fill
  lightFillPower: number;       // 0.5-5, exponent for fill light curve
  lightFillIntensity: number;   // 0-1, strength of additive fill light
}

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
  
  // All auto-calculations enabled (when dayNightEnabled is true)
  autoSunPosition: true,
  autoSunColor: true,
  autoSunIntensity: true,
  autoMoonPosition: true,
  autoMoonIntensity: true,
  autoEnvironmentIntensity: true,
  
  sunColor: LIGHT_SUN_COLOR,
  sunIntensity: LIGHT_SUN_INTENSITY,
  sunDistance: SUN_DISTANCE,
  sunAzimuth: 135,          // Southeast (morning sun)
  sunElevation: 45,         // 45 degrees up
  
  moonColor: LIGHT_MOON_COLOR,
  moonIntensity: LIGHT_MOON_INTENSITY,
  moonAzimuth: 315,         // Opposite sun
  moonElevation: -45,       // Below horizon during day
  
  // Hemisphere light - enabled by default for natural outdoor lighting
  hemisphereEnabled: true,
  autoHemisphereColors: true,
  autoHemisphereIntensity: true,
  hemisphereSkyColor: HEMISPHERE_SKY_DAY,
  hemisphereGroundColor: HEMISPHERE_GROUND_DAY,
  hemisphereIntensity: HEMISPHERE_INTENSITY_DAY,
  
  // Sunset/sunrise colors
  sunsetHorizonColor: '#ff6622',  // Warm orange-red
  sunsetZenithColor: '#4d3380',   // Cool purple
  
  skybox: DEFAULT_SKYBOX,
  environmentIntensity: ENVIRONMENT_INTENSITY,
  
  shadowBias: -0.0001,
  shadowNormalBias: 0.02,
  shadowMapSize: 4096,
  
  toneMapping: THREE.ACESFilmicToneMapping,
  toneMappingExposure: 1.0,
  
  ssaoKernelRadius: 0.5,
  ssaoMinDistance: 0.002,
  bloomIntensity: 0.5,
  bloomThreshold: 0.8,
  bloomRadius: 1,
  saturation: 1.2,  // Slightly boosted for more vivid colors
  lightFillPower: 0.5,
  lightFillIntensity: 2.0,
};

/** Debug panel section collapse state */
export interface DebugPanelSections {
  stats: boolean;
  performance: boolean;
  debug: boolean;
  quality: boolean;
  materials: boolean;
  water: boolean;
  dayNightCycle: boolean;
  environment: boolean;
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
  
  // Quality settings (individual controls)
  qualityLevel: QualityLevel;
  visibilityRadius: number;
  fov: number;
  ssaoEnabled: boolean;
  bloomEnabled: boolean;
  colorCorrectionEnabled: boolean;
  shadowsEnabled: boolean;
  moonShadows: boolean;
  shadowRadius: number;
  anisotropy: number;
  maxPixelRatio: number;
  msaaSamples: number;
  shaderNormalMaps: boolean;
  shaderAoMaps: boolean;
  shaderMetalnessMaps: boolean;

  // Dev mode - force regenerate chunks on server
  forceRegenerateChunks: boolean;

  // Environment settings
  environment: EnvironmentSettings;
  
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
  
  // Quality actions
  setQualityLevel: (level: QualityLevel) => void;
  setVisibilityRadius: (radius: number) => void;
  setFov: (fov: number) => void;
  setSsaoEnabled: (enabled: boolean) => void;
  setBloomEnabled: (enabled: boolean) => void;
  setColorCorrectionEnabled: (enabled: boolean) => void;
  setShadowsEnabled: (enabled: boolean) => void;
  setMoonShadows: (enabled: boolean) => void;
  setShadowRadius: (radius: number) => void;
  setAnisotropy: (value: number) => void;
  setMaxPixelRatio: (ratio: number) => void;
  setMsaaSamples: (samples: number) => void;
  setShaderNormalMaps: (enabled: boolean) => void;
  setShaderAoMaps: (enabled: boolean) => void;
  setShaderMetalnessMaps: (enabled: boolean) => void;
  
  // Build actions
  setBuildPreset: (presetId: number) => void;
  setBuildRotation: (rotationSteps: number) => void;
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
  toggleForceRegenerateChunks: () => void;
  
  // Environment actions
  setEnvironment: (updates: Partial<EnvironmentSettings>) => void;
  setTimeOfDay: (time: number) => void;
  setTimeSpeed: (speed: number) => void;
  
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

// Use existing store if available (HMR), otherwise create new one
export const useGameStore: UseBoundStore<StoreApi<GameState>> = window[storeKey] ?? create<GameState>((set) => ({
  // Initial state
  connectionStatus: 'disconnected',
  roomId: null,
  playerId: null,
  playerCount: 0,
  ping: 0,
  gameMode: GameMode.MainMenu, // Start in main menu
  spawnReady: false, // Terrain not found yet
  useServerChunks: true, // Default to server chunks in multiplayer
  textureState: 'none',
  textureProgress: 0,
  fps: 0,
  tickMs: 0,
  serverTick: 0,
  perfStats: {
    gameUpdate: 0, physics: 0, voxelUpdate: 0, remesh: 0,
    buildPreview: 0, players: 0, environment: 0, render: 0,
    drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0,
    remeshQueueSize: 0, pendingChunks: 0, jsHeapMB: 0,
  },
  
  // Build initial state
  build: {
    presetId: NONE_PRESET_ID,  // Disabled by default (key 1 = None)
    rotationSteps: 0,   // No rotation
    hasValidTarget: false,
    invalidReason: null,
    snapPoint: true,    // Point snapping on by default
    snapGrid: false,    // Grid snapping off by default
    menuOpen: false,
    presetConfigs: DEFAULT_BUILD_PRESETS.map(p => ({ ...p.config })),
    presetMeta: DEFAULT_BUILD_PRESETS.map(p => presetToSlotMeta(p)),
  },
  
  // Voxel debug initial state
  voxelDebug: {
    showChunkBounds: false,
    showEmptyChunks: false,
    showCollisionMesh: false,
    showChunkCoords: false,
    showWireframe: false,
  },
  voxelStats: {
    chunksLoaded: 0,
    meshesVisible: 0,
    debugObjects: 0,
  },
  
  // Terrain debug initial state
  terrainDebugMode: 0 as TerrainDebugMode,
  
  // Quality initial state (auto-detect will override on first load)
  qualityLevel: 'ultra' as QualityLevel,
  visibilityRadius: 8,
  fov: 90,
  ssaoEnabled: true,
  bloomEnabled: true,
  colorCorrectionEnabled: true,
  shadowsEnabled: true,
  moonShadows: true,
  shadowRadius: 5,
  anisotropy: 8,
  maxPixelRatio: 2,
  msaaSamples: 4,
  shaderNormalMaps: true,
  shaderAoMaps: true,
  shaderMetalnessMaps: true,

  // Dev mode initial state
  forceRegenerateChunks: false,

  // Environment initial state
  environment: { ...DEFAULT_ENVIRONMENT },
  
  // Material settings initial state
  materialSettings: { ...DEFAULT_MATERIAL_SETTINGS },
  
  // Water settings initial state
  waterSettings: { ...DEFAULT_WATER_SETTINGS },
  
  // Debug panel starts compact (FPS only)
  debugPanelExpanded: false,
  
  // Debug panel sections (all expanded by default)
  debugPanelSections: {
    stats: true,
    performance: false,
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
    terrainDebugMode: ((state.terrainDebugMode + 1) % 12) as TerrainDebugMode,
  })),
  
  // Quality actions
  setQualityLevel: (level) => set({ qualityLevel: level }),
  setVisibilityRadius: (radius) => set({ visibilityRadius: radius }),
  setFov: (fov) => set({ fov }),
  setSsaoEnabled: (enabled) => set({ ssaoEnabled: enabled }),
  setBloomEnabled: (enabled) => set({ bloomEnabled: enabled }),
  setColorCorrectionEnabled: (enabled) => set({ colorCorrectionEnabled: enabled }),
  setShadowsEnabled: (enabled) => set({ shadowsEnabled: enabled }),
  setMoonShadows: (enabled) => set({ moonShadows: enabled }),
  setShadowRadius: (radius) => set({ shadowRadius: radius }),
  setAnisotropy: (value) => set({ anisotropy: value }),
  setMaxPixelRatio: (ratio) => set({ maxPixelRatio: ratio }),
  setMsaaSamples: (samples) => set({ msaaSamples: samples }),
  setShaderNormalMaps: (enabled) => set({ shaderNormalMaps: enabled }),
  setShaderAoMaps: (enabled) => set({ shaderAoMaps: enabled }),
  setShaderMetalnessMaps: (enabled) => set({ shaderMetalnessMaps: enabled }),
  
  // Build actions
  setBuildPreset: (presetId) => set((state) => ({
    build: { ...state.build, presetId },
  })),
  setBuildRotation: (rotationSteps) => set((state) => ({
    build: { ...state.build, rotationSteps: rotationSteps & (BUILD_ROTATION_STEPS - 1) },
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
  setBuildMenuOpen: (open) => set((state) => ({
    build: { ...state.build, menuOpen: open },
  })),
  toggleBuildMenu: () => set((state) => ({
    build: { ...state.build, menuOpen: !state.build.menuOpen },
  })),
  updatePresetConfig: (presetId, updates) => set((state) => {
    const configs = [...state.build.presetConfigs];
    configs[presetId] = { ...configs[presetId], ...updates };
    return { build: { ...state.build, presetConfigs: configs } };
  }),
  updatePresetMeta: (presetId, updates) => set((state) => {
    const metas = [...state.build.presetMeta];
    metas[presetId] = { ...metas[presetId], ...updates };
    return { build: { ...state.build, presetMeta: metas } };
  }),
  applyPresetTemplate: (slotId, templateIndex) => set((state) => {
    const template = PRESET_TEMPLATES[templateIndex];
    if (!template) return state;
    const configs = [...state.build.presetConfigs];
    configs[slotId] = { ...template.config };
    const metas = [...state.build.presetMeta];
    metas[slotId] = templateToSlotMeta(template);
    return { build: { ...state.build, presetConfigs: configs, presetMeta: metas } };
  }),
  
  // Material/texture actions
  setTextureState: (textureState) => set({ textureState }),
  setTextureProgress: (textureProgress) => set({ textureProgress }),
  
  // Dev mode actions
  setForceRegenerateChunks: (forceRegenerateChunks) => set({ forceRegenerateChunks }),
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
