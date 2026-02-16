import { describe, it, expect, beforeEach } from 'vitest';
import { useGameStore, type ConnectionStatus } from './store.js';

describe('Zustand store', () => {
  beforeEach(() => {
    // Reset store to initial state
    useGameStore.setState({
      connectionStatus: 'disconnected',
      roomId: null,
      playerId: null,
      playerCount: 0,
      ping: 0,
      gameMode: 'explore',
      spawnReady: false,
      useServerChunks: false,
      fps: 0,
      tickMs: 0,
      serverTick: 0,
      build: {
        presetId: 1,
        rotationSteps: 0,
        hasValidTarget: false,
      },
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
    });
  });

  describe('Connection state', () => {
    it('updates connection status', () => {
      const { setConnectionStatus } = useGameStore.getState();
      
      setConnectionStatus('connecting');
      expect(useGameStore.getState().connectionStatus).toBe('connecting');
      
      setConnectionStatus('connected');
      expect(useGameStore.getState().connectionStatus).toBe('connected');
    });

    it('sets room info', () => {
      const { setRoomInfo } = useGameStore.getState();
      
      setRoomInfo('room-abc', 42);
      
      const state = useGameStore.getState();
      expect(state.roomId).toBe('room-abc');
      expect(state.playerId).toBe(42);
    });

    it('tracks player count and ping', () => {
      const { setPlayerCount, setPing } = useGameStore.getState();
      
      setPlayerCount(16);
      setPing(50);
      
      const state = useGameStore.getState();
      expect(state.playerCount).toBe(16);
      expect(state.ping).toBe(50);
    });
  });

  describe('Game state', () => {
    it('sets game mode', () => {
      const { setGameMode } = useGameStore.getState();
      
      setGameMode('build');
      expect(useGameStore.getState().gameMode).toBe('build');
    });

    it('sets spawn ready', () => {
      const { setSpawnReady } = useGameStore.getState();
      
      setSpawnReady(true);
      expect(useGameStore.getState().spawnReady).toBe(true);
    });

    it('sets debug stats', () => {
      const { setDebugStats } = useGameStore.getState();
      
      setDebugStats(60, 16.67);
      
      const state = useGameStore.getState();
      expect(state.fps).toBe(60);
      expect(state.tickMs).toBe(16.67);
    });
  });

  describe('Voxel debug toggles', () => {
    it('toggles individual debug flags', () => {
      const { toggleVoxelDebug } = useGameStore.getState();
      
      expect(useGameStore.getState().voxelDebug.showChunkBounds).toBe(false);
      
      toggleVoxelDebug('showChunkBounds');
      expect(useGameStore.getState().voxelDebug.showChunkBounds).toBe(true);
      
      toggleVoxelDebug('showChunkBounds');
      expect(useGameStore.getState().voxelDebug.showChunkBounds).toBe(false);
    });

    it('sets multiple debug flags at once', () => {
      const { setVoxelDebug } = useGameStore.getState();
      
      setVoxelDebug({
        showChunkBounds: true,
        showWireframe: true,
      });
      
      const debug = useGameStore.getState().voxelDebug;
      expect(debug.showChunkBounds).toBe(true);
      expect(debug.showWireframe).toBe(true);
      expect(debug.showCollisionMesh).toBe(false); // unchanged
    });

    it('updates voxel stats', () => {
      const { setVoxelStats } = useGameStore.getState();
      
      setVoxelStats({ chunksLoaded: 64, meshesVisible: 32 });
      
      const stats = useGameStore.getState().voxelStats;
      expect(stats.chunksLoaded).toBe(64);
      expect(stats.meshesVisible).toBe(32);
      expect(stats.debugObjects).toBe(0); // unchanged
    });
  });

  describe('Build state', () => {
    it('sets build preset', () => {
      const { setBuildPreset } = useGameStore.getState();
      
      setBuildPreset(5);
      expect(useGameStore.getState().build.presetId).toBe(5);
    });

    it('sets rotation with wrapping', () => {
      const { setBuildRotation } = useGameStore.getState();
      
      setBuildRotation(3);
      expect(useGameStore.getState().build.rotationSteps).toBe(3);
      
      // BUILD_ROTATION_STEPS = 16, so mask is 15 (0b1111)
      setBuildRotation(17);
      expect(useGameStore.getState().build.rotationSteps).toBe(1); // 17 & 15 = 1
    });

    it('sets valid target flag', () => {
      const { setBuildHasValidTarget } = useGameStore.getState();
      
      setBuildHasValidTarget(true);
      expect(useGameStore.getState().build.hasValidTarget).toBe(true);
    });
  });
});
