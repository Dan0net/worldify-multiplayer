/**
 * Binary message encoding (server -> client)
 */
import { RoomSnapshot, BuildCommit } from '@worldify/shared';
export declare function encodeWelcome(playerId: number, roomId: string): Uint8Array;
export declare function encodeRoomInfo(playerCount: number): Uint8Array;
export declare function encodeSnapshot(snapshot: RoomSnapshot): Uint8Array;
export declare function encodeBuildCommit(commit: BuildCommit): Uint8Array;
export declare function encodeBuildSync(startSeq: number, commits: BuildCommit[]): Uint8Array;
export declare function encodePong(timestamp: number): Uint8Array;
//# sourceMappingURL=encode.d.ts.map