import { Room } from './room.js';
import type { WebSocket } from 'ws';
interface PendingJoin {
    roomId: string;
    playerId: number;
    timestamp: number;
}
declare class RoomManager {
    private rooms;
    private currentRoomId;
    private pendingJoins;
    private nextPlayerId;
    constructor();
    assignPlayer(): {
        roomId: string;
        playerId: number;
        token: string;
    };
    validateToken(token: string): PendingJoin | null;
    addConnection(roomId: string, playerId: number, ws: WebSocket): void;
    removePlayer(roomId: string, playerId: number): void;
    getRoom(roomId: string): Room | undefined;
    getStats(): {
        roomCount: number;
        playerCount: number;
    };
    private createNewRoom;
    private cleanup;
    private generateRoomId;
    private generateToken;
}
export declare const roomManager: RoomManager;
export {};
//# sourceMappingURL=roomManager.d.ts.map