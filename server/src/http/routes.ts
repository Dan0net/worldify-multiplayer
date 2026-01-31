import type { IncomingMessage, ServerResponse } from 'node:http';
import { roomManager } from '../rooms/roomManager.js';
import { PROTOCOL_VERSION } from '@worldify/shared';

export function setupRoutes(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (url.pathname === '/healthz' && req.method === 'GET') {
    const stats = roomManager.getStats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: stats.roomCount,
      players: stats.playerCount,
      protocolVersion: PROTOCOL_VERSION,
    }));
    return;
  }

  // Rooms info endpoint (for landing page)
  if (url.pathname === '/api/rooms' && req.method === 'GET') {
    const rooms = roomManager.getRooms();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      rooms,
    }));
    return;
  }

  // Join endpoint
  if (url.pathname === '/api/join' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const clientVersion = data.protocolVersion;

        // Version check
        if (clientVersion !== PROTOCOL_VERSION) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'version_mismatch',
            serverVersion: PROTOCOL_VERSION,
          }));
          return;
        }

        // Get room assignment
        const assignment = roomManager.assignPlayer();
        
        if (!assignment) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: 'server_full',
            message: 'Server is at capacity. Please try again later.',
          }));
          return;
        }
        
        const { roomId, playerId, token } = assignment;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          roomId,
          playerId,
          token,
          protocolVersion: PROTOCOL_VERSION,
        }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_request' }));
      }
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}
