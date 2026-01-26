/**
 * Build log management
 */

import { Room } from './room.js';
import { BuildCommit, BuildIntent } from '@worldify/shared';

const MAX_BUILD_LOG_SIZE = 1000;

export function commitBuild(
  room: Room,
  playerId: number,
  intent: BuildIntent
): BuildCommit {
  room.buildSeq++;

  const commit: BuildCommit = {
    buildSeq: room.buildSeq,
    playerId,
    pieceType: intent.pieceType,
    gridX: intent.gridX,
    gridZ: intent.gridZ,
    rotation: intent.rotation,
  };

  // Append to log (ring buffer)
  if (room.buildLog.length >= MAX_BUILD_LOG_SIZE) {
    room.buildLog.shift();
  }
  room.buildLog.push(commit);

  return commit;
}

export function getBuildsSince(room: Room, fromSeq: number): BuildCommit[] {
  return room.buildLog.filter(
    (commit) => (commit as BuildCommit).buildSeq > fromSeq
  ) as BuildCommit[];
}
