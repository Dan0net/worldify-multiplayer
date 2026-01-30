/**
 * Binary message decoding (server -> client)
 * Uses MessageRegistry pattern for extensible message handling.
 */

import {
  MSG_WELCOME,
  MSG_ROOM_INFO,
  MSG_SNAPSHOT,
  MSG_ERROR,
  MSG_PONG,
  MSG_VOXEL_BUILD_COMMIT,
  ByteReader,
  decodeSnapshot,
  decodeVoxelBuildCommit,
  RoomSnapshot,
  VoxelBuildCommit,
  BuildResult,
  buildResultToString,
} from '@worldify/shared';
import { storeBridge } from '../state/bridge';
import { registerHandler, dispatch } from './MessageRegistry';

// Callback for snapshot updates (set by game core)
let onSnapshotCallback: ((snapshot: RoomSnapshot) => void) | null = null;

// Callback for build commit updates (set by game core)
let onBuildCommitCallback: ((commit: VoxelBuildCommit) => void) | null = null;

/**
 * Register callback for snapshot updates
 */
export function onSnapshot(callback: (snapshot: RoomSnapshot) => void): void {
  onSnapshotCallback = callback;
}

/**
 * Register callback for build commit updates
 */
export function onBuildCommit(callback: (commit: VoxelBuildCommit) => void): void {
  onBuildCommitCallback = callback;
}

/**
 * Decode and dispatch an incoming binary message.
 * Delegates to registered handlers via MessageRegistry.
 */
export function decodeMessage(data: Uint8Array): void {
  dispatch(data);
}

function handleWelcome(reader: ByteReader): void {
  const playerId = reader.readUint16();
  // Read 8-byte room ID
  const roomBytes: number[] = [];
  for (let i = 0; i < 8; i++) {
    const byte = reader.readUint8();
    if (byte !== 0) roomBytes.push(byte);
  }
  const roomId = String.fromCharCode(...roomBytes);
  
  console.log(`[net] Welcome! Player ID: ${playerId}, Room: ${roomId}`);
  storeBridge.updateRoomInfo(roomId, playerId);
}

function handleRoomInfo(reader: ByteReader): void {
  const playerCount = reader.readUint8();
  storeBridge.updatePlayerCount(playerCount);
}

function handleSnapshot(reader: ByteReader): void {
  const snapshot = decodeSnapshot(reader);
  
  // Update tick in store for debug display
  storeBridge.updateServerTick(snapshot.tick);
  
  // Notify game core of new snapshot
  if (onSnapshotCallback) {
    onSnapshotCallback(snapshot);
  }
}

function handleError(reader: ByteReader): void {
  const errorCode = reader.readUint8();
  console.error('Server error:', errorCode);
}

function handlePong(reader: ByteReader): void {
  const timestamp = reader.readUint32();
  const ping = Date.now() - timestamp;
  storeBridge.updatePing(ping);
}

function handleBuildCommit(reader: ByteReader): void {
  const commit = decodeVoxelBuildCommit(reader);
  
  if (commit.result === BuildResult.SUCCESS) {
    console.log(`[net] Build commit seq=${commit.buildSeq} from player ${commit.playerId}`);
    
    // Notify game core to apply the build
    if (onBuildCommitCallback) {
      onBuildCommitCallback(commit);
    }
  } else {
    console.warn(`[net] Build rejected: ${buildResultToString(commit.result)}`);
  }
}

// Register all message handlers
registerHandler(MSG_WELCOME, handleWelcome);
registerHandler(MSG_ROOM_INFO, handleRoomInfo);
registerHandler(MSG_SNAPSHOT, handleSnapshot);
registerHandler(MSG_ERROR, handleError);
registerHandler(MSG_PONG, handlePong);
registerHandler(MSG_VOXEL_BUILD_COMMIT, handleBuildCommit);
