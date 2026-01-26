/**
 * Build log management
 */
import { Room } from './room.js';
import { BuildCommit, BuildIntent } from '@worldify/shared';
export declare function commitBuild(room: Room, playerId: number, intent: BuildIntent): BuildCommit;
export declare function getBuildsSince(room: Room, fromSeq: number): BuildCommit[];
//# sourceMappingURL=buildLog.d.ts.map