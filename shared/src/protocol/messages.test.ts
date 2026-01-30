import { describe, it, expect } from 'vitest';
import { ByteReader } from '../util/bytes.js';
import {
  encodeJoin, decodeJoin,
  encodePing, decodePing,
  encodeWelcome, decodeWelcome,
  encodeRoomInfo, decodeRoomInfo,
  encodePong, decodePong,
  encodeError, decodeError,
} from './messages.js';
import {
  MSG_JOIN, MSG_PING, MSG_WELCOME, MSG_ROOM_INFO, MSG_PONG, MSG_ERROR,
} from './msgIds.js';

describe('Protocol messages', () => {
  it('round-trips JOIN message', () => {
    const protocolVersion = 1;
    const playerId = 42;
    const encoded = encodeJoin(protocolVersion, playerId);
    
    expect(encoded[0]).toBe(MSG_JOIN);
    
    const reader = new ByteReader(encoded.buffer);
    reader.readUint8(); // skip msgId
    const decoded = decodeJoin(reader);
    expect(decoded.protocolVersion).toBe(protocolVersion);
    expect(decoded.playerId).toBe(playerId);
  });

  it('round-trips PING message', () => {
    const timestamp = 1234567; // Fits in uint32
    const encoded = encodePing(timestamp);
    
    expect(encoded[0]).toBe(MSG_PING);
    
    const reader = new ByteReader(encoded.buffer);
    reader.readUint8();
    const decoded = decodePing(reader);
    expect(decoded.timestamp).toBe(timestamp);
  });

  it('round-trips WELCOME message', () => {
    const playerId = 42;
    const roomId = 'room123';
    const encoded = encodeWelcome(playerId, roomId);
    
    expect(encoded[0]).toBe(MSG_WELCOME);
    
    const reader = new ByteReader(encoded.buffer);
    reader.readUint8();
    const decoded = decodeWelcome(reader);
    expect(decoded.playerId).toBe(playerId);
    expect(decoded.roomId).toBe(roomId);
  });

  it('round-trips ROOM_INFO message', () => {
    const playerCount = 16;
    const encoded = encodeRoomInfo(playerCount);
    
    expect(encoded[0]).toBe(MSG_ROOM_INFO);
    
    const reader = new ByteReader(encoded.buffer);
    reader.readUint8();
    const decoded = decodeRoomInfo(reader);
    expect(decoded.playerCount).toBe(playerCount);
  });

  it('round-trips PONG message', () => {
    const timestamp = 987654; // Fits in uint32
    const encoded = encodePong(timestamp);
    
    expect(encoded[0]).toBe(MSG_PONG);
    
    const reader = new ByteReader(encoded.buffer);
    reader.readUint8();
    const decoded = decodePong(reader);
    expect(decoded.timestamp).toBe(timestamp);
  });

  it('round-trips ERROR message', () => {
    const errorCode = 5;
    const encoded = encodeError(errorCode);
    
    expect(encoded[0]).toBe(MSG_ERROR);
    
    const reader = new ByteReader(encoded.buffer);
    reader.readUint8();
    const decoded = decodeError(reader);
    expect(decoded.errorCode).toBe(errorCode);
  });

  it('uses ByteWriter/ByteReader consistently across messages', () => {
    // Test multiple message types are self-contained
    const join = encodeJoin(1, 100);
    const ping = encodePing(12345);
    const welcome = encodeWelcome(99, 'testroom');

    // Each message is self-contained with msgId prefix
    expect(join[0]).toBe(MSG_JOIN);
    expect(ping[0]).toBe(MSG_PING);
    expect(welcome[0]).toBe(MSG_WELCOME);
  });
});
