import type { WebSocket } from 'ws';
import { TERRITORY_GRID_SIZE, PLAYER_HEIGHT, GROUND_LEVEL } from '@worldify/shared';

// Re-export for backward compatibility (prefer importing directly from shared)
export const PLAYER_EYE_HEIGHT = PLAYER_HEIGHT;

/**
 * Server-side player state (authoritative)
 */
export interface PlayerState {
  playerId: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  velocityY: number; // Vertical velocity for jump/gravity
  buttons: number;
  flags: number;
  lastInputSeq: number;
  lastInputTime: number;
}

export interface Room {
  id: string;
  playerCount: number;
  connections: Map<number, WebSocket>;
  players: Map<number, PlayerState>;
  createdAt: number;
  buildSeq: number;
  buildLog: Array<unknown>;
  territory: Uint16Array;
  tick: number;
  tickInterval: NodeJS.Timeout | null;
  snapshotInterval: NodeJS.Timeout | null;
}

export function createRoom(id: string): Room {
  return {
    id,
    playerCount: 0,
    connections: new Map(),
    players: new Map(),
    createdAt: Date.now(),
    buildSeq: 0,
    buildLog: [],
    territory: new Uint16Array(TERRITORY_GRID_SIZE * TERRITORY_GRID_SIZE),
    tick: 0,
    tickInterval: null,
    snapshotInterval: null,
  };
}

/**
 * Create initial player state with spawn position
 */
export function createPlayerState(playerId: number): PlayerState {
  // Spawn in a circle around center
  const angle = (playerId * 0.618033988749895) * Math.PI * 2;
  const radius = 10 + (playerId % 10) * 2;
  
  return {
    playerId,
    x: Math.cos(angle) * radius,
    y: GROUND_LEVEL + PLAYER_EYE_HEIGHT, // Ground + eye height
    z: Math.sin(angle) * radius,
    yaw: -angle + Math.PI, // Face center
    pitch: 0,
    velocityY: 0,
    buttons: 0,
    flags: 0,
    lastInputSeq: 0,
    lastInputTime: Date.now(),
  };
}
