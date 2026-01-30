/**
 * Message registry pattern for server-side message handling.
 * Replaces switch statements with a handler map for extensibility.
 */

import { ByteReader } from '@worldify/shared';

/** Handler function signature for incoming client messages */
export type MessageHandler = (roomId: string, playerId: number, reader: ByteReader) => void;

/** Registry of message handlers keyed by message ID */
const handlers = new Map<number, MessageHandler>();

/**
 * Register a handler for a specific message ID.
 * @param msgId - The message ID (client->server: 0x01-0x7F)
 * @param handler - Function to handle the decoded message
 */
export function registerHandler(msgId: number, handler: MessageHandler): void {
  if (handlers.has(msgId)) {
    console.warn(`[MessageRegistry] Overwriting handler for message ID 0x${msgId.toString(16)}`);
  }
  handlers.set(msgId, handler);
}

/**
 * Dispatch an incoming binary message to its registered handler.
 * @param roomId - The room the message came from
 * @param playerId - The player who sent the message
 * @param data - Raw binary message from client
 */
export function dispatch(roomId: string, playerId: number, data: Uint8Array): void {
  if (data.length === 0) return;

  const reader = new ByteReader(data);
  const msgId = reader.readUint8();

  const handler = handlers.get(msgId);
  if (handler) {
    handler(roomId, playerId, reader);
  } else {
    console.warn(`[MessageRegistry] Unknown message ID: 0x${msgId.toString(16)}`);
  }
}

/**
 * Check if a handler is registered for a message ID.
 * Useful for debugging.
 */
export function hasHandler(msgId: number): boolean {
  return handlers.has(msgId);
}

/**
 * Get the number of registered handlers.
 * Useful for debugging.
 */
export function getHandlerCount(): number {
  return handlers.size;
}
