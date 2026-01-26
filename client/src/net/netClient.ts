/**
 * WebSocket client for server communication
 */

import { storeBridge } from '../state/bridge';
import { PROTOCOL_VERSION } from '@worldify/shared';
import { decodeMessage } from './decode';
import { encodeJoin } from './encode';

let ws: WebSocket | null = null;
let localPlayerId: number | null = null;

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080';
const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8080/ws';

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

  // Then connect via WebSocket
  ws = new WebSocket(`${WS_URL}?token=${token}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    storeBridge.updateConnectionStatus('connected');
    storeBridge.updateRoomInfo(roomId, playerId);
    ws?.send(encodeJoin(PROTOCOL_VERSION, playerId));
  };

  ws.onmessage = (event) => {
    const data = event.data as ArrayBuffer;
    decodeMessage(new Uint8Array(data));
  };

  ws.onclose = () => {
    storeBridge.updateConnectionStatus('disconnected');
    ws = null;
  };

  ws.onerror = () => {
    storeBridge.updateConnectionStatus('disconnected');
  };
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
  if (ws) {
    ws.close();
    ws = null;
  }
}
