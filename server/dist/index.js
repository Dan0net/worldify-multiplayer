import http from 'node:http';
import { setupRoutes } from './http/routes.js';
import { setupWebSocket } from './ws/wsServer.js';
const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
// Create HTTP server
const server = http.createServer((req, res) => {
    setupRoutes(req, res);
});
// Setup WebSocket
setupWebSocket(server);
// Start server
server.listen(PORT, HOST, () => {
    console.log(`[server] Listening on http://${HOST}:${PORT}`);
    console.log(`[server] WebSocket available at ws://${HOST}:${PORT}/ws`);
});
// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('[server] SIGTERM received, shutting down...');
    server.close(() => {
        console.log('[server] Server closed');
        process.exit(0);
    });
});
//# sourceMappingURL=index.js.map