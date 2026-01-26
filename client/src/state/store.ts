import { create } from 'zustand';
import { BuildPieceType } from '@worldify/shared';

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected';

interface GameState {
  // Connection
  connectionStatus: ConnectionStatus;
  roomId: string | null;
  playerId: number | null;
  playerCount: number;
  ping: number;

  // Game mode
  isSpectating: boolean;

  // Build system
  selectedTool: BuildPieceType;
  lastBuildSeqSeen: number;

  // Debug
  fps: number;
  tickMs: number;
  serverTick: number;

  // Actions
  setConnectionStatus: (status: ConnectionStatus) => void;
  setRoomInfo: (roomId: string, playerId: number) => void;
  setPlayerCount: (count: number) => void;
  setPing: (ping: number) => void;
  setIsSpectating: (spectating: boolean) => void;
  setSelectedTool: (tool: BuildPieceType) => void;
  setLastBuildSeqSeen: (seq: number) => void;
  setDebugStats: (fps: number, tickMs: number) => void;
  setServerTick: (tick: number) => void;
}

export const useGameStore = create<GameState>((set) => ({
  // Initial state
  connectionStatus: 'disconnected',
  roomId: null,
  playerId: null,
  playerCount: 0,
  ping: 0,
  isSpectating: true, // Start in spectator mode
  selectedTool: BuildPieceType.FLOOR,
  lastBuildSeqSeen: 0,
  fps: 0,
  tickMs: 0,
  serverTick: 0,

  // Actions
  setConnectionStatus: (status) => set({ connectionStatus: status }),
  setRoomInfo: (roomId, playerId) => set({ roomId, playerId }),
  setPlayerCount: (count) => set({ playerCount: count }),
  setPing: (ping) => set({ ping }),
  setIsSpectating: (spectating) => set({ isSpectating: spectating }),
  setSelectedTool: (tool) => set({ selectedTool: tool }),
  setLastBuildSeqSeen: (seq) => set({ lastBuildSeqSeen: seq }),
  setDebugStats: (fps, tickMs) => set({ fps, tickMs }),
  setServerTick: (tick) => set({ serverTick: tick }),
}));
