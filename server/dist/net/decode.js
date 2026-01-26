/**
 * Binary message decoding (client -> server)
 */
import { MSG_JOIN, MSG_INPUT, MSG_BUILD_INTENT, MSG_ACK_BUILD, MSG_PING, ByteReader, decodeInput, decodeBuildIntent, } from '@worldify/shared';
import { roomManager } from '../rooms/roomManager.js';
import { encodePong, encodeBuildSync, encodeBuildCommit } from './encode.js';
import { commitBuild, getBuildsSince } from '../rooms/buildLog.js';
import { broadcast } from '../ws/wsServer.js';
export function decodeMessage(roomId, playerId, data) {
    if (data.length === 0)
        return;
    const reader = new ByteReader(data);
    const msgId = reader.readUint8();
    switch (msgId) {
        case MSG_JOIN:
            handleJoin(roomId, playerId, reader);
            break;
        case MSG_INPUT:
            handleInput(roomId, playerId, reader);
            break;
        case MSG_BUILD_INTENT:
            handleBuildIntent(roomId, playerId, reader);
            break;
        case MSG_ACK_BUILD:
            handleAckBuild(roomId, playerId, reader);
            break;
        case MSG_PING:
            handlePing(roomId, playerId, reader);
            break;
        default:
            console.warn(`[decode] Unknown message ID: ${msgId}`);
    }
}
function handleJoin(_roomId, playerId, reader) {
    const protocolVersion = reader.readUint8();
    const clientPlayerId = reader.readUint16();
    console.log(`[join] Player ${playerId} joined with version ${protocolVersion}, claimed ID ${clientPlayerId}`);
}
function handleInput(roomId, playerId, reader) {
    const input = decodeInput(reader);
    // Update player state in room
    const room = roomManager.getRoom(roomId);
    if (!room)
        return;
    const player = room.players.get(playerId);
    if (!player)
        return;
    // Only accept newer inputs (seq can wrap around)
    const seqDiff = (input.seq - player.lastInputSeq + 65536) % 65536;
    if (seqDiff > 32768) {
        // Old input, ignore
        return;
    }
    // Update player look direction and buttons
    player.yaw = input.yaw;
    player.pitch = input.pitch;
    player.buttons = input.buttons;
    player.lastInputSeq = input.seq;
    player.lastInputTime = Date.now();
}
function handleBuildIntent(roomId, playerId, reader) {
    const intent = decodeBuildIntent(reader);
    const room = roomManager.getRoom(roomId);
    if (!room)
        return;
    // Validate placement (basic bounds check)
    if (intent.gridX < 0 || intent.gridX >= 128 || intent.gridZ < 0 || intent.gridZ >= 128) {
        console.warn(`[build] Invalid placement from player ${playerId}: (${intent.gridX}, ${intent.gridZ})`);
        return;
    }
    // Validate rotation
    if (intent.rotation < 0 || intent.rotation > 3) {
        console.warn(`[build] Invalid rotation from player ${playerId}: ${intent.rotation}`);
        return;
    }
    // Commit the build
    const commit = commitBuild(room, playerId, intent);
    // Broadcast BUILD_COMMIT to all clients in room
    const commitData = encodeBuildCommit(commit);
    broadcast(roomId, commitData);
    console.log(`[build] Player ${playerId} placed ${intent.pieceType} at (${intent.gridX}, ${intent.gridZ}), seq=${commit.buildSeq}`);
}
function handleAckBuild(roomId, playerId, reader) {
    // Client reports its last seen build sequence
    const lastSeenSeq = reader.readUint32();
    const room = roomManager.getRoom(roomId);
    if (!room)
        return;
    // Get builds the client hasn't seen yet
    const missedBuilds = getBuildsSince(room, lastSeenSeq);
    if (missedBuilds.length === 0) {
        return; // Client is up to date
    }
    // Send BUILD_SYNC with all missed builds
    const ws = room.connections.get(playerId);
    if (ws) {
        const startSeq = missedBuilds[0].buildSeq;
        const syncData = encodeBuildSync(startSeq, missedBuilds);
        ws.send(syncData);
        console.log(`[build] Sent BUILD_SYNC to player ${playerId}: ${missedBuilds.length} builds from seq ${startSeq}`);
    }
}
function handlePing(roomId, playerId, reader) {
    const timestamp = reader.readUint32();
    // Send pong back to this player
    const room = roomManager.getRoom(roomId);
    if (!room)
        return;
    const ws = room.connections.get(playerId);
    if (ws) {
        ws.send(encodePong(timestamp));
    }
}
//# sourceMappingURL=decode.js.map