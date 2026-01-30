import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock ws module
vi.mock('ws', () => ({
  WebSocketServer: vi.fn(() => {
    const emitter = new EventEmitter();
    return {
      on: emitter.on.bind(emitter),
      emit: emitter.emit.bind(emitter),
      close: vi.fn(),
    };
  }),
}));

// Mock roomManager - needs to be imported after mock setup
vi.mock('../rooms/roomManager.js', () => ({
  roomManager: {
    validateToken: vi.fn(),
    addConnection: vi.fn(),
    removePlayer: vi.fn(),
    getRoom: vi.fn(),
  },
}));

import { setupWebSocket, broadcast } from './wsServer.js';
import { roomManager } from '../rooms/roomManager.js';

describe('wsServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('setupWebSocket creates WebSocket server', () => {
    const mockHttpServer = {} as any;
    const wss = setupWebSocket(mockHttpServer);
    
    expect(wss).toBeDefined();
  });

  it('broadcast sends to all connections in room', () => {
    const mockWs1 = { 
      readyState: 1, // OPEN
      send: vi.fn(),
    };
    const mockWs2 = { 
      readyState: 1,
      send: vi.fn(),
    };
    
    const mockRoom = {
      id: 'test-room',
      connections: new Map([
        [1, mockWs1],
        [2, mockWs2],
      ]),
    };
    
    vi.mocked(roomManager.getRoom).mockReturnValue(mockRoom as any);
    
    const data = new Uint8Array([1, 2, 3]);
    broadcast('test-room', data);
    
    expect(mockWs1.send).toHaveBeenCalledWith(data);
    expect(mockWs2.send).toHaveBeenCalledWith(data);
  });

  it('broadcast skips closed connections', () => {
    const mockWsOpen = { 
      readyState: 1, // OPEN
      send: vi.fn(),
    };
    const mockWsClosed = { 
      readyState: 3, // CLOSED
      send: vi.fn(),
    };
    
    const mockRoom = {
      id: 'test-room',
      connections: new Map([
        [1, mockWsOpen],
        [2, mockWsClosed],
      ]),
    };
    
    vi.mocked(roomManager.getRoom).mockReturnValue(mockRoom as any);
    
    broadcast('test-room', new Uint8Array([1]));
    
    expect(mockWsOpen.send).toHaveBeenCalled();
    expect(mockWsClosed.send).not.toHaveBeenCalled();
  });

  it('broadcast handles missing room gracefully', () => {
    vi.mocked(roomManager.getRoom).mockReturnValue(undefined);
    
    // Should not throw
    expect(() => broadcast('nonexistent', new Uint8Array([1]))).not.toThrow();
  });
});
