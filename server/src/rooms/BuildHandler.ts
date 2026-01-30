/**
 * BuildHandler - Server-side voxel build validation and application
 * 
 * SOLID Principles:
 * - Single Responsibility: Validates and applies builds, delegates rate limiting and chunk management
 * - Open/Closed: Uses injected ChunkProvider and RateLimiter that can be extended
 * - Dependency Inversion: Depends on abstractions (ChunkProvider, RateLimiter), not concrete implementations
 */

import { WebSocket } from 'ws';
import {
  VoxelBuildIntent,
  VoxelBuildCommit,
  VoxelChunkRequest,
  BuildResult,
  encodeVoxelBuildCommit,
  encodeVoxelChunkData,
  MAX_BUILD_DISTANCE,
  drawToChunk,
  getAffectedChunks,
} from '@worldify/shared';
import { Room } from './room.js';
import { RateLimiter } from '../util/RateLimiter.js';
import { ChunkProvider } from '../voxel/ChunkProvider.js';

// ============== Module-level instances ==============
// These are shared across all rooms. For per-room instances, inject via Room.

/** Rate limiter for build actions (100ms between builds) */
const buildRateLimiter = new RateLimiter(100);

/** Chunk providers per room */
const roomChunkProviders = new Map<string, ChunkProvider>();

// ============== Chunk Provider Access ==============

/**
 * Get or create the ChunkProvider for a room.
 */
function getChunkProvider(room: Room): ChunkProvider {
  let provider = roomChunkProviders.get(room.id);
  if (!provider) {
    // Create a provider backed by the room's chunk storage
    provider = new ChunkProvider({
      get: (key) => room.voxelChunks.get(key),
      set: (key, chunk) => {
        room.voxelChunks.set(key, chunk);
        room.chunkBuildSeq.set(key, 0);
      },
    });
    roomChunkProviders.set(room.id, provider);
  }
  return provider;
}

// ============== Validation ==============

/**
 * Check if the build center is within range of the player.
 */
function isWithinRange(
  room: Room,
  playerId: number,
  center: { x: number; y: number; z: number }
): boolean {
  const player = room.players.get(playerId);
  if (!player) return false;

  const dx = center.x - player.x;
  const dy = center.y - player.y;
  const dz = center.z - player.z;
  const distSq = dx * dx + dy * dy + dz * dz;

  return distSq <= MAX_BUILD_DISTANCE * MAX_BUILD_DISTANCE;
}

/**
 * Validate build configuration.
 */
function isValidConfig(intent: VoxelBuildIntent): boolean {
  const { size } = intent.config;
  return (
    size.x > 0 && size.y > 0 && size.z > 0 &&
    size.x <= 20 && size.y <= 20 && size.z <= 20
  );
}

// ============== Build Intent Handler ==============

/**
 * Handle a voxel build intent from a client.
 * Validates the build, applies it to server chunks, and returns result.
 */
export function handleBuildIntent(
  room: Room,
  playerId: number,
  intent: VoxelBuildIntent
): VoxelBuildCommit {
  const rateLimitKey = `${room.id}:${playerId}`;

  // Rate limit check
  if (buildRateLimiter.check(rateLimitKey)) {
    return {
      buildSeq: room.nextBuildSeq,
      playerId,
      result: BuildResult.RATE_LIMITED,
    };
  }

  // Distance check
  if (!isWithinRange(room, playerId, intent.center)) {
    return {
      buildSeq: room.nextBuildSeq,
      playerId,
      result: BuildResult.TOO_FAR,
    };
  }

  // Config validation
  if (!isValidConfig(intent)) {
    return {
      buildSeq: room.nextBuildSeq,
      playerId,
      result: BuildResult.INVALID_CONFIG,
    };
  }

  // Get chunk provider
  const chunkProvider = getChunkProvider(room);

  // Build operation
  const operation = {
    center: intent.center,
    rotation: intent.rotation,
    config: intent.config,
  };

  // Get affected chunks and apply build
  const affectedKeys = getAffectedChunks(operation);
  const modifiedKeys: string[] = [];

  for (const key of affectedKeys) {
    const [cxStr, cyStr, czStr] = key.split(',');
    const cx = parseInt(cxStr, 10);
    const cy = parseInt(cyStr, 10);
    const cz = parseInt(czStr, 10);

    const chunk = chunkProvider.getOrCreate(cx, cy, cz);
    const changed = drawToChunk(chunk, operation);
    if (changed) {
      modifiedKeys.push(key);
    }
  }

  // Increment build sequence
  room.nextBuildSeq++;
  const buildSeq = room.nextBuildSeq;

  // Update lastBuildSeq for modified chunks
  for (const key of modifiedKeys) {
    room.chunkBuildSeq.set(key, buildSeq);
  }

  console.log(
    `[room ${room.id}] Player ${playerId} built at ` +
    `(${intent.center.x.toFixed(1)}, ${intent.center.y.toFixed(1)}, ${intent.center.z.toFixed(1)}), ` +
    `modified ${modifiedKeys.length} chunks, seq=${buildSeq}`
  );

  return {
    buildSeq,
    playerId,
    result: BuildResult.SUCCESS,
    intent,
  };
}

// ============== Chunk Request Handler ==============

/**
 * Handle a chunk data request from a client.
 */
export function handleChunkRequest(
  room: Room,
  playerId: number,
  request: VoxelChunkRequest,
  ws: WebSocket
): void {
  const chunkProvider = getChunkProvider(room);
  const chunk = chunkProvider.getOrCreate(request.chunkX, request.chunkY, request.chunkZ);
  const lastBuildSeq = room.chunkBuildSeq.get(chunk.key) ?? 0;

  const chunkData = {
    chunkX: chunk.cx,
    chunkY: chunk.cy,
    chunkZ: chunk.cz,
    lastBuildSeq,
    voxelData: chunk.data,
  };

  const encoded = encodeVoxelChunkData(chunkData);

  if (ws.readyState === WebSocket.OPEN) {
    ws.send(encoded);
  }

  console.log(
    `[room ${room.id}] Sent chunk (${request.chunkX}, ${request.chunkY}, ${request.chunkZ}) to player ${playerId}`
  );
}

// ============== Broadcast ==============

/**
 * Broadcast a build commit to all players in a room.
 */
export function broadcastBuildCommit(room: Room, commit: VoxelBuildCommit): void {
  const encoded = encodeVoxelBuildCommit(commit);

  for (const ws of room.connections.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(encoded);
    }
  }
}

// ============== Cleanup ==============

/**
 * Clean up state for a disconnected player.
 */
export function cleanupPlayer(roomId: string, playerId: number): void {
  buildRateLimiter.remove(`${roomId}:${playerId}`);
}

/**
 * Clean up all state for a removed room.
 */
export function cleanupRoom(roomId: string): void {
  buildRateLimiter.removeByPrefix(`${roomId}:`);
  roomChunkProviders.delete(roomId);
}
