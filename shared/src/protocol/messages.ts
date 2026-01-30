/**
 * Message encoding/decoding for all protocol messages
 * 
 * This file contains encode/decode functions for messages that aren't
 * part of the core game state (movement, snapshot, build).
 * 
 * Client → Server:
 * - MSG_JOIN: Player joining a room
 * - MSG_PING: Latency measurement
 * 
 * Server → Client:
 * - MSG_WELCOME: Room assignment confirmation
 * - MSG_ROOM_INFO: Player count update
 * - MSG_PONG: Ping response
 * - MSG_ERROR: Error notification
 */

import { ByteWriter, ByteReader } from '../util/bytes.js';
import {
  MSG_JOIN,
  MSG_PING,
  MSG_WELCOME,
  MSG_ROOM_INFO,
  MSG_PONG,
  MSG_ERROR,
} from './msgIds.js';

// ============== Client → Server ==============

/**
 * Encode JOIN message
 * Sent after HTTP join to establish WebSocket connection
 */
export function encodeJoin(protocolVersion: number, playerId: number): Uint8Array {
  const writer = new ByteWriter(8);
  writer.writeUint8(MSG_JOIN);
  writer.writeUint8(protocolVersion);
  writer.writeUint16(playerId);
  return writer.toUint8Array();
}

/**
 * Decode JOIN message
 */
export function decodeJoin(reader: ByteReader): { protocolVersion: number; playerId: number } {
  return {
    protocolVersion: reader.readUint8(),
    playerId: reader.readUint16(),
  };
}

/**
 * Encode PING message with timestamp
 */
export function encodePing(timestamp: number): Uint8Array {
  const writer = new ByteWriter(8);
  writer.writeUint8(MSG_PING);
  writer.writeUint32(timestamp);
  return writer.toUint8Array();
}

/**
 * Decode PING message
 */
export function decodePing(reader: ByteReader): { timestamp: number } {
  return {
    timestamp: reader.readUint32(),
  };
}

// ============== Server → Client ==============

/**
 * Encode WELCOME message
 * Confirms room assignment to client
 */
export function encodeWelcome(playerId: number, roomId: string): Uint8Array {
  const writer = new ByteWriter(16);
  writer.writeUint8(MSG_WELCOME);
  writer.writeUint16(playerId);
  // Write room ID as fixed 8 bytes (pad with zeros)
  for (let i = 0; i < 8; i++) {
    writer.writeUint8(roomId.charCodeAt(i) || 0);
  }
  return writer.toUint8Array();
}

/**
 * Decode WELCOME message
 */
export function decodeWelcome(reader: ByteReader): { playerId: number; roomId: string } {
  const playerId = reader.readUint16();
  const roomBytes: number[] = [];
  for (let i = 0; i < 8; i++) {
    const byte = reader.readUint8();
    if (byte !== 0) roomBytes.push(byte);
  }
  const roomId = String.fromCharCode(...roomBytes);
  return { playerId, roomId };
}

/**
 * Encode ROOM_INFO message
 */
export function encodeRoomInfo(playerCount: number): Uint8Array {
  const writer = new ByteWriter(4);
  writer.writeUint8(MSG_ROOM_INFO);
  writer.writeUint8(playerCount);
  return writer.toUint8Array();
}

/**
 * Decode ROOM_INFO message
 */
export function decodeRoomInfo(reader: ByteReader): { playerCount: number } {
  return {
    playerCount: reader.readUint8(),
  };
}

/**
 * Encode PONG message (echoes client timestamp)
 */
export function encodePong(timestamp: number): Uint8Array {
  const writer = new ByteWriter(8);
  writer.writeUint8(MSG_PONG);
  writer.writeUint32(timestamp);
  return writer.toUint8Array();
}

/**
 * Decode PONG message
 */
export function decodePong(reader: ByteReader): { timestamp: number } {
  return {
    timestamp: reader.readUint32(),
  };
}

/**
 * Encode ERROR message
 */
export function encodeError(errorCode: number): Uint8Array {
  const writer = new ByteWriter(4);
  writer.writeUint8(MSG_ERROR);
  writer.writeUint8(errorCode);
  return writer.toUint8Array();
}

/**
 * Decode ERROR message
 */
export function decodeError(reader: ByteReader): { errorCode: number } {
  return {
    errorCode: reader.readUint8(),
  };
}
