import crypto from 'node:crypto';
import { Room, createRoom, createPlayerState } from './room.js';
import { startRoomTick, stopRoomTick } from './roomTick.js';
import { MAX_PLAYERS_PER_ROOM, EMPTY_ROOM_TIMEOUT_MS } from '@worldify/shared';
import type { WebSocket } from 'ws';

interface PendingJoin {
  roomId: string;
  playerId: number;
  timestamp: number;
}

class RoomManager {
  private rooms: Map<string, Room> = new Map();
  private currentRoomId: string | null = null;
  private pendingJoins: Map<string, PendingJoin> = new Map();
  private nextPlayerId = 1;

  constructor() {
    // Cleanup timer
    setInterval(() => this.cleanup(), 10000);
  }

  assignPlayer(): { roomId: string; playerId: number; token: string } {
    // Get or create current room
    if (!this.currentRoomId || !this.rooms.has(this.currentRoomId)) {
      this.currentRoomId = this.createNewRoom();
    }

    const room = this.rooms.get(this.currentRoomId)!;

    // Check if room is full
    if (room.playerCount >= MAX_PLAYERS_PER_ROOM) {
      this.currentRoomId = this.createNewRoom();
    }

    const roomId = this.currentRoomId;
    const playerId = this.nextPlayerId++;
    const token = this.generateToken();

    // Store pending join
    this.pendingJoins.set(token, {
      roomId,
      playerId,
      timestamp: Date.now(),
    });

    // Reserve spot
    const currentRoom = this.rooms.get(roomId)!;
    currentRoom.playerCount++;

    return { roomId, playerId, token };
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
    
    // Create player state
    const playerState = createPlayerState(playerId);
    room.players.set(playerId, playerState);
    
    console.log(`[room ${roomId}] Player ${playerId} connected (${room.connections.size}/${room.playerCount}) at (${playerState.x.toFixed(1)}, ${playerState.z.toFixed(1)})`);
  }

  removePlayer(roomId: string, playerId: number): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.connections.delete(playerId);
    room.players.delete(playerId);
    room.playerCount = Math.max(0, room.playerCount - 1);
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

  private createNewRoom(): string {
    const roomId = this.generateRoomId();
    const room = createRoom(roomId);
    this.rooms.set(roomId, room);
    
    // Start room tick loop
    startRoomTick(room);
    
    console.log(`[room] Created new room: ${roomId}`);
    return roomId;
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

    // Clean up empty rooms
    for (const [roomId, room] of this.rooms) {
      if (room.playerCount === 0 && now - room.createdAt > EMPTY_ROOM_TIMEOUT_MS) {
        // Stop room ticks before removing
        stopRoomTick(room);
        this.rooms.delete(roomId);
        console.log(`[room] Removed empty room: ${roomId}`);
        if (this.currentRoomId === roomId) {
          this.currentRoomId = null;
        }
      }
    }
  }

  private generateRoomId(): string {
    return crypto.randomBytes(4).toString('hex');
  }

  private generateToken(): string {
    return crypto.randomBytes(16).toString('hex');
  }
}

export const roomManager = new RoomManager();
