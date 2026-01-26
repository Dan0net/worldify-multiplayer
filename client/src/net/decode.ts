/**
 * Binary message decoding (server -> client)
 */

import {
  MSG_WELCOME,
  MSG_ROOM_INFO,
  MSG_SNAPSHOT,
  MSG_BUILD_COMMIT,
  MSG_BUILD_SYNC,
  MSG_ERROR,
  MSG_PONG,
  ByteReader,
  decodeSnapshot,
  decodeBuildCommit,
  decodeBuildSync,
  RoomSnapshot,
  BuildCommit,
} from '@worldify/shared';
import { storeBridge } from '../state/bridge';

// Callback for snapshot updates (set by game core)
let onSnapshotCallback: ((snapshot: RoomSnapshot) => void) | null = null;

// Callback for build commits (set by game core)
let onBuildCommitCallback: ((commit: BuildCommit) => void) | null = null;

/**
 * Register callback for snapshot updates
 */
export function onSnapshot(callback: (snapshot: RoomSnapshot) => void): void {
  onSnapshotCallback = callback;
}

/**
 * Register callback for build commit updates
 */
export function onBuildCommit(callback: (commit: BuildCommit) => void): void {
  onBuildCommitCallback = callback;
}

export function decodeMessage(data: Uint8Array): void {
  if (data.length === 0) return;

  const reader = new ByteReader(data);
  const msgId = reader.readUint8();

  switch (msgId) {
    case MSG_WELCOME:
      handleWelcome(reader);
      break;
    case MSG_ROOM_INFO:
      handleRoomInfo(reader);
      break;
    case MSG_SNAPSHOT:
      handleSnapshot(reader);
      break;
    case MSG_BUILD_COMMIT:
      handleBuildCommit(reader);
      break;
    case MSG_BUILD_SYNC:
      handleBuildSync(reader);
      break;
    case MSG_ERROR:
      handleError(reader);
      break;
    case MSG_PONG:
      handlePong(reader);
      break;
    default:
      console.warn('Unknown message ID:', msgId);
  }
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

function handleBuildCommit(reader: ByteReader): void {
  const commit = decodeBuildCommit(reader);
  
  storeBridge.updateLastBuildSeq(commit.buildSeq);
  
  if (onBuildCommitCallback) {
    onBuildCommitCallback(commit);
  }
}

function handleBuildSync(reader: ByteReader): void {
  const commits = decodeBuildSync(reader);
  
  // Apply all commits in order
  for (const commit of commits) {
    storeBridge.updateLastBuildSeq(commit.buildSeq);
    
    if (onBuildCommitCallback) {
      onBuildCommitCallback(commit);
    }
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
