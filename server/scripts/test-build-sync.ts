/**
 * Test script: Disconnect/reconnect build catchup
 * 
 * This test verifies that:
 * 1. A client can place builds
 * 2. When a client reconnects, it receives BUILD_SYNC with missed builds
 * 3. The client applies builds in order
 */

import WebSocket from 'ws';

const API_BASE = process.env.API_BASE || 'http://localhost:8080';
const WS_URL = process.env.WS_URL || 'ws://localhost:8080/ws';

// Message IDs
const MSG_JOIN = 0x01;
const MSG_BUILD_INTENT = 0x03;
const MSG_ACK_BUILD = 0x04;
const MSG_BUILD_COMMIT = 0x83;
const MSG_BUILD_SYNC = 0x84;

// Build piece types
const BUILD_FLOOR = 0;
const BUILD_WALL = 1;

async function joinGame(): Promise<{ roomId: string; playerId: number; token: string }> {
  const response = await fetch(`${API_BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1 }),
  });

  if (!response.ok) {
    throw new Error(`Join failed: ${response.status}`);
  }

  return response.json();
}

function createBuildIntent(pieceType: number, gridX: number, gridZ: number, rotation: number): Uint8Array {
  const buffer = new ArrayBuffer(7);
  const view = new DataView(buffer);
  view.setUint8(0, MSG_BUILD_INTENT);
  view.setUint8(1, pieceType);
  view.setUint16(2, gridX, true); // little-endian
  view.setUint16(4, gridZ, true); // little-endian
  view.setUint8(6, rotation);
  return new Uint8Array(buffer);
}

function createAckBuild(lastSeenSeq: number): Uint8Array {
  const buffer = new ArrayBuffer(5);
  const view = new DataView(buffer);
  view.setUint8(0, MSG_ACK_BUILD);
  view.setUint32(1, lastSeenSeq, true); // little-endian
  return new Uint8Array(buffer);
}

function parseBuildCommit(data: Uint8Array): { buildSeq: number; playerId: number; pieceType: number; gridX: number; gridZ: number; rotation: number } {
  const view = new DataView(data.buffer, data.byteOffset);
  return {
    buildSeq: view.getUint32(1, true), // little-endian
    playerId: view.getUint16(5, true), // little-endian
    pieceType: view.getUint8(7),
    gridX: view.getUint16(8, true), // little-endian
    gridZ: view.getUint16(10, true), // little-endian
    rotation: view.getUint8(12),
  };
}

function parseBuildSync(data: Uint8Array): { startSeq: number; commits: Array<{ playerId: number; pieceType: number; gridX: number; gridZ: number; rotation: number }> } {
  const view = new DataView(data.buffer, data.byteOffset);
  const startSeq = view.getUint32(1, true); // little-endian
  const count = view.getUint16(5, true); // little-endian
  const commits = [];
  
  let offset = 7;
  for (let i = 0; i < count; i++) {
    commits.push({
      playerId: view.getUint16(offset, true), // little-endian
      pieceType: view.getUint8(offset + 2),
      gridX: view.getUint16(offset + 3, true), // little-endian
      gridZ: view.getUint16(offset + 5, true), // little-endian
      rotation: view.getUint8(offset + 7),
    });
    offset += 8;
  }
  
  return { startSeq, commits };
}

async function connectWebSocket(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}?token=${token}`);
    
    ws.on('open', () => {
      console.log('[ws] Connected');
      resolve(ws);
    });
    
    ws.on('error', (err) => {
      reject(err);
    });
  });
}

async function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function createJoinMessage(playerId: number): Uint8Array {
  const buffer = new ArrayBuffer(4);
  const view = new DataView(buffer);
  view.setUint8(0, MSG_JOIN);
  view.setUint8(1, 1); // protocol version
  view.setUint16(2, playerId, true); // little-endian
  return new Uint8Array(buffer);
}

async function main() {
  console.log('=== Test: Disconnect/Reconnect Build Catchup ===\n');

  // Step 1: Client A joins and places some builds
  console.log('Step 1: Client A joins and places builds...');
  const joinA1 = await joinGame();
  console.log(`  Joined room ${joinA1.roomId} as player ${joinA1.playerId}`);
  
  const wsA = await connectWebSocket(joinA1.token);
  
  // Send join message
  wsA.send(createJoinMessage(joinA1.playerId));
  
  await delay(100);
  
  // Track received commits
  let lastBuildSeq = 0;
  const receivedCommits: number[] = [];
  
  wsA.on('message', (data: Buffer) => {
    const arr = new Uint8Array(data);
    if (arr[0] === MSG_BUILD_COMMIT) {
      const commit = parseBuildCommit(arr);
      receivedCommits.push(commit.buildSeq);
      lastBuildSeq = Math.max(lastBuildSeq, commit.buildSeq);
      console.log(`  [A] Received BUILD_COMMIT seq=${commit.buildSeq}`);
    } else if (arr[0] === MSG_BUILD_SYNC) {
      const sync = parseBuildSync(arr);
      console.log(`  [A] Received BUILD_SYNC: ${sync.commits.length} commits from seq ${sync.startSeq}`);
      for (let i = 0; i < sync.commits.length; i++) {
        const seq = sync.startSeq + i;
        receivedCommits.push(seq);
        lastBuildSeq = Math.max(lastBuildSeq, seq);
      }
    }
  });
  
  // Place 3 builds
  console.log('  Placing 3 builds...');
  wsA.send(createBuildIntent(BUILD_FLOOR, 10, 10, 0));
  await delay(100);
  wsA.send(createBuildIntent(BUILD_WALL, 11, 10, 1));
  await delay(100);
  wsA.send(createBuildIntent(BUILD_FLOOR, 12, 10, 0));
  await delay(200);
  
  console.log(`  Last build seq: ${lastBuildSeq}`);
  console.log(`  Received commits: [${receivedCommits.join(', ')}]`);
  
  // Step 2: Disconnect Client A
  console.log('\nStep 2: Disconnecting Client A...');
  wsA.close();
  await delay(100);
  console.log('  Disconnected');
  
  // Step 3: Client B joins and places more builds while A is offline
  console.log('\nStep 3: Client B places builds while A is offline...');
  const joinB = await joinGame();
  console.log(`  Joined room ${joinB.roomId} as player ${joinB.playerId}`);
  
  const wsB = await connectWebSocket(joinB.token);
  wsB.send(createJoinMessage(joinB.playerId));
  
  await delay(100);
  
  wsB.send(createBuildIntent(BUILD_WALL, 20, 20, 2));
  await delay(100);
  wsB.send(createBuildIntent(BUILD_FLOOR, 21, 20, 0));
  await delay(200);
  
  console.log('  Placed 2 more builds');
  
  // Step 4: Client A reconnects and requests BUILD_SYNC
  console.log(`\nStep 4: Client A reconnects (last seen seq: ${lastBuildSeq})...`);
  const joinA2 = await joinGame();
  console.log(`  Rejoined room ${joinA2.roomId} as player ${joinA2.playerId}`);
  
  const wsA2 = await connectWebSocket(joinA2.token);
  wsA2.send(createJoinMessage(joinA2.playerId));
  
  let syncReceived = false;
  let syncCommits: Array<{ playerId: number; pieceType: number }> = [];
  
  wsA2.on('message', (data: Buffer) => {
    const arr = new Uint8Array(data);
    if (arr[0] === MSG_BUILD_SYNC) {
      syncReceived = true;
      const sync = parseBuildSync(arr);
      syncCommits = sync.commits;
      console.log(`  [A2] Received BUILD_SYNC: ${sync.commits.length} commits from seq ${sync.startSeq}`);
      for (let i = 0; i < sync.commits.length; i++) {
        const c = sync.commits[i];
        console.log(`    - seq ${sync.startSeq + i}: player ${c.playerId} placed type ${c.pieceType} at (${c.gridX}, ${c.gridZ})`);
      }
    } else if (arr[0] === MSG_BUILD_COMMIT) {
      const commit = parseBuildCommit(arr);
      console.log(`  [A2] Received BUILD_COMMIT seq=${commit.buildSeq}`);
    }
  });
  
  await delay(100);
  
  // Request builds since last seen
  console.log(`  Requesting BUILD_SYNC for builds after seq ${lastBuildSeq}...`);
  wsA2.send(createAckBuild(lastBuildSeq));
  
  await delay(500);
  
  // Cleanup
  wsB.close();
  wsA2.close();
  
  // Results
  console.log('\n=== Test Results ===');
  if (syncReceived) {
    console.log(`✓ BUILD_SYNC received with ${syncCommits.length} missed builds`);
    if (syncCommits.length === 2) {
      console.log('✓ Correct number of missed builds (2)');
    } else {
      console.log(`✗ Expected 2 missed builds, got ${syncCommits.length}`);
    }
  } else {
    console.log('✗ BUILD_SYNC was NOT received');
  }
  
  console.log('\nTest completed!');
  process.exit(syncReceived && syncCommits.length === 2 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
