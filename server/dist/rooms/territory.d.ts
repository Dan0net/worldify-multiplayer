/**
 * Server-side territory management
 */
import { Room } from './room.js';
export declare function claimCell(room: Room, x: number, z: number, playerId: number): boolean;
export declare function getCell(room: Room, x: number, z: number): number;
export declare function applyConsumeWave(_room: Room): void;
//# sourceMappingURL=territory.d.ts.map