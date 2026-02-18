/**
 * Binary message decoding (client -> server)
 * Uses MessageRegistry pattern for extensible message handling.
 */

import {
  MSG_JOIN,
  MSG_INPUT,
  MSG_PING,
  MSG_VOXEL_BUILD_INTENT,
  MSG_VOXEL_CHUNK_REQUEST,
  MSG_MAP_TILE_REQUEST,
  MSG_SURFACE_COLUMN_REQUEST,
  ByteReader,
  decodeInput,
  decodeVoxelBuildIntent,
  decodeVoxelChunkRequest,
  decodeMapTileRequest,
  decodeSurfaceColumnRequest,
  encodeMapTileData,
  encodeSurfaceColumnData,
} from '@worldify/shared';
import { roomManager } from '../rooms/roomManager.js';
import { encodePong } from '@worldify/shared';
import { registerHandler, dispatch } from './MessageRegistry.js';
import { 
  handleBuildIntent, 
  handleChunkRequest, 
  broadcastBuildCommit 
} from '../rooms/BuildHandler.js';
import { getSurfaceColumnProvider } from '../storage/StorageManager.js';
import { ConcurrencyLimiter } from '../util/RateLimiter.js';

// Per-player concurrency limiters (prevent flooding)
const chunkLimiter = new ConcurrencyLimiter(8);
const tileLimiter = new ConcurrencyLimiter(6);
const columnLimiter = new ConcurrencyLimiter(2);

/**
 * Decode and dispatch an incoming binary message.
 * Delegates to registered handlers via MessageRegistry.
 */
export function decodeMessage(roomId: string, playerId: number, data: Uint8Array): void {
  dispatch(roomId, playerId, data);
}

function handleJoin(_roomId: string, _playerId: number, reader: ByteReader): void {
  const protocolVersion = reader.readUint8();
  const clientPlayerId = reader.readUint16();
  // Join acknowledged - protocol version and client ID captured for validation
  void protocolVersion;
  void clientPlayerId;
}

function handleInput(roomId: string, playerId: number, reader: ByteReader): void {
  const input = decodeInput(reader);
  
  // Update player state in room
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  const player = room.players.get(playerId);
  if (!player) return;
  
  // Only accept newer inputs (seq can wrap around)
  const seqDiff = (input.seq - player.lastInputSeq + 65536) % 65536;
  if (seqDiff > 32768) {
    // Old input, ignore
    return;
  }
  
  // Client-authoritative: copy position directly from client
  player.x = input.x;
  player.y = input.y;
  player.z = input.z;
  player.yaw = input.yaw;
  player.pitch = input.pitch;
  player.buttons = input.buttons;
  player.lastInputSeq = input.seq;
  player.lastInputTime = Date.now();
}

function handlePing(roomId: string, playerId: number, reader: ByteReader): void {
  const timestamp = reader.readUint32();
  
  // Send pong back to this player
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  const ws = room.connections.get(playerId);
  if (ws) {
    ws.send(encodePong(timestamp));
  }
}

function handleVoxelBuildIntent(roomId: string, playerId: number, reader: ByteReader): void {
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  // Decode the build intent
  const intent = decodeVoxelBuildIntent(reader);
  
  // Process the build (validate, apply, get result)
  const commit = handleBuildIntent(room, playerId, intent);
  
  // Broadcast the result to all players in the room
  broadcastBuildCommit(room, commit);
}

function handleVoxelChunkRequest(roomId: string, playerId: number, reader: ByteReader): void {
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  const ws = room.connections.get(playerId);
  if (!ws) return;
  
  const request = decodeVoxelChunkRequest(reader);

  // Per-player concurrency limit
  const playerKey = `${roomId}:${playerId}`;
  if (!chunkLimiter.tryAcquire(playerKey)) return;
  
  handleChunkRequest(room, playerId, request, ws)
    .finally(() => chunkLimiter.release(playerKey))
    .catch((err) => {
      console.error('[decode] Error handling chunk request:', err);
    });
}

function handleMapTileRequest(roomId: string, playerId: number, reader: ByteReader): void {
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  const ws = room.connections.get(playerId);
  if (!ws) return;
  
  const request = decodeMapTileRequest(reader);

  // Per-player concurrency limit
  const playerKey = `${roomId}:${playerId}`;
  if (!tileLimiter.tryAcquire(playerKey)) return;
  
  getSurfaceColumnProvider().getColumn(request.tx, request.tz)
    .then(({ tile }) => {
      const data = encodeMapTileData(tile);
      ws.send(data);
    })
    .catch((err) => {
      console.error('[decode] Error handling map tile request:', err);
    })
    .finally(() => tileLimiter.release(playerKey));
}

function handleSurfaceColumnRequest(roomId: string, playerId: number, reader: ByteReader): void {
  const room = roomManager.getRoom(roomId);
  if (!room) return;
  
  const ws = room.connections.get(playerId);
  if (!ws) return;
  
  const request = decodeSurfaceColumnRequest(reader);

  // Per-player concurrency limit
  const playerKey = `${roomId}:${playerId}`;
  if (!columnLimiter.tryAcquire(playerKey)) return;
  
  getSurfaceColumnProvider().getColumn(request.tx, request.tz)
    .then(({ tile, chunks }) => {
      const data = encodeSurfaceColumnData(tile, chunks);
      ws.send(data);
    })
    .catch((err) => {
      console.error('[decode] Error handling surface column request:', err);
    })
    .finally(() => columnLimiter.release(playerKey));
}

// Register all message handlers
registerHandler(MSG_JOIN, handleJoin);
registerHandler(MSG_INPUT, handleInput);
registerHandler(MSG_PING, handlePing);
registerHandler(MSG_VOXEL_BUILD_INTENT, handleVoxelBuildIntent);
registerHandler(MSG_VOXEL_CHUNK_REQUEST, handleVoxelChunkRequest);
registerHandler(MSG_MAP_TILE_REQUEST, handleMapTileRequest);
registerHandler(MSG_SURFACE_COLUMN_REQUEST, handleSurfaceColumnRequest);
