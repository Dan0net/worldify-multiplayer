import type { WebSocket } from 'ws';
export declare const PLAYER_EYE_HEIGHT = 1.6;
export declare const GROUND_LEVEL = 0;
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
    velocityY: number;
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
export declare function createRoom(id: string): Room;
/**
 * Create initial player state with spawn position
 */
export declare function createPlayerState(playerId: number): PlayerState;
//# sourceMappingURL=room.d.ts.map