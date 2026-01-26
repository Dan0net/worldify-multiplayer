/**
 * Test script to verify WebSocket connections work.
 * Simulates two browsers joining and verifies they both connect.
 * 
 * Run with: npx tsx scripts/test-ws-connection.ts
 */

import WebSocket from 'ws';

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';
const WS_URL = process.env.WS_URL || 'ws://localhost:8080/ws';

interface JoinResponse {
  roomId: string;
  playerId: number;
  token: string;
}

async function join(): Promise<JoinResponse> {
  const res = await fetch(`${SERVER_URL}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1 }),
  });
  return res.json();
}

async function connectPlayer(name: string): Promise<{ ws: WebSocket; joinData: JoinResponse }> {
  const joinData = await join();
  console.log(`[${name}] Got join response:`, joinData);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${joinData.token}`);

    ws.on('open', () => {
      console.log(`[${name}] WebSocket connected`);
    });

    ws.on('message', (data: Buffer) => {
      const msgId = data[0];
      if (msgId === 0x80) { // MSG_WELCOME
        const playerId = data.readUInt16LE(1);
        const roomId = data.slice(3, 11).toString('utf8').replace(/\0/g, '');
        console.log(`[${name}] Received welcome: playerId=${playerId}, roomId=${roomId}`);
        resolve({ ws, joinData });
      }
    });

    ws.on('error', (err) => {
      console.error(`[${name}] WebSocket error:`, err);
      reject(err);
    });

    ws.on('close', (code, reason) => {
      console.log(`[${name}] WebSocket closed: code=${code}, reason=${reason.toString()}`);
    });

    setTimeout(() => reject(new Error('Connection timeout')), 5000);
  });
}

async function main() {
  console.log('🧪 Testing WebSocket Connections');
  console.log('================================\n');

  try {
    // Connect first player
    console.log('Connecting Player 1...');
    const player1 = await connectPlayer('Player1');

    // Connect second player
    console.log('Connecting Player 2...');
    const player2 = await connectPlayer('Player2');

    // Verify both connected to same room
    console.log('\n📊 Results:');
    console.log('===========');
    console.log(`Player 1 room: ${player1.joinData.roomId}`);
    console.log(`Player 2 room: ${player2.joinData.roomId}`);

    if (player1.joinData.roomId === player2.joinData.roomId) {
      console.log('\n✅ Both players are in the same room!');
    } else {
      console.log('\n⚠️ Players are in different rooms');
    }

    // Fetch room info from healthz
    const healthRes = await fetch(`${SERVER_URL}/healthz`);
    const health = await healthRes.json();
    console.log('\nServer state:', health);

    // Cleanup
    player1.ws.close();
    player2.ws.close();

    console.log('\n🎉 Test passed!');
  } catch (err) {
    console.error('Test failed:', err);
    process.exit(1);
  }
}

main();
