import { WebSocketServer, WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import { roomManager } from '../rooms/roomManager.js';
import { decodeMessage } from '../net/decode.js';
import { encodeWelcome } from '@worldify/shared';

interface AuthenticatedSocket extends WebSocket {
  playerId?: number;
  roomId?: string;
  isAlive?: boolean;
}

let wss: WebSocketServer;

export function setupWebSocket(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws: AuthenticatedSocket, req: IncomingMessage) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    // Validate token and get player info
    const playerInfo = roomManager.validateToken(token);
    if (!playerInfo) {
      ws.close(4002, 'Invalid token');
      return;
    }

    ws.playerId = playerInfo.playerId;
    ws.roomId = playerInfo.roomId;
    ws.isAlive = true;

    // Add player to room
    roomManager.addConnection(playerInfo.roomId, playerInfo.playerId, ws);

    // Send welcome message
    ws.send(encodeWelcome(playerInfo.playerId, playerInfo.roomId));

    ws.on('message', (data: Buffer) => {
      if (ws.roomId && ws.playerId !== undefined) {
        decodeMessage(ws.roomId, ws.playerId, new Uint8Array(data));
      }
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('close', () => {
      if (ws.roomId && ws.playerId !== undefined) {
        roomManager.removePlayer(ws.roomId, ws.playerId);
      }
    });

    ws.on('error', (err) => {
      console.error('[ws] Error:', err.message);
    });
  });

  // Heartbeat
  setInterval(() => {
    wss.clients.forEach((ws) => {
      const socket = ws as AuthenticatedSocket;
      if (socket.isAlive === false) {
        return socket.terminate();
      }
      socket.isAlive = false;
      socket.ping();
    });
  }, 30000);

  console.log('[ws] WebSocket server ready');
}

export function broadcast(roomId: string, data: Uint8Array | ArrayBuffer): void {
  const room = roomManager.getRoom(roomId);
  if (!room) return;

  for (const ws of room.connections.values()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }
}
