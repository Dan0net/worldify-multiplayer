/**
 * Bridge between game core and Zustand store
 * 
 * ALL non-React code must use this bridge for store access.
 * React components should use the useGameStore hook directly.
 * 
 * This centralizes store access, enabling:
 * - Rate limiting for high-frequency updates
 * - Single point of control for state access patterns
 * - Clean separation between React and imperative game code
 */

import { useGameStore, ConnectionStatus, VoxelStats, VoxelDebugToggles } from './store';
import { BuildPieceType } from '@worldify/shared';

class StoreBridge {
  private lastUpdateTime = 0;
  private readonly updateIntervalMs = 100; // 10 Hz

  // ============== READS (game code reads state here) ==============

  get isSpectating(): boolean {
    return useGameStore.getState().isSpectating;
  }

  get selectedTool(): BuildPieceType {
    return useGameStore.getState().selectedTool;
  }

  get voxelDebug(): VoxelDebugToggles {
    return useGameStore.getState().voxelDebug;
  }

  get playerId(): number | null {
    return useGameStore.getState().playerId;
  }

  // ============== WRITES ==============

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
