/**
 * Spectator overlay - shown when player first joins
 * Shows a "Start" button to enter FPS mode
 */

import { useGameStore } from '../state/store';
import { controls } from '../game/player/controls';

export function SpectatorOverlay() {
  const isSpectating = useGameStore((s) => s.isSpectating);
  const playerCount = useGameStore((s) => s.playerCount);
  const roomId = useGameStore((s) => s.roomId);

  if (!isSpectating) {
    return null;
  }

  const handleStart = () => {
    // Switch to FPS mode
    useGameStore.getState().setIsSpectating(false);
    // Lock pointer for FPS controls
    controls.requestPointerLock();
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
        background: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.3) 100%)',
        zIndex: 50,
        pointerEvents: 'none',
      }}
    >
      {/* Room info at top */}
      <div
        style={{
          position: 'absolute',
          top: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '12px 24px',
          background: 'rgba(0, 0, 0, 0.7)',
          borderRadius: '8px',
          color: '#fff',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: '0.9rem', opacity: 0.7, marginBottom: '4px' }}>
          Room: {roomId}
        </div>
        <div style={{ fontSize: '1.1rem' }}>
          {playerCount} player{playerCount !== 1 ? 's' : ''} in game
        </div>
      </div>

      {/* Start button */}
      <button
        onClick={handleStart}
        style={{
          padding: '1.5rem 4rem',
          fontSize: '1.5rem',
          background: '#4f46e5',
          color: '#fff',
          border: 'none',
          borderRadius: '12px',
          cursor: 'pointer',
          pointerEvents: 'auto',
          boxShadow: '0 4px 20px rgba(79, 70, 229, 0.5)',
          transition: 'transform 0.1s, background 0.2s',
        }}
        onMouseOver={(e) => {
          e.currentTarget.style.background = '#6366f1';
          e.currentTarget.style.transform = 'scale(1.05)';
        }}
        onMouseOut={(e) => {
          e.currentTarget.style.background = '#4f46e5';
          e.currentTarget.style.transform = 'scale(1)';
        }}
      >
        ▶ Start
      </button>

      {/* Controls hint */}
      <p
        style={{
          marginTop: '2rem',
          color: '#fff',
          opacity: 0.7,
          fontSize: '0.95rem',
          textAlign: 'center',
          maxWidth: '400px',
        }}
      >
        WASD to move • Space to jump • Shift to sprint<br />
        1/2/3 for build tools • Click to place • Q/E to rotate
      </p>
    </div>
  );
}
