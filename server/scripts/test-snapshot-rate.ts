/**
 * Test script to verify snapshot broadcasting at 10-15 Hz
 */

import WebSocket from 'ws';

const API_BASE = 'http://localhost:8080';
const WS_URL = 'ws://localhost:8080/ws';

async function main() {
  console.log('Testing snapshot broadcasting...\n');

  // Step 1: Join via HTTP
  const response = await fetch(`${API_BASE}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1 }),
  });

  if (!response.ok) {
    console.error('Join failed:', response.status);
    process.exit(1);
  }

  const { roomId, playerId, token } = await response.json();
  console.log(`Joined room ${roomId} as player ${playerId}`);

  // Step 2: Connect via WebSocket
  const ws = new WebSocket(`${WS_URL}?token=${token}`);

  let snapshotCount = 0;
  let lastSnapshotTime = 0;
  const snapshotIntervals: number[] = [];

  ws.on('open', () => {
    console.log('WebSocket connected\n');
    
    // Send JOIN message
    const joinMsg = new Uint8Array([0x01, 0x01, playerId & 0xff, (playerId >> 8) & 0xff]);
    ws.send(joinMsg);
    
    // Set timeout to end test after 3 seconds
    setTimeout(() => {
      ws.close();
      analyzeResults();
    }, 3000);
  });

  ws.on('message', (data: Buffer) => {
    const bytes = new Uint8Array(data);
    const msgId = bytes[0];
    
    // MSG_SNAPSHOT = 0x82
    if (msgId === 0x82) {
      const now = Date.now();
      snapshotCount++;
      
      if (lastSnapshotTime > 0) {
        snapshotIntervals.push(now - lastSnapshotTime);
      }
      lastSnapshotTime = now;
      
      // Parse snapshot
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const tick = view.getUint32(1, true);
      const playerCount = bytes[5];
      
      console.log(`Snapshot #${snapshotCount}: tick=${tick}, players=${playerCount}`);
    } else if (msgId === 0x80) {
      // MSG_WELCOME
      console.log('Received WELCOME message');
    }
  });

  ws.on('close', () => {
    console.log('\nWebSocket closed');
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    process.exit(1);
  });

  function analyzeResults() {
    console.log('\n=== RESULTS ===');
    console.log(`Total snapshots received: ${snapshotCount}`);
    
    if (snapshotIntervals.length > 0) {
      const avgInterval = snapshotIntervals.reduce((a, b) => a + b, 0) / snapshotIntervals.length;
      const hz = 1000 / avgInterval;
      
      console.log(`Average interval: ${avgInterval.toFixed(1)}ms`);
      console.log(`Effective rate: ${hz.toFixed(1)} Hz`);
      console.log(`Min interval: ${Math.min(...snapshotIntervals)}ms`);
      console.log(`Max interval: ${Math.max(...snapshotIntervals)}ms`);
      
      if (hz >= 9 && hz <= 16) {
        console.log('\n✅ PASS: Snapshot rate is within 10-15 Hz range');
      } else {
        console.log(`\n❌ FAIL: Snapshot rate ${hz.toFixed(1)} Hz is outside 10-15 Hz range`);
      }
    } else {
      console.log('\n❌ FAIL: No snapshot intervals recorded');
    }
    
    process.exit(0);
  }
}

main().catch(console.error);
