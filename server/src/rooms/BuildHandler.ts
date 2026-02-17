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
  BuildShape,
  encodeVoxelBuildCommit,
  encodeVoxelChunkData,
  MAX_BUILD_DISTANCE,
  drawToChunk,
  getAffectedChunks,
} from '@worldify/shared';
import { Room } from './room.js';
import { RateLimiter } from '../util/RateLimiter.js';
import { getChunkProvider, getMapTileProvider } from '../storage/StorageManager.js';

// ============== Module-level instances ==============

/** Rate limiter for build actions (100ms between builds) */
const buildRateLimiter = new RateLimiter(100);

/** Build sequence tracking per chunk (in-memory, could be persisted later) */
export const chunkBuildSeq = new Map<string, number>();

/** Next build sequence number (global across all rooms) */
let nextBuildSeq = 1;

/**
 * Reset build state for testing purposes.
 * @internal Only for use in tests
 */
export function resetBuildStateForTesting(): void {
  nextBuildSeq = 0;  // Reset to 0 so first successful build is 1
  chunkBuildSeq.clear();
  buildRateLimiter.clear();
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
 * CYLINDER and SPHERE shapes don't use size.z, so allow it to be 0.
 */
function isValidConfig(intent: VoxelBuildIntent): boolean {
  const { size, shape } = intent.config;
  const needsZ = shape !== BuildShape.CYLINDER && shape !== BuildShape.SPHERE;
  return (
    size.x > 0 && size.y > 0 && (!needsZ || size.z > 0) &&
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
      buildSeq: nextBuildSeq,
      playerId,
      result: BuildResult.RATE_LIMITED,
    };
  }

  // Distance check
  if (!isWithinRange(room, playerId, intent.center)) {
    return {
      buildSeq: nextBuildSeq,
      playerId,
      result: BuildResult.TOO_FAR,
    };
  }

  // Config validation
  if (!isValidConfig(intent)) {
    return {
      buildSeq: nextBuildSeq,
      playerId,
      result: BuildResult.INVALID_CONFIG,
    };
  }

  // Get chunk provider
  const chunkProvider = getChunkProvider();

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
      // Mark chunk as dirty for persistence
      chunkProvider.markDirty(cx, cy, cz);
      // Update map tile with new surface data
      getMapTileProvider().updateFromChunk(chunk);
    }
  }

  // Increment build sequence
  nextBuildSeq++;
  const buildSeq = nextBuildSeq;

  // Update lastBuildSeq for modified chunks
  for (const key of modifiedKeys) {
    chunkBuildSeq.set(key, buildSeq);
  }

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
 * Uses async loading to properly fetch from disk if not in cache.
 */
export async function handleChunkRequest(
  _room: Room,
  _playerId: number,
  request: VoxelChunkRequest,
  ws: WebSocket
): Promise<void> {
  const chunkProvider = getChunkProvider();
  
  console.log(`[build] Chunk request: ${request.chunkX},${request.chunkY},${request.chunkZ}${request.forceRegen ? ' (force regen)' : ''}`);
  
  // Use async method to properly load from disk, passing forceRegen flag
  const chunk = await chunkProvider.getOrCreateAsync(request.chunkX, request.chunkY, request.chunkZ, request.forceRegen);
  const lastBuildSeq = chunkBuildSeq.get(chunk.key) ?? 0;

  // Update map tile with chunk surface data (trees, buildings, etc.)
  getMapTileProvider().updateFromChunk(chunk);

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
 * Note: Chunk data persists in global storage, only rate limiters are cleared.
 */
export function cleanupRoom(roomId: string): void {
  buildRateLimiter.removeByPrefix(`${roomId}:`);
  // Chunk data persists globally - no cleanup needed
}
