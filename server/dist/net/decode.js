/**
 * Binary message decoding (client -> server)
 */
import { MSG_JOIN, MSG_INPUT, MSG_BUILD_INTENT, MSG_PING, ByteReader, decodeInput, decodeBuildIntent, } from '@worldify/shared';
import { roomManager } from '../rooms/roomManager.js';
import { encodePong } from './encode.js';
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
    // TODO: validate placement and commit build
    const room = roomManager.getRoom(roomId);
    if (!room)
        return;
    console.log(`[build] Player ${playerId} wants to place ${intent.pieceType} at (${intent.gridX}, ${intent.gridZ})`);
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