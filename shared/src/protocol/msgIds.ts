/**
 * Message IDs for binary protocol
 * Client -> Server: 0x01 - 0x7F
 * Server -> Client: 0x80 - 0xFF
 */

// Client -> Server
export const MSG_JOIN = 0x01;
export const MSG_INPUT = 0x02;
export const MSG_BUILD_INTENT = 0x03;
export const MSG_ACK_BUILD = 0x04;
export const MSG_PING = 0x05;

// Server -> Client
export const MSG_WELCOME = 0x80;
export const MSG_ROOM_INFO = 0x81;
export const MSG_SNAPSHOT = 0x82;
export const MSG_BUILD_COMMIT = 0x83;
export const MSG_BUILD_SYNC = 0x84;
export const MSG_ERROR = 0x85;
export const MSG_PONG = 0x86;
