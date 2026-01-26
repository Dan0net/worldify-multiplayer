
import { useGameStore } from '../state/store';
import { BuildPieceType } from '@worldify/shared';

export function Hud() {
  const { playerCount, roomId, selectedTool, setSelectedTool } = useGameStore();

  const tools = [
    { type: BuildPieceType.FLOOR, label: 'Floor', key: '1' },
    { type: BuildPieceType.WALL, label: 'Wall', key: '2' },
    { type: BuildPieceType.SLOPE, label: 'Slope', key: '3' },
  ];

  return (
    <>
      {/* Crosshair */}
      <div
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width: '20px',
          height: '20px',
          pointerEvents: 'none',
          zIndex: 50,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: '2px',
            background: 'rgba(255, 255, 255, 0.8)',
            transform: 'translateY(-50%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            bottom: 0,
            width: '2px',
            background: 'rgba(255, 255, 255, 0.8)',
            transform: 'translateX(-50%)',
          }}
        />
      </div>

      {/* Tool selection bar */}
      <div
        style={{
          position: 'fixed',
          bottom: '20px',
          left: '50%',
          transform: 'translateX(-50%)',
          display: 'flex',
          gap: '10px',
          zIndex: 50,
        }}
      >
        {tools.map((tool) => (
          <button
            key={tool.type}
            onClick={() => setSelectedTool(tool.type)}
            style={{
              padding: '12px 24px',
              fontSize: '14px',
              background: selectedTool === tool.type ? '#4f46e5' : 'rgba(0,0,0,0.6)',
              color: '#fff',
              border: selectedTool === tool.type ? '2px solid #818cf8' : '2px solid transparent',
              borderRadius: '8px',
              cursor: 'pointer',
            }}
          >
            [{tool.key}] {tool.label}
          </button>
        ))}
      </div>

      {/* Room info */}
      <div
        style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          padding: '10px 15px',
          background: 'rgba(0,0,0,0.6)',
          color: '#fff',
          borderRadius: '8px',
          fontSize: '14px',
          zIndex: 50,
        }}
      >
        Room: {roomId || '...'} | Players: {playerCount}
      </div>
    </>
  );
}
