import { create, type StoreApi, type UseBoundStore } from 'zustand';
import { BUILD_ROTATION_STEPS, GameMode } from '@worldify/shared';
import {
  MATERIAL_ROUGHNESS_MULTIPLIER,
  MATERIAL_METALNESS_MULTIPLIER,
  MATERIAL_AO_INTENSITY,
  MATERIAL_NORMAL_STRENGTH,
  ENVIRONMENT_INTENSITY,
  DEFAULT_SKYBOX,
} from '@worldify/shared';
import * as THREE from 'three';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/** Texture loading state */
export type TextureLoadingState = 'none' | 'loading-low' | 'low' | 'loading-high' | 'high';

/** Terrain shader debug modes */
export const TERRAIN_DEBUG_MODE_NAMES = ['Off', 'Albedo', 'Normal', 'AO', 'Roughness', 'TriBlend', 'MatIDs', 'MatWeights', 'WorldNormal', 'Metalness', 'MetalFinal'] as const;
export type TerrainDebugMode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

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

/** Build tool state */
export interface BuildState {
  /** Currently selected preset ID (0-9, 0 = disabled) */
  presetId: number;
  /** Current rotation in steps (0 to BUILD_ROTATION_STEPS-1) */
  rotationSteps: number;
  /** Whether a valid build target is found */
  hasValidTarget: boolean;
}

/** Environment/lighting settings */
export interface EnvironmentSettings {
  // Time of day
  timeOfDay: number;        // 0-1 normalized time
  timeSpeed: number;        // Multiplier for real-time progression (0 = paused)
  
  // Sun settings
  sunColor: string;         // Hex color
  sunIntensity: number;     // 0-10
  sunDistance: number;      // Distance from player for shadow positioning
  
  // Moon settings  
  moonColor: string;        // Hex color
  moonIntensity: number;    // 0-10
  
  // Ambient light
  ambientColor: string;     // Hex color
  ambientIntensity: number; // 0-2
  
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
  bloomRadius: number;          // 0-1
  
  // Color correction
  saturation: number;           // 0-2, 1.0 = no change
}

/** Material shader settings for debug/tweaking */
export interface MaterialSettings {
  // Texture multipliers (applied in shader)
  roughnessMultiplier: number;    // 0-2, multiplied with texture value
  metalnessMultiplier: number;    // 0-2, multiplied with texture value
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

/** Default material settings - uses shared constants for consistency with pallet viewer */
export const DEFAULT_MATERIAL_SETTINGS: MaterialSettings = {
  roughnessMultiplier: MATERIAL_ROUGHNESS_MULTIPLIER,
  metalnessMultiplier: MATERIAL_METALNESS_MULTIPLIER,
  aoIntensity: MATERIAL_AO_INTENSITY,
  normalStrength: MATERIAL_NORMAL_STRENGTH,
  blendSharpness: 8.0,
  repeatScale: 2.0,
  windStrength: 0.1,
  windSpeed: 0.7,
  windFrequency: 1.0,
};

/** Default environment settings - uses shared constants for consistency with pallet viewer */
export const DEFAULT_ENVIRONMENT: EnvironmentSettings = {
  timeOfDay: 0.35,          // ~8:30am - nice morning light
  timeSpeed: 0,             // Paused by default
  
  sunColor: '#ffcc00',
  sunIntensity: 3.0,
  sunDistance: 150,
  
  moonColor: '#8899bb',
  moonIntensity: 0.3,
  
  ambientColor: '#ffffff',
  ambientIntensity: 0.4,    // Matches pallet viewer
  
  skybox: DEFAULT_SKYBOX,
  environmentIntensity: ENVIRONMENT_INTENSITY,
  
  shadowBias: -0.0001,
  shadowNormalBias: 0.02,
  shadowMapSize: 4096,
  
  toneMapping: THREE.ACESFilmicToneMapping,
  toneMappingExposure: 1.0,
  
  ssaoKernelRadius: 12,
  ssaoMinDistance: 0.002,
  bloomIntensity: 0.3,
  bloomThreshold: 0.85,
  bloomRadius: 0.4,
  saturation: 1.2,  // Slightly boosted for more vivid colors
};

/** Debug panel section collapse state */
export interface DebugPanelSections {
  stats: boolean;
  debug: boolean;
  materials: boolean;
  environment: boolean;
}

interface GameState {
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

  // Voxel debug
  voxelDebug: VoxelDebugToggles;
  voxelStats: VoxelStats;
  
  // Terrain shader debug
  terrainDebugMode: TerrainDebugMode;
  
  // Post-processing (SSAO + bloom)
  postProcessingEnabled: boolean;

  // Dev mode - force regenerate chunks on server
  forceRegenerateChunks: boolean;

  // Environment settings
  environment: EnvironmentSettings;
  
  // Material shader settings
  materialSettings: MaterialSettings;
  
  // Debug panel section collapse state
  debugPanelSections: DebugPanelSections;

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
  
  // Voxel debug actions
  toggleVoxelDebug: (key: keyof VoxelDebugToggles) => void;
  setVoxelDebug: (updates: Partial<VoxelDebugToggles>) => void;
  setVoxelStats: (stats: Partial<VoxelStats>) => void;
  
  // Terrain debug actions
  setTerrainDebugMode: (mode: TerrainDebugMode) => void;
  cycleTerrainDebugMode: () => void;
  
  // Post-processing actions
  togglePostProcessing: () => void;
  setPostProcessingEnabled: (enabled: boolean) => void;
  
  // Build actions
  setBuildPreset: (presetId: number) => void;
  setBuildRotation: (rotationSteps: number) => void;
  setBuildHasValidTarget: (valid: boolean) => void;
  
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
  
  // Debug panel actions
  toggleDebugSection: (section: keyof DebugPanelSections) => void;
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
  
  // Build initial state
  build: {
    presetId: 0,        // Disabled by default
    rotationSteps: 0,   // No rotation
    hasValidTarget: false,
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
  
  // Post-processing initial state
  postProcessingEnabled: true,

  // Dev mode initial state
  forceRegenerateChunks: false,

  // Environment initial state
  environment: { ...DEFAULT_ENVIRONMENT },
  
  // Material settings initial state
  materialSettings: { ...DEFAULT_MATERIAL_SETTINGS },
  
  // Debug panel sections (all expanded by default)
  debugPanelSections: {
    stats: true,
    debug: false,
    materials: false,
    environment: false,
  },

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
    terrainDebugMode: ((state.terrainDebugMode + 1) % 11) as TerrainDebugMode,
  })),
  
  // Post-processing actions
  togglePostProcessing: () => set((state) => ({
    postProcessingEnabled: !state.postProcessingEnabled,
  })),
  setPostProcessingEnabled: (enabled) => set({ postProcessingEnabled: enabled }),
  
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
    environment: { ...state.environment, timeOfDay: Math.max(0, Math.min(1, time)) },
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
  
  // Debug panel actions
  toggleDebugSection: (section) => set((state) => ({
    debugPanelSections: {
      ...state.debugPanelSections,
      [section]: !state.debugPanelSections[section],
    },
  })),
}));

// Store the instance on window for HMR persistence
window[storeKey] = useGameStore;
