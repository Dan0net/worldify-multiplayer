/**
 * PlayerManager - Local and remote player lifecycle management
 * 
 * Extracted from GameCore to handle:
 * - Local player creation and control
 * - Remote player creation/destruction from snapshots
 * - Input gathering and sending
 * - Server state reconciliation
 */

import * as THREE from 'three';
import { PlayerLocal, RespawnCallback } from './player/playerLocal';
import { PlayerRemote } from './player/playerRemote';
import { Controls, controls } from './player/controls';
import { sendBinary } from '../net/netClient';
import { CLIENT_INPUT_HZ, RoomSnapshot, encodeInput, SPAWN_FALLBACK_HEIGHT } from '@worldify/shared';
import { storeBridge } from '../state/bridge';
import type { VoxelIntegration } from './voxel/VoxelIntegration';

/** Callback type for finding respawn positions (decouples from VoxelIntegration) */
export type RespawnFinder = (currentPos: THREE.Vector3, lastGroundedPos: THREE.Vector3 | null) => THREE.Vector3 | null;

export class PlayerManager {
  private localPlayer: PlayerLocal;
  private remotePlayers = new Map<number, PlayerRemote>();
  private localPlayerId: number | null = null;
  
  // Respawn position finder (injected by GameCore)
  private respawnFinder: RespawnFinder | null = null;

  // Input sending interval
  private inputInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.localPlayer = new PlayerLocal();
  }

  /**
   * Get the local player instance
   */
  getLocalPlayer(): PlayerLocal {
    return this.localPlayer;
  }

  /**
   * Set the local player ID (assigned by server)
   */
  setLocalPlayerId(playerId: number): void {
    this.localPlayerId = playerId;
  }

  /**
   * Get the local player ID
   */
  getLocalPlayerId(): number | null {
    return this.localPlayerId;
  }

  /**
   * Connect the local player to voxel collision system.
   * Only used for collision - respawn uses the callback pattern.
   */
  setVoxelIntegration(voxel: VoxelIntegration): void {
    this.localPlayer.setVoxelIntegration(voxel);
    
    // Set up respawn callback (uses respawnFinder if set)
    this.localPlayer.setRespawnCallback(this.handleRespawnNeeded);
  }

  /**
   * Set the respawn finder callback (injected by GameCore).
   * Decouples PlayerManager from VoxelIntegration for respawn logic.
   */
  setRespawnFinder(finder: RespawnFinder): void {
    this.respawnFinder = finder;
  }

  /**
   * Handle respawn request from local player (fell too long)
   */
  private handleRespawnNeeded: RespawnCallback = (currentPos, lastGroundedPos) => {
    if (!this.respawnFinder) {
      console.warn('[PlayerManager] No respawn finder set, using fallback position');
      this.localPlayer.respawn(new THREE.Vector3(0, SPAWN_FALLBACK_HEIGHT, 0));
      return;
    }
    
    const respawnPos = this.respawnFinder(currentPos, lastGroundedPos);
    if (respawnPos) {
      this.localPlayer.respawn(respawnPos);
    } else {
      // Terrain not ready yet - just reset position high and wait
      // The fall detection will trigger again later when terrain loads
      this.localPlayer.respawn(new THREE.Vector3(0, SPAWN_FALLBACK_HEIGHT, 0));
    }
  };

  /**
   * Set spawn position for local player
   */
  setSpawnPosition(position: THREE.Vector3): void {
    this.localPlayer.position.copy(position);
  }

  /**
   * Start the input sending loop
   */
  startInputLoop(): void {
    if (this.inputInterval !== null) return;

    const intervalMs = 1000 / CLIENT_INPUT_HZ;
    this.inputInterval = setInterval(() => {
      this.sendInput();
    }, intervalMs);
  }

  /**
   * Stop the input sending loop
   */
  stopInputLoop(): void {
    if (this.inputInterval !== null) {
      clearInterval(this.inputInterval);
      this.inputInterval = null;
    }
  }

  /**
   * Send current input to server
   */
  private sendInput(): void {
    const input = this.localPlayer.getInput(controls);
    sendBinary(encodeInput(input));
  }

  /**
   * Update local player physics
   */
  updateLocalPlayer(deltaMs: number): void {
    this.localPlayer.update(deltaMs, controls);
  }

  /**
   * Update all remote players (interpolation)
   */
  updateRemotePlayers(deltaMs: number): void {
    for (const remote of this.remotePlayers.values()) {
      remote.update(deltaMs);
    }
  }

  /**
   * Get the controls instance
   */
  getControls(): Controls {
    return controls;
  }

  /**
   * Handle incoming snapshot from server
   * Updates local player server state and manages remote player lifecycle
   */
  handleSnapshot(snapshot: RoomSnapshot, scene: THREE.Scene): void {
    // Update player count in store
    storeBridge.updatePlayerCount(snapshot.players.length);

    // Track which players we've seen
    const seenPlayerIds = new Set<number>();

    for (const playerData of snapshot.players) {
      seenPlayerIds.add(playerData.playerId);

      // Skip local player (we control them locally)
      if (playerData.playerId === this.localPlayerId) {
        // Update local player position from server (for now, no prediction)
        this.localPlayer.applyServerState(playerData);
        continue;
      }

      // Get or create remote player
      let remote = this.remotePlayers.get(playerData.playerId);
      if (!remote) {
        remote = new PlayerRemote(playerData.playerId);
        this.remotePlayers.set(playerData.playerId, remote);
        scene.add(remote.mesh);
      }

      remote.applySnapshot(playerData);
    }

    // Remove disconnected players
    for (const [playerId, remote] of this.remotePlayers) {
      if (!seenPlayerIds.has(playerId)) {
        scene.remove(remote.mesh);
        remote.dispose();
        this.remotePlayers.delete(playerId);
      }
    }
  }

  /**
   * Dispose all players and clean up
   */
  dispose(): void {
    this.stopInputLoop();

    // Clean up remote players
    for (const remote of this.remotePlayers.values()) {
      remote.dispose();
    }
    this.remotePlayers.clear();
  }
}
