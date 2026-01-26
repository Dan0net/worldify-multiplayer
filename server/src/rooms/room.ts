import type { WebSocket } from 'ws';
import { TERRITORY_GRID_SIZE } from '@worldify/shared';

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
    y: 1.8, // Eye height
    z: Math.sin(angle) * radius,
    yaw: -angle + Math.PI, // Face center
    pitch: 0,
    buttons: 0,
    flags: 0,
    lastInputSeq: 0,
    lastInputTime: Date.now(),
  };
}
