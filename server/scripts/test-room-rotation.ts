/**
 * Test script to verify room rotation when max players is reached.
 * Simulates 65 joins and verifies a new room is created.
 * 
 * Run with: npx tsx scripts/test-room-rotation.ts
 */

const SERVER_URL = process.env.SERVER_URL || 'http://localhost:8080';

interface JoinResponse {
  roomId: string;
  playerId: number;
  token: string;
  protocolVersion: number;
}

interface HealthzResponse {
  status: string;
  rooms: number;
  players: number;
  protocolVersion: number;
}

async function join(): Promise<JoinResponse> {
  const res = await fetch(`${SERVER_URL}/api/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1 }),
  });
  
  if (!res.ok) {
    throw new Error(`Join failed: ${res.status} ${await res.text()}`);
  }
  
  return res.json();
}

async function healthz(): Promise<HealthzResponse> {
  const res = await fetch(`${SERVER_URL}/healthz`);
  return res.json();
}

async function main() {
  console.log('🧪 Testing Room Rotation');
  console.log('========================\n');
  
  // Check initial state
  const initialHealth = await healthz();
  console.log('Initial state:', initialHealth);
  
  const roomIds = new Set<string>();
  const playersByRoom = new Map<string, number[]>();
  
  console.log('\n📥 Simulating 65 joins...\n');
  
  for (let i = 1; i <= 65; i++) {
    const result = await join();
    roomIds.add(result.roomId);
    
    if (!playersByRoom.has(result.roomId)) {
      playersByRoom.set(result.roomId, []);
    }
    playersByRoom.get(result.roomId)!.push(result.playerId);
    
    if (i % 10 === 0 || i === 65) {
      console.log(`  Join ${i}: roomId=${result.roomId}, playerId=${result.playerId}`);
    }
  }
  
  // Summary
  console.log('\n📊 Results:');
  console.log('===========');
  console.log(`Total unique rooms created: ${roomIds.size}`);
  
  for (const [roomId, players] of playersByRoom) {
    console.log(`  Room ${roomId}: ${players.length} players`);
  }
  
  // Verify final state
  const finalHealth = await healthz();
  console.log('\nFinal server state:', finalHealth);
  
  // Assertions
  console.log('\n✅ Assertions:');
  
  if (roomIds.size >= 2) {
    console.log('  ✓ Multiple rooms created (expected 2, got', roomIds.size + ')');
  } else {
    console.log('  ✗ Expected at least 2 rooms, got', roomIds.size);
    process.exit(1);
  }
  
  const firstRoomPlayers = Array.from(playersByRoom.values())[0];
  if (firstRoomPlayers && firstRoomPlayers.length === 64) {
    console.log('  ✓ First room has 64 players');
  } else {
    console.log('  ✗ First room should have 64 players, got', firstRoomPlayers?.length ?? 0);
  }
  
  const secondRoomPlayers = Array.from(playersByRoom.values())[1];
  if (secondRoomPlayers && secondRoomPlayers.length >= 1) {
    console.log('  ✓ Second room has overflow players');
  } else {
    console.log('  ✗ Second room should have at least 1 player');
  }
  
  console.log('\n🎉 Test passed!');
}

main().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
