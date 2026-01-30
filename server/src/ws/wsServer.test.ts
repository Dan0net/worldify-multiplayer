import { describe, it, expect } from 'vitest';
import { createRoom, createPlayerState } from '../rooms/room.js';

/**
 * Tests for room/connection management patterns used by wsServer.
 * We test the data structures rather than the WebSocket server itself,
 * as mocking ws module's constructor is complex.
 */
describe('wsServer patterns', () => {
  describe('room connection management', () => {
    it('room tracks connections by playerId', () => {
      const room = createRoom('test-room');
      
      // Simulating what addConnection does
      const mockWs1 = { readyState: 1, send: () => {} } as any;
      const mockWs2 = { readyState: 1, send: () => {} } as any;
      
      room.connections.set(1, mockWs1);
      room.connections.set(2, mockWs2);
      
      expect(room.connections.size).toBe(2);
      expect(room.connections.get(1)).toBe(mockWs1);
    });

    it('broadcast pattern sends to open connections only', () => {
      const room = createRoom('broadcast-room');
      const sent: number[] = [];
      
      const mockWsOpen = { 
        readyState: 1, // OPEN
        send: () => sent.push(1),
      } as any;
      const mockWsClosed = { 
        readyState: 3, // CLOSED
        send: () => sent.push(2),
      } as any;
      
      room.connections.set(1, mockWsOpen);
      room.connections.set(2, mockWsClosed);
      
      // Simulate broadcast logic
      const OPEN = 1;
      for (const ws of room.connections.values()) {
        if (ws.readyState === OPEN) {
          ws.send();
        }
      }
      
      expect(sent).toEqual([1]); // Only open connection sent
    });

    it('player removal cleans up connection', () => {
      const room = createRoom('cleanup-room');
      const player = createPlayerState(42);
      
      room.players.set(42, player);
      room.connections.set(42, {} as any);
      room.playerCount = 1;
      
      // Simulate removePlayer logic
      room.connections.delete(42);
      room.players.delete(42);
      room.playerCount--;
      
      expect(room.connections.size).toBe(0);
      expect(room.players.size).toBe(0);
      expect(room.playerCount).toBe(0);
    });
  });
});
