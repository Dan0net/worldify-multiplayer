/**
 * Room tick logic
 * Server tick runs at SERVER_TICK_HZ (physics/game logic)
 * Snapshots broadcast at SNAPSHOT_HZ (network sync)
 */
import { Room } from './room.js';
export declare function startRoomTick(room: Room): void;
export declare function stopRoomTick(room: Room): void;
//# sourceMappingURL=roomTick.d.ts.map