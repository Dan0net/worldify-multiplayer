/**
 * Room tick logic
 * Server tick runs at SERVER_TICK_HZ (physics/game logic)
 * Snapshots broadcast at SNAPSHOT_HZ (network sync)
 */
import { WebSocket } from 'ws';
import { SERVER_TICK_HZ, SNAPSHOT_HZ, INPUT_FORWARD, INPUT_BACKWARD, INPUT_LEFT, INPUT_RIGHT, INPUT_SPRINT, FLAG_GROUNDED, FLAG_SPRINTING, } from '@worldify/shared';
import { encodeSnapshot } from '../net/encode.js';
const TICK_INTERVAL_MS = 1000 / SERVER_TICK_HZ;
const SNAPSHOT_INTERVAL_MS = 1000 / SNAPSHOT_HZ;
// Movement constants
const MOVE_SPEED = 5.0; // meters per second
const SPRINT_MULTIPLIER = 1.6;
export function startRoomTick(room) {
    // Start game tick
    room.tickInterval = setInterval(() => {
        tick(room);
    }, TICK_INTERVAL_MS);
    // Start snapshot broadcast (separate from game tick for flexibility)
    room.snapshotInterval = setInterval(() => {
        broadcastSnapshot(room);
    }, SNAPSHOT_INTERVAL_MS);
    console.log(`[room ${room.id}] Started ticks (${SERVER_TICK_HZ}Hz) and snapshots (${SNAPSHOT_HZ}Hz)`);
}
export function stopRoomTick(room) {
    if (room.tickInterval) {
        clearInterval(room.tickInterval);
        room.tickInterval = null;
    }
    if (room.snapshotInterval) {
        clearInterval(room.snapshotInterval);
        room.snapshotInterval = null;
    }
    console.log(`[room ${room.id}] Stopped ticks`);
}
function tick(room) {
    room.tick++;
    const dt = 1 / SERVER_TICK_HZ;
    // Process each player's movement based on their last input
    for (const player of room.players.values()) {
        processPlayerMovement(player, dt);
    }
    // TODO: apply consume wave logic
    // TODO: check territory conditions
}
function processPlayerMovement(player, dt) {
    const buttons = player.buttons;
    // Calculate movement direction relative to player yaw
    let moveX = 0;
    let moveZ = 0;
    if (buttons & INPUT_FORWARD)
        moveZ -= 1;
    if (buttons & INPUT_BACKWARD)
        moveZ += 1;
    if (buttons & INPUT_LEFT)
        moveX -= 1;
    if (buttons & INPUT_RIGHT)
        moveX += 1;
    // Normalize diagonal movement
    const length = Math.sqrt(moveX * moveX + moveZ * moveZ);
    if (length > 0) {
        moveX /= length;
        moveZ /= length;
        // Rotate by player yaw
        const cos = Math.cos(player.yaw);
        const sin = Math.sin(player.yaw);
        const worldX = moveX * cos - moveZ * sin;
        const worldZ = moveX * sin + moveZ * cos;
        // Apply speed
        let speed = MOVE_SPEED;
        if (buttons & INPUT_SPRINT) {
            speed *= SPRINT_MULTIPLIER;
            player.flags |= FLAG_SPRINTING;
        }
        else {
            player.flags &= ~FLAG_SPRINTING;
        }
        player.x += worldX * speed * dt;
        player.z += worldZ * speed * dt;
    }
    // Keep player grounded for now (no jump/gravity yet)
    player.y = 1.8;
    player.flags |= FLAG_GROUNDED;
}
function broadcastSnapshot(room) {
    if (room.connections.size === 0)
        return;
    // Build player snapshot array
    const players = [];
    for (const player of room.players.values()) {
        players.push({
            playerId: player.playerId,
            x: player.x,
            y: player.y,
            z: player.z,
            yaw: player.yaw,
            pitch: player.pitch,
            buttons: player.buttons,
            flags: player.flags,
        });
    }
    const snapshotData = encodeSnapshot({ tick: room.tick, players });
    // Broadcast to all connected players
    for (const ws of room.connections.values()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(snapshotData);
        }
    }
}
//# sourceMappingURL=roomTick.js.map