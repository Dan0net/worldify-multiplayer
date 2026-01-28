/**
 * Bridge between game core and Zustand store
 * Updates store at controlled rate (5-10 Hz) to avoid React re-render spam
 */

import { useGameStore, ConnectionStatus, VoxelStats } from './store';
import { BuildPieceType } from '@worldify/shared';

class StoreBridge {
  private lastUpdateTime = 0;
  private readonly updateIntervalMs = 100; // 10 Hz

  updateConnectionStatus(status: ConnectionStatus): void {
    useGameStore.getState().setConnectionStatus(status);
  }

  updateRoomInfo(roomId: string, playerId: number): void {
    useGameStore.getState().setRoomInfo(roomId, playerId);
  }

  updatePlayerCount(count: number): void {
    useGameStore.getState().setPlayerCount(count);
  }

  updatePing(ping: number): void {
    useGameStore.getState().setPing(ping);
  }

  updateSelectedTool(tool: BuildPieceType): void {
    useGameStore.getState().setSelectedTool(tool);
  }

  updateIsSpectating(spectating: boolean): void {
    useGameStore.getState().setIsSpectating(spectating);
  }

  updateLastBuildSeq(seq: number): void {
    useGameStore.getState().setLastBuildSeqSeen(seq);
  }

  updateServerTick(tick: number): void {
    useGameStore.getState().setServerTick(tick);
  }

  /**
   * Rate-limited debug stats update
   */
  updateDebugStats(fps: number, tickMs: number): void {
    const now = performance.now();
    if (now - this.lastUpdateTime >= this.updateIntervalMs) {
      useGameStore.getState().setDebugStats(fps, tickMs);
      this.lastUpdateTime = now;
    }
  }

  /**
   * Update voxel world statistics
   */
  updateVoxelStats(stats: Partial<VoxelStats>): void {
    useGameStore.getState().setVoxelStats(stats);
  }
}

export const storeBridge = new StoreBridge();
