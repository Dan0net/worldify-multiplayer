/**
 * WebSocket client for server communication
 */

import { storeBridge } from '../state/bridge';
import { PROTOCOL_VERSION, encodeAckBuild, encodeJoin } from '@worldify/shared';
import { decodeMessage } from './decode';

let ws: WebSocket | null = null;
let localPlayerId: number | null = null;

// Reconnect configuration
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectAttempts = 0;
let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

// Callback for reconnect to request build sync
let onReconnectedCallback: (() => void) | null = null;

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws';

export function setOnReconnected(callback: () => void): void {
  onReconnectedCallback = callback;
}

export async function connectToServer(): Promise<void> {
  // First, join via HTTP
  const response = await fetch(`${API_BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }),
  });

  if (!response.ok) {
    throw new Error(`Join failed: ${response.status}`);
  }

  const { roomId, playerId, token } = await response.json();
  localPlayerId = playerId;
  reconnectAttempts = 0;

  await connectWebSocket(roomId, playerId, token, false);
}

async function connectWebSocket(
  roomId: string,
  playerId: number,
  token: string,
  _isReconnect: boolean
): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`${WS_URL}?token=${token}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      storeBridge.updateConnectionStatus('connected');
      storeBridge.updateRoomInfo(roomId, playerId);
      ws?.send(encodeJoin(PROTOCOL_VERSION, playerId));
      reconnectAttempts = 0;
      
      // Always request build sync (for both initial join and reconnect)
      if (onReconnectedCallback) {
        onReconnectedCallback();
      }
      
      resolve();
    };

    ws.onmessage = (event) => {
      const data = event.data as ArrayBuffer;
      decodeMessage(new Uint8Array(data));
    };

    ws.onclose = () => {
      storeBridge.updateConnectionStatus('disconnected');
      ws = null;
      
      // Attempt reconnect
      scheduleReconnect();
    };

    ws.onerror = () => {
      storeBridge.updateConnectionStatus('disconnected');
      reject(new Error('WebSocket connection failed'));
    };
  });
}

function scheduleReconnect(): void {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[net] Max reconnect attempts reached');
    return;
  }
  
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
  }
  
  reconnectAttempts++;
  console.log(`[net] Scheduling reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);
  
  reconnectTimeout = setTimeout(async () => {
    try {
      // Get a fresh token
      const response = await fetch(`${API_BASE}/api/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION }),
      });

      if (!response.ok) {
        throw new Error(`Reconnect join failed: ${response.status}`);
      }

      const { roomId, playerId, token } = await response.json();
      localPlayerId = playerId;
      
      await connectWebSocket(roomId, playerId, token, true);
    } catch (err) {
      console.error('[net] Reconnect failed:', err);
      scheduleReconnect();
    }
  }, RECONNECT_DELAY_MS);
}

/**
 * Request build sync from server (called after reconnect)
 */
export function requestBuildSync(lastSeenSeq: number): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(encodeAckBuild(lastSeenSeq));
  }
}

export function getPlayerId(): number | null {
  return localPlayerId;
}

export function sendBinary(data: ArrayBuffer | Uint8Array): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(data);
  }
}

export function disconnect(): void {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  reconnectAttempts = MAX_RECONNECT_ATTEMPTS; // Prevent auto-reconnect
  
  if (ws) {
    ws.close();
    ws = null;
  }
}
