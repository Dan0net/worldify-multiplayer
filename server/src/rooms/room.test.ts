import { describe, it, expect } from 'vitest';
import { createRoom, createPlayerState, type Room, type PlayerState } from './room.js';

describe('Room', () => {
  it('creates room with correct id', () => {
    const room = createRoom('test-room-123');
    
    expect(room.id).toBe('test-room-123');
  });

  it('initializes with empty collections', () => {
    const room = createRoom('empty-room');
    
    expect(room.connections.size).toBe(0);
    expect(room.players.size).toBe(0);
    expect(room.playerCount).toBe(0);
  });

  it('has voxel chunk storage', () => {
    const room = createRoom('voxel-room');
    
    expect(room.voxelChunks).toBeInstanceOf(Map);
    expect(room.chunkBuildSeq).toBeInstanceOf(Map);
  });

  it('has tick tracking properties', () => {
    const room = createRoom('tick-room');
    
    expect(room.tick).toBe(0);
    expect(room.lastTickTime).toBeDefined();
  });
});

describe('PlayerState', () => {
  it('creates player with correct id', () => {
    const player = createPlayerState(42);
    
    expect(player.playerId).toBe(42);
  });

  it('spawns at default position', () => {
    const player = createPlayerState(1);
    
    // Default Y is typically above terrain
    expect(typeof player.x).toBe('number');
    expect(typeof player.y).toBe('number');
    expect(typeof player.z).toBe('number');
  });

  it('initializes with zero velocity', () => {
    const player = createPlayerState(1);
    
    expect(player.vx).toBe(0);
    expect(player.vy).toBe(0);
    expect(player.vz).toBe(0);
  });

  it('different players get different spawn positions', () => {
    const positions = new Set<string>();
    
    for (let i = 0; i < 10; i++) {
      const player = createPlayerState(i);
      positions.add(`${player.x},${player.z}`);
    }
    
    // Should have some variety in spawn positions
    expect(positions.size).toBeGreaterThan(1);
  });

  it('has rotation property', () => {
    const player = createPlayerState(1);
    
    expect(typeof player.yaw).toBe('number');
  });
});

describe('Room + PlayerState integration', () => {
  it('room can store multiple players', () => {
    const room = createRoom('multi-player');
    
    const p1 = createPlayerState(1);
    const p2 = createPlayerState(2);
    
    room.players.set(p1.playerId, p1);
    room.players.set(p2.playerId, p2);
    
    expect(room.players.size).toBe(2);
    expect(room.players.get(1)).toBe(p1);
    expect(room.players.get(2)).toBe(p2);
  });
});
