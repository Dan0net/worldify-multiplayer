import { useState, useEffect } from 'react';
import { useGameStore } from '../state/store';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080';

interface RoomInfo {
  currentRoomId: string | null;
  rooms: Array<{ id: string; playerCount: number }>;
}

interface LandingProps {
  onJoin: () => void;
}

export function Landing({ onJoin }: LandingProps) {
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const [error, setError] = useState<string | null>(null);
  const [roomInfo, setRoomInfo] = useState<RoomInfo | null>(null);

  const isConnecting = connectionStatus === 'connecting';

  // Fetch room info on mount and poll every 2 seconds
  useEffect(() => {
    const fetchRooms = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/rooms`);
        if (res.ok) {
          const data = await res.json();
          setRoomInfo(data);
        }
      } catch {
        // Silently ignore fetch errors
      }
    };

    fetchRooms();
    const interval = setInterval(fetchRooms, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleJoin = async () => {
    setError(null);
    try {
      await onJoin();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to join');
    }
  };

  return (
    <div className="fixed inset-0 flex flex-col items-center justify-center bg-gradient-to-br from-[#1a1a2e] to-[#16213e] text-white z-[100]">
      <h1 className="text-5xl mb-2">wrldy</h1>
      <p className="text-xl opacity-80 mb-4">
        Rapid Survival
      </p>

      {/* Room info display */}
      <div className="mb-6 py-4 px-8 bg-white/10 rounded-lg text-center min-w-[200px]">
        {roomInfo ? (
          <>
            <div className="text-sm opacity-70 mb-2">
              {roomInfo.currentRoomId ? 'Current Room' : 'No Active Room'}
            </div>
            {roomInfo.currentRoomId && (
              <>
                <div className="text-lg font-mono mb-2">
                  {roomInfo.currentRoomId}
                </div>
                <div className="text-base">
                  {roomInfo.rooms.find(r => r.id === roomInfo.currentRoomId)?.playerCount || 0} player(s) online
                </div>
              </>
            )}
            {!roomInfo.currentRoomId && (
              <div className="text-sm opacity-80">
                A new room will be created when you join
              </div>
            )}
          </>
        ) : (
          <div className="text-sm opacity-50">Loading...</div>
        )}
      </div>

      <button
        onClick={handleJoin}
        disabled={isConnecting}
        className={`py-4 px-12 text-xl text-white border-none rounded-lg transition-all duration-100 ${
          isConnecting
            ? 'bg-gray-500 cursor-wait opacity-70'
            : 'bg-indigo-600 cursor-pointer hover:bg-indigo-500'
        }`}
      >
        {isConnecting ? 'Connecting...' : 'Join Game'}
      </button>
      {error && (
        <p className="mt-4 text-red-400 text-sm">
          {error}
        </p>
      )}
      <p className="mt-8 opacity-50 text-sm max-w-md text-center">
        Click to capture mouse • WASD to move • Space to jump • Shift to sprint
      </p>
    </div>
  );
}
