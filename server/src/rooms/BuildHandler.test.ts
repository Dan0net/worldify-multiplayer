/**
 * Tests for BuildHandler
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { 
  handleBuildIntent, 
  cleanupPlayer, 
  cleanupRoom 
} from '../rooms/BuildHandler.js';
import { Room, createRoom, createPlayerState } from '../rooms/room.js';
import { 
  VoxelBuildIntent,
  BuildResult,
  BuildMode,
  BuildShape,
  MAX_BUILD_DISTANCE,
} from '@worldify/shared';

// Counter to make each room unique to avoid shared state
let roomCounter = 0;

// Helper to create a test room with a player
function createTestRoom(): Room {
  roomCounter++;
  const room = createRoom(`test-room-${roomCounter}`);
  const playerState = createPlayerState(1);
  playerState.x = 0;
  playerState.y = 2;
  playerState.z = 0;
  room.players.set(1, playerState);
  return room;
}

// Helper to create a valid build intent
function createValidIntent(center = { x: 0, y: 2, z: 0 }): VoxelBuildIntent {
  return {
    center,
    rotation: { x: 0, y: 0, z: 0, w: 1 },
    config: {
      shape: BuildShape.CUBE,
      mode: BuildMode.ADD,
      size: { x: 3, y: 3, z: 3 },
      material: 1,
    },
  };
}

describe('BuildHandler', () => {
  let testRoom: Room;

  beforeEach(() => {
    vi.useFakeTimers();
    testRoom = createTestRoom();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up the room to reset rate limiter state
    cleanupRoom(testRoom.id);
  });

  describe('handleBuildIntent', () => {
    describe('rate limiting', () => {
      it('should allow first build', () => {
        const room = testRoom;
        const intent = createValidIntent();
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.result).toBe(BuildResult.SUCCESS);
      });

      it('should rate limit rapid builds', () => {
        const room = testRoom;
        const intent = createValidIntent();
        
        // First build succeeds
        handleBuildIntent(room, 1, intent);
        
        // Immediate second build should be rate limited
        const result = handleBuildIntent(room, 1, intent);
        expect(result.result).toBe(BuildResult.RATE_LIMITED);
      });

      it('should allow build after rate limit expires', () => {
        const room = testRoom;
        const intent = createValidIntent();
        
        handleBuildIntent(room, 1, intent);
        
        // Advance time past rate limit
        vi.advanceTimersByTime(150);
        
        const result = handleBuildIntent(room, 1, intent);
        expect(result.result).toBe(BuildResult.SUCCESS);
      });

      it('should track rate limit per player', () => {
        const room = testRoom;
        // Add second player
        const player2 = createPlayerState(2);
        player2.x = 0;
        player2.y = 2;
        player2.z = 0;
        room.players.set(2, player2);
        
        const intent = createValidIntent();
        
        // Player 1 builds
        handleBuildIntent(room, 1, intent);
        
        // Player 2 can still build
        const result = handleBuildIntent(room, 2, intent);
        expect(result.result).toBe(BuildResult.SUCCESS);
      });
    });

    describe('distance validation', () => {
      it('should allow build within range', () => {
        const room = testRoom;
        const intent = createValidIntent({ x: 5, y: 2, z: 0 });
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.result).toBe(BuildResult.SUCCESS);
      });

      it('should reject build too far away', () => {
        const room = testRoom;
        const intent = createValidIntent({ 
          x: MAX_BUILD_DISTANCE + 5, 
          y: 2, 
          z: 0 
        });
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.result).toBe(BuildResult.TOO_FAR);
      });

      it('should allow build at exact max distance', () => {
        const room = testRoom;
        const intent = createValidIntent({ 
          x: MAX_BUILD_DISTANCE, 
          y: 2, 
          z: 0 
        });
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.result).toBe(BuildResult.SUCCESS);
      });
    });

    describe('config validation', () => {
      it('should reject zero size', () => {
        const room = testRoom;
        const intent = createValidIntent();
        intent.config.size = { x: 0, y: 3, z: 3 };
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.result).toBe(BuildResult.INVALID_CONFIG);
      });

      it('should reject negative size', () => {
        const room = testRoom;
        const intent = createValidIntent();
        intent.config.size = { x: -1, y: 3, z: 3 };
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.result).toBe(BuildResult.INVALID_CONFIG);
      });

      it('should reject size too large', () => {
        const room = testRoom;
        const intent = createValidIntent();
        intent.config.size = { x: 25, y: 3, z: 3 };
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.result).toBe(BuildResult.INVALID_CONFIG);
      });

      it('should accept maximum allowed size', () => {
        const room = testRoom;
        const intent = createValidIntent();
        intent.config.size = { x: 20, y: 20, z: 20 };
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.result).toBe(BuildResult.SUCCESS);
      });
    });

    describe('build sequence', () => {
      it('should increment build sequence on success', () => {
        const room = testRoom;
        expect(room.nextBuildSeq).toBe(0);
        
        const intent = createValidIntent();
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.buildSeq).toBe(1);
        expect(room.nextBuildSeq).toBe(1);
      });

      it('should not increment build sequence on failure', () => {
        const room = testRoom;
        const intent = createValidIntent({ x: 1000, y: 0, z: 0 }); // Too far
        
        handleBuildIntent(room, 1, intent);
        
        expect(room.nextBuildSeq).toBe(0);
      });
    });

    describe('chunk modification', () => {
      it('should create chunks for affected area', () => {
        const room = testRoom;
        expect(room.voxelChunks.size).toBe(0);
        
        const intent = createValidIntent();
        handleBuildIntent(room, 1, intent);
        
        expect(room.voxelChunks.size).toBeGreaterThan(0);
      });

      it('should track build sequence per chunk', () => {
        const room = testRoom;
        
        const intent = createValidIntent();
        const result = handleBuildIntent(room, 1, intent);
        
        // At least one chunk should have the build sequence
        let foundSeq = false;
        for (const seq of room.chunkBuildSeq.values()) {
          if (seq === result.buildSeq) {
            foundSeq = true;
            break;
          }
        }
        expect(foundSeq).toBe(true);
      });
    });

    describe('result data', () => {
      it('should include intent on success', () => {
        const room = testRoom;
        const intent = createValidIntent();
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.intent).toBeDefined();
        expect(result.intent?.center).toEqual(intent.center);
      });

      it('should not include intent on failure', () => {
        const room = testRoom;
        const intent = createValidIntent({ x: 1000, y: 0, z: 0 });
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.intent).toBeUndefined();
      });

      it('should include player ID', () => {
        const room = testRoom;
        const intent = createValidIntent();
        
        const result = handleBuildIntent(room, 1, intent);
        
        expect(result.playerId).toBe(1);
      });
    });
  });

  describe('cleanup functions', () => {
    it('cleanupPlayer should allow immediate build after cleanup', () => {
      const room = testRoom;
      const intent = createValidIntent();
      
      // Build and get rate limited
      handleBuildIntent(room, 1, intent);
      expect(handleBuildIntent(room, 1, intent).result).toBe(BuildResult.RATE_LIMITED);
      
      // Cleanup player
      cleanupPlayer(room.id, 1);
      
      // Should be able to build again
      expect(handleBuildIntent(room, 1, intent).result).toBe(BuildResult.SUCCESS);
    });

    it('cleanupRoom should clean up all players in room', () => {
      const room = testRoom;
      const player2 = createPlayerState(2);
      player2.x = 0;
      player2.y = 2;
      player2.z = 0;
      room.players.set(2, player2);
      
      const intent = createValidIntent();
      
      // Both players build
      handleBuildIntent(room, 1, intent);
      handleBuildIntent(room, 2, intent);
      
      // Both rate limited (no time advanced)
      expect(handleBuildIntent(room, 1, intent).result).toBe(BuildResult.RATE_LIMITED);
      expect(handleBuildIntent(room, 2, intent).result).toBe(BuildResult.RATE_LIMITED);
      
      // Cleanup room
      cleanupRoom(room.id);
      
      // Both can build again
      expect(handleBuildIntent(room, 1, intent).result).toBe(BuildResult.SUCCESS);
      expect(handleBuildIntent(room, 2, intent).result).toBe(BuildResult.SUCCESS);
    });
  });
});
