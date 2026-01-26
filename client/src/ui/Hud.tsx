
import { useGameStore } from '../state/store';
import { BuildPieceType } from '@worldify/shared';

export function Hud() {
  const { playerCount, roomId, selectedTool, setSelectedTool, isSpectating } = useGameStore();

  // Hide HUD when spectating
  if (isSpectating) {
    return null;
  }

  const tools = [
    { type: BuildPieceType.FLOOR, label: 'Floor', key: '1' },
    { type: BuildPieceType.WALL, label: 'Wall', key: '2' },
    { type: BuildPieceType.SLOPE, label: 'Slope', key: '3' },
  ];

  return (
    <>
      {/* Crosshair */}
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 pointer-events-none z-50">
        <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-white/80 -translate-y-1/2" />
        <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-white/80 -translate-x-1/2" />
      </div>

      {/* Tool selection bar */}
      <div className="fixed bottom-5 left-1/2 -translate-x-1/2 flex gap-2.5 z-50">
        {tools.map((tool) => (
          <button
            key={tool.type}
            onClick={() => setSelectedTool(tool.type)}
            className={`py-3 px-6 text-sm text-white rounded-lg cursor-pointer border-2 ${
              selectedTool === tool.type
                ? 'bg-indigo-600 border-indigo-400'
                : 'bg-black/60 border-transparent'
            }`}
          >
            [{tool.key}] {tool.label}
          </button>
        ))}
      </div>

      {/* Room info */}
      <div className="fixed top-5 right-5 py-2.5 px-4 bg-black/60 text-white rounded-lg text-sm z-50">
        Room: {roomId || '...'} | Players: {playerCount}
      </div>
    </>
  );
}
