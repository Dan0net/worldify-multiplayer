import { useState } from 'react';
import { useGameStore } from '../state/store';

interface LandingProps {
  onJoin: () => void;
}

export function Landing({ onJoin }: LandingProps) {
  const connectionStatus = useGameStore((s) => s.connectionStatus);
  const [error, setError] = useState<string | null>(null);

  const isConnecting = connectionStatus === 'connecting';

  const handleJoin = async () => {
    setError(null);
    try {
      await onJoin();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to join');
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 100%)',
        color: '#fff',
        zIndex: 100,
      }}
    >
      <h1 style={{ fontSize: '3rem', marginBottom: '0.5rem' }}>Worldify</h1>
      <p style={{ fontSize: '1.2rem', opacity: 0.8, marginBottom: '2rem' }}>
        Rapid Survival
      </p>
      <button
        onClick={handleJoin}
        disabled={isConnecting}
        style={{
          padding: '1rem 3rem',
          fontSize: '1.2rem',
          background: isConnecting ? '#6b7280' : '#4f46e5',
          color: '#fff',
          border: 'none',
          borderRadius: '8px',
          cursor: isConnecting ? 'wait' : 'pointer',
          transition: 'transform 0.1s, background 0.2s',
          opacity: isConnecting ? 0.7 : 1,
        }}
        onMouseOver={(e) => !isConnecting && (e.currentTarget.style.background = '#6366f1')}
        onMouseOut={(e) => !isConnecting && (e.currentTarget.style.background = '#4f46e5')}
      >
        {isConnecting ? 'Connecting...' : 'Join Game'}
      </button>
      {error && (
        <p style={{ marginTop: '1rem', color: '#f87171', fontSize: '0.9rem' }}>
          {error}
        </p>
      )}
      <p
        style={{
          marginTop: '2rem',
          opacity: 0.5,
          fontSize: '0.9rem',
          maxWidth: '400px',
          textAlign: 'center',
        }}
      >
        Click to capture mouse • WASD to move • Space to jump • Shift to sprint
      </p>
    </div>
  );
}
