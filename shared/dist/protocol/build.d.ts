/**
 * Build system types and binary encoding
 *
 * BUILD_INTENT Binary Layout (Client -> Server):
 * ┌─────────────┬────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type   │ Description                              │
 * ├─────────────┼────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8  │ MSG_BUILD_INTENT (0x03)                  │
 * │ 1           │ uint8  │ Piece type (0=floor, 1=wall, 2=slope)    │
 * │ 2-3         │ uint16 │ Grid X position                          │
 * │ 4-5         │ uint16 │ Grid Z position                          │
 * │ 6           │ uint8  │ Rotation (0-3 for 90° increments)        │
 * └─────────────┴────────┴──────────────────────────────────────────┘
 * Total: 7 bytes
 *
 * BUILD_COMMIT Binary Layout (Server -> Client):
 * ┌─────────────┬────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type   │ Description                              │
 * ├─────────────┼────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8  │ MSG_BUILD_COMMIT (0x83)                  │
 * │ 1-4         │ uint32 │ Build sequence number                    │
 * │ 5-6         │ uint16 │ Player ID who placed                     │
 * │ 7           │ uint8  │ Piece type                               │
 * │ 8-9         │ uint16 │ Grid X position                          │
 * │ 10-11       │ uint16 │ Grid Z position                          │
 * │ 12          │ uint8  │ Rotation                                 │
 * └─────────────┴────────┴──────────────────────────────────────────┘
 * Total: 13 bytes
 *
 * BUILD_SYNC Binary Layout (Server -> Client):
 * ┌─────────────┬────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type   │ Description                              │
 * ├─────────────┼────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8  │ MSG_BUILD_SYNC (0x84)                    │
 * │ 1-4         │ uint32 │ Starting build sequence number           │
 * │ 5-6         │ uint16 │ Number of commits (N)                    │
 * │ 7+          │ Commit │ N × BuildCommitData (10 bytes each)      │
 * └─────────────┴────────┴──────────────────────────────────────────┘
 *
 * BuildCommitData (without msg ID, for BUILD_SYNC):
 * ┌─────────────┬────────┬──────────────────────────────────────────┐
 * │ 0-1         │ uint16 │ Player ID                                │
 * │ 2           │ uint8  │ Piece type                               │
 * │ 3-4         │ uint16 │ Grid X                                   │
 * │ 5-6         │ uint16 │ Grid Z                                   │
 * │ 7           │ uint8  │ Rotation                                 │
 * └─────────────┴────────┴──────────────────────────────────────────┘
 * Total per commit: 8 bytes
 */
import { ByteReader } from '../util/bytes.js';
export declare enum BuildPieceType {
    FLOOR = 0,
    WALL = 1,
    SLOPE = 2
}
export interface BuildIntent {
    pieceType: BuildPieceType;
    gridX: number;
    gridZ: number;
    rotation: number;
}
export interface BuildCommit {
    buildSeq: number;
    playerId: number;
    pieceType: BuildPieceType;
    gridX: number;
    gridZ: number;
    rotation: number;
}
export declare const BUILD_COMMIT_SYNC_BYTES = 8;
/**
 * Encode build intent for network transmission
 */
export declare function encodeBuildIntent(intent: BuildIntent): Uint8Array;
/**
 * Decode build intent from network data
 */
export declare function decodeBuildIntent(reader: ByteReader): BuildIntent;
/**
 * Encode build commit for network transmission
 */
export declare function encodeBuildCommit(commit: BuildCommit): Uint8Array;
/**
 * Decode build commit from network data
 */
export declare function decodeBuildCommit(reader: ByteReader): BuildCommit;
/**
 * Encode multiple build commits for sync (reconnect scenario)
 */
export declare function encodeBuildSync(startSeq: number, commits: BuildCommit[]): Uint8Array;
/**
 * Decode build sync from network data
 */
export declare function decodeBuildSync(reader: ByteReader): BuildCommit[];
/**
 * Encode ACK_BUILD to request missed builds (Client -> Server)
 * Binary Layout:
 * ┌─────────────┬────────┬──────────────────────────────────────────┐
 * │ Byte Offset │ Type   │ Description                              │
 * ├─────────────┼────────┼──────────────────────────────────────────┤
 * │ 0           │ uint8  │ MSG_ACK_BUILD (0x04)                     │
 * │ 1-4         │ uint32 │ Last seen build sequence                 │
 * └─────────────┴────────┴──────────────────────────────────────────┘
 * Total: 5 bytes
 */
export declare function encodeAckBuild(lastSeenSeq: number): Uint8Array;
//# sourceMappingURL=build.d.ts.map