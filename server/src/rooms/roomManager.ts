import crypto from 'node:crypto';
import { Room, createRoom, createPlayerState } from './room.js';
import { startRoomTick, stopRoomTick } from './roomTick.js';
import { cleanupPlayer, cleanupRoom } from './BuildHandler.js';
import { 
  MAX_PLAYERS_PER_ROOM, 
  EMPTY_ROOM_TIMEOUT_MS, 
  ROOM_NAMES,
  RoomName,
} from '@worldify/shared';
import type { WebSocket } from 'ws';

interface PendingJoin {
  roomId: string;
  playerId: number;
  timestamp: number;
}

class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private pendingJoins: Map<string, PendingJoin> = new Map();
  private nextPlayerId = 1;

  constructor() {
    // Cleanup timer
    setInterval(() => this.cleanup(), 10000);
  }

  /**
   * Assign a player to a room.
   * Strategy: Fill busiest room first, then next busiest, create new if all full.
   */
  assignPlayer(): { roomId: string; playerId: number; token: string } | null {
    // Find the best room to join
    const roomId = this.findBestRoom();
    
    if (!roomId) {
      console.log('[room] Server at capacity - all rooms full');
      return null;
    }

    const room = this.rooms.get(roomId)!;
    const playerId = this.nextPlayerId++;
    const token = this.generateToken();

    // Store pending join
    this.pendingJoins.set(token, {
      roomId,
      playerId,
      timestamp: Date.now(),
    });

    // Reserve spot
    room.playerCount++;

    return { roomId, playerId, token };
  }

  /**
   * Find the best room to join:
   * 1. Sort active rooms by player count (descending - busiest first)
   * 2. Pick the first room that isn't full
   * 3. If all full, create a new room with an unused name
   * 4. If all names used and full, return null (server at capacity)
   */
  private findBestRoom(): string | null {
    // Get active rooms sorted by player count (descending)
    const activeRooms = Array.from(this.rooms.entries())
      .map(([id, room]) => ({ id, playerCount: room.playerCount }))
      .sort((a, b) => b.playerCount - a.playerCount);

    // Find first room that isn't full
    for (const { id, playerCount } of activeRooms) {
      if (playerCount < MAX_PLAYERS_PER_ROOM) {
        return id;
      }
    }

    // All rooms are full (or no rooms exist) - create a new one
    const unusedName = this.getUnusedRoomName();
    if (unusedName) {
      return this.createNewRoom(unusedName);
    }

    // All room names used and full - server at capacity
    return null;
  }

  /**
   * Get an unused room name from the pool.
   */
  private getUnusedRoomName(): RoomName | null {
    for (const name of ROOM_NAMES) {
      if (!this.rooms.has(name)) {
        return name;
      }
    }
    return null;
  }

  validateToken(token: string): PendingJoin | null {
    const pending = this.pendingJoins.get(token);
    if (!pending) return null;

    // Token expires after 30 seconds
    if (Date.now() - pending.timestamp > 30000) {
      this.pendingJoins.delete(token);
      return null;
    }

    this.pendingJoins.delete(token);
    return pending;
  }

  addConnection(roomId: string, playerId: number, ws: WebSocket): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.connections.set(playerId, ws);
    
    // Create player state with room-specific spawn position
    const playerState = createPlayerState(playerId, roomId);
    room.players.set(playerId, playerState);
    
    console.log(`[room ${roomId}] Player ${playerId} connected (${room.connections.size}/${room.playerCount}) at (${playerState.x.toFixed(1)}, ${playerState.z.toFixed(1)})`);
  }

  removePlayer(roomId: string, playerId: number): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.connections.delete(playerId);
    room.players.delete(playerId);
    room.playerCount = Math.max(0, room.playerCount - 1);
    
    // Clean up build handler state for this player
    cleanupPlayer(roomId, playerId);
    
    console.log(`[room ${roomId}] Player ${playerId} disconnected (${room.connections.size} remaining)`);
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  getStats(): { roomCount: number; playerCount: number } {
    let playerCount = 0;
    for (const room of this.rooms.values()) {
      playerCount += room.playerCount;
    }
    return {
      roomCount: this.rooms.size,
      playerCount,
    };
  }

  getRooms(): Array<{ id: string; playerCount: number }> {
    const rooms: Array<{ id: string; playerCount: number }> = [];
    for (const room of this.rooms.values()) {
      rooms.push({
        id: room.id,
        playerCount: room.connections.size, // Active connections, not reserved spots
      });
    }
    return rooms;
  }

  /**
   * Create a new room with the given name.
   */
  private createNewRoom(roomName: string): string {
    const room = createRoom(roomName);
    this.rooms.set(roomName, room);
    
    // Start room tick loop
    startRoomTick(room);
    
    console.log(`[room] Created new room: ${roomName}`);
    return roomName;
  }

  private cleanup(): void {
    const now = Date.now();

    // Clean up expired pending joins
    for (const [token, pending] of this.pendingJoins) {
      if (now - pending.timestamp > 30000) {
        this.pendingJoins.delete(token);
        // Release reserved spot
        const room = this.rooms.get(pending.roomId);
        if (room) {
          room.playerCount = Math.max(0, room.playerCount - 1);
        }
      }
    }

    // Clean up empty rooms (but don't delete world data - that persists)
    for (const [roomId, room] of this.rooms) {
      if (room.playerCount === 0 && now - room.createdAt > EMPTY_ROOM_TIMEOUT_MS) {
        // Stop room ticks before removing
        stopRoomTick(room);
        // Clean up build handler state for this room (in-memory only)
        cleanupRoom(roomId);
        this.rooms.delete(roomId);
        console.log(`[room] Removed empty room: ${roomId} (world data persists)`);
      }
    }
  }

  private generateToken(): string {
    return crypto.randomBytes(16).toString('hex');
  }
}

export const roomManager = new RoomManager();
