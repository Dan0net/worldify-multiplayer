/**
 * Room offset utilities - maps room names to world spawn positions
 * 
 * Each room name hashes to a unique (X, Z) offset in the world.
 * Rooms are spaced far apart (~80km) so players can't walk between them.
 */

import { ROOM_SPACING_CHUNKS, ROOM_NAMES, RoomName } from '../protocol/constants.js';
import { CHUNK_WORLD_SIZE } from '../voxel/constants.js';

/**
 * Simple string hash function (djb2 algorithm).
 * Produces a deterministic positive integer from a string.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
  }
  return Math.abs(hash);
}

/**
 * Get the spawn offset for a room in world coordinates (meters).
 * 
 * @param roomName The room name to get offset for
 * @returns World position offset { x, z } in meters
 */
export function roomToOffset(roomName: string): { x: number; z: number } {
  const hash = hashString(roomName);
  
  // Use a grid layout based on room index for predictability
  const index = ROOM_NAMES.indexOf(roomName as RoomName);
  
  // If it's a known room name, use grid position
  // Otherwise fall back to hash-based position
  let gridX: number;
  let gridZ: number;
  
  if (index >= 0) {
    // 5x4 grid layout for 20 rooms
    const GRID_WIDTH = 5;
    gridX = (index % GRID_WIDTH) - 2; // -2 to +2
    gridZ = Math.floor(index / GRID_WIDTH) - 2; // -2 to +1
  } else {
    // Hash-based fallback for unknown room names
    const GRID_SIZE = 100;
    gridX = (hash % GRID_SIZE) - GRID_SIZE / 2;
    gridZ = (Math.floor(hash / GRID_SIZE) % GRID_SIZE) - GRID_SIZE / 2;
  }
  
  const spacingMeters = ROOM_SPACING_CHUNKS * CHUNK_WORLD_SIZE;
  
  return {
    x: gridX * spacingMeters,
    z: gridZ * spacingMeters,
  };
}

/**
 * Get the spawn position for a room including Y coordinate.
 * Y is set above the terrain surface.
 * 
 * @param roomName The room name
 * @param spawnHeight Height above terrain to spawn (default 10m)
 * @returns World position { x, y, z } in meters
 */
export function roomToSpawnPosition(
  roomName: string, 
  spawnHeight: number = 10
): { x: number; y: number; z: number } {
  const offset = roomToOffset(roomName);
  return {
    x: offset.x,
    y: spawnHeight,
    z: offset.z,
  };
}

/**
 * Check if a room name is valid (in the known pool).
 */
export function isValidRoomName(name: string): name is RoomName {
  return ROOM_NAMES.includes(name as RoomName);
}
