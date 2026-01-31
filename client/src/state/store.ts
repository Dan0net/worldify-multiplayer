import { create } from 'zustand';
import { BUILD_ROTATION_STEPS, GameMode } from '@worldify/shared';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

/** Texture loading state */
export type TextureLoadingState = 'none' | 'loading-low' | 'low' | 'loading-high' | 'high';

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
  
  // Build actions
  setBuildPreset: (presetId: number) => void;
  setBuildRotation: (rotationSteps: number) => void;
  setBuildHasValidTarget: (valid: boolean) => void;
  
  // Material/texture actions
  setTextureState: (state: TextureLoadingState) => void;
  setTextureProgress: (progress: number) => void;
}

export const useGameStore = create<GameState>((set) => ({
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
}));
