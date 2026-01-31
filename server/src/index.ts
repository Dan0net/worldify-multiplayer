import http from 'node:http';
import { setupRoutes } from './http/routes.js';
import { setupWebSocket } from './ws/wsServer.js';
import { initChunkStorage, shutdownChunkStorage, flushChunkStorage } from './rooms/BuildHandler.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Flush interval (save dirty chunks every 30 seconds)
const FLUSH_INTERVAL_MS = 30_000;
let flushInterval: NodeJS.Timeout | null = null;

/**
 * Start the server with async initialization.
 */
async function start(): Promise<void> {
  // Initialize chunk storage (LevelDB)
  await initChunkStorage();
  
  // Create HTTP server
  const server = http.createServer((req, res) => {
    setupRoutes(req, res);
  });

  // Setup WebSocket
  setupWebSocket(server);

  // Start periodic flush of dirty chunks
  flushInterval = setInterval(async () => {
    try {
      await flushChunkStorage();
    } catch (err) {
      console.error('[server] Error flushing chunk storage:', err);
    }
  }, FLUSH_INTERVAL_MS);

  // Start server
  server.listen(PORT, HOST, () => {
    console.log(`[server] Listening on http://${HOST}:${PORT}`);
    console.log(`[server] WebSocket available at ws://${HOST}:${PORT}/ws`);
  });

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[server] ${signal} received, shutting down...`);
    
    // Stop flush interval
    if (flushInterval) {
      clearInterval(flushInterval);
      flushInterval = null;
    }
    
    // Close HTTP server
    server.close(async () => {
      console.log('[server] HTTP server closed');
      
      // Flush and close chunk storage
      try {
        await shutdownChunkStorage();
      } catch (err) {
        console.error('[server] Error shutting down chunk storage:', err);
      }
      
      console.log('[server] Shutdown complete');
      process.exit(0);
    });
    
    // Force exit after 10 seconds if graceful shutdown hangs
    setTimeout(() => {
      console.error('[server] Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Start the server
start().catch((err) => {
  console.error('[server] Failed to start:', err);
  process.exit(1);
});
