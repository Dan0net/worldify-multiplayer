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
  MSG_VOXEL_CHUNK_DATA,
  ByteReader,
  decodeSnapshot,
  decodeVoxelBuildCommit,
  decodeVoxelChunkData,
  RoomSnapshot,
  VoxelBuildCommit,
  VoxelChunkData,
  BuildResult,
  buildResultToString,
} from '@worldify/shared';
import { storeBridge } from '../state/bridge';
import { registerHandler, dispatch } from './MessageRegistry';

// ============== Typed Event System ==============

/** Event types and their payloads */
interface GameEvents {
  snapshot: RoomSnapshot;
  buildCommit: VoxelBuildCommit;
  chunkData: VoxelChunkData;
}

type EventCallback<T> = (data: T) => void;

/** Single registry for all game event callbacks */
const eventCallbacks: { [K in keyof GameEvents]?: EventCallback<GameEvents[K]> } = {};

/**
 * Register a callback for a game event.
 * Only one callback per event type (last one wins).
 */
export function on<K extends keyof GameEvents>(
  event: K,
  callback: EventCallback<GameEvents[K]>
): void {
  eventCallbacks[event] = callback as EventCallback<GameEvents[keyof GameEvents]>;
}

/** Emit an event to its registered callback */
function emit<K extends keyof GameEvents>(event: K, data: GameEvents[K]): void {
  const callback = eventCallbacks[event];
  if (callback) {
    (callback as EventCallback<GameEvents[K]>)(data);
  }
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
  emit('snapshot', snapshot);
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
    emit('buildCommit', commit);
  } else {
    console.warn(`[net] Build rejected: ${buildResultToString(commit.result)}`);
  }
}

function handleChunkData(reader: ByteReader): void {
  const chunkData = decodeVoxelChunkData(reader);
  emit('chunkData', chunkData);
}

// Register all message handlers
registerHandler(MSG_WELCOME, handleWelcome);
registerHandler(MSG_ROOM_INFO, handleRoomInfo);
registerHandler(MSG_SNAPSHOT, handleSnapshot);
registerHandler(MSG_ERROR, handleError);
registerHandler(MSG_PONG, handlePong);
registerHandler(MSG_VOXEL_BUILD_COMMIT, handleBuildCommit);
registerHandler(MSG_VOXEL_CHUNK_DATA, handleChunkData);
