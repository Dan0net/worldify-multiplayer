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

import { ByteReader, ByteWriter } from '../util/bytes.js';
import { MSG_BUILD_INTENT, MSG_BUILD_COMMIT, MSG_BUILD_SYNC, MSG_ACK_BUILD } from './msgIds.js';

export enum BuildPieceType {
  FLOOR = 0,
  WALL = 1,
  SLOPE = 2,
}

export interface BuildIntent {
  pieceType: BuildPieceType;
  gridX: number;
  gridZ: number;
  rotation: number; // 0-3 (90 degree increments)
}

export interface BuildCommit {
  buildSeq: number;
  playerId: number;
  pieceType: BuildPieceType;
  gridX: number;
  gridZ: number;
  rotation: number;
}

// Bytes per commit in BUILD_SYNC (without buildSeq, as it's sequential)
export const BUILD_COMMIT_SYNC_BYTES = 8;

/**
 * Encode build intent for network transmission
 */
export function encodeBuildIntent(intent: BuildIntent): Uint8Array {
  const writer = new ByteWriter(7);
  writer.writeUint8(MSG_BUILD_INTENT);
  writer.writeUint8(intent.pieceType);
  writer.writeUint16(intent.gridX);
  writer.writeUint16(intent.gridZ);
  writer.writeUint8(intent.rotation);
  return writer.toUint8Array();
}

/**
 * Decode build intent from network data
 */
export function decodeBuildIntent(reader: ByteReader): BuildIntent {
  return {
    pieceType: reader.readUint8() as BuildPieceType,
    gridX: reader.readUint16(),
    gridZ: reader.readUint16(),
    rotation: reader.readUint8(),
  };
}

/**
 * Encode build commit for network transmission
 */
export function encodeBuildCommit(commit: BuildCommit): Uint8Array {
  const writer = new ByteWriter(13);
  writer.writeUint8(MSG_BUILD_COMMIT);
  writer.writeUint32(commit.buildSeq);
  writer.writeUint16(commit.playerId);
  writer.writeUint8(commit.pieceType);
  writer.writeUint16(commit.gridX);
  writer.writeUint16(commit.gridZ);
  writer.writeUint8(commit.rotation);
  return writer.toUint8Array();
}

/**
 * Decode build commit from network data
 */
export function decodeBuildCommit(reader: ByteReader): BuildCommit {
  return {
    buildSeq: reader.readUint32(),
    playerId: reader.readUint16(),
    pieceType: reader.readUint8() as BuildPieceType,
    gridX: reader.readUint16(),
    gridZ: reader.readUint16(),
    rotation: reader.readUint8(),
  };
}

/**
 * Encode multiple build commits for sync (reconnect scenario)
 */
export function encodeBuildSync(startSeq: number, commits: BuildCommit[]): Uint8Array {
  const writer = new ByteWriter(7 + commits.length * BUILD_COMMIT_SYNC_BYTES);
  writer.writeUint8(MSG_BUILD_SYNC);
  writer.writeUint32(startSeq);
  writer.writeUint16(commits.length);
  
  for (const c of commits) {
    writer.writeUint16(c.playerId);
    writer.writeUint8(c.pieceType);
    writer.writeUint16(c.gridX);
    writer.writeUint16(c.gridZ);
    writer.writeUint8(c.rotation);
  }
  
  return writer.toUint8Array();
}

/**
 * Decode build sync from network data
 */
export function decodeBuildSync(reader: ByteReader): BuildCommit[] {
  const startSeq = reader.readUint32();
  const count = reader.readUint16();
  const commits: BuildCommit[] = [];
  
  for (let i = 0; i < count; i++) {
    commits.push({
      buildSeq: startSeq + i,
      playerId: reader.readUint16(),
      pieceType: reader.readUint8() as BuildPieceType,
      gridX: reader.readUint16(),
      gridZ: reader.readUint16(),
      rotation: reader.readUint8(),
    });
  }
  
  return commits;
}

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
export function encodeAckBuild(lastSeenSeq: number): Uint8Array {
  const writer = new ByteWriter(5);
  writer.writeUint8(MSG_ACK_BUILD);
  writer.writeUint32(lastSeenSeq);
  return writer.toUint8Array();
}
