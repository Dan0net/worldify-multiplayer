import { TERRITORY_GRID_SIZE } from '@worldify/shared';
// Physics constants
export const PLAYER_EYE_HEIGHT = 1.6;
export const GROUND_LEVEL = 0;
export function createRoom(id) {
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
export function createPlayerState(playerId) {
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
//# sourceMappingURL=room.js.map