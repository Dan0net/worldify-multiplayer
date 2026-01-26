/**
 * Build log management
 */
const MAX_BUILD_LOG_SIZE = 1000;
export function commitBuild(room, playerId, intent) {
    room.buildSeq++;
    const commit = {
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
export function getBuildsSince(room, fromSeq) {
    return room.buildLog.filter((commit) => commit.buildSeq > fromSeq);
}
//# sourceMappingURL=buildLog.js.map