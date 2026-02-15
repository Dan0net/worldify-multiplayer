/**
 * BuildToolbar - UI component showing build preset bar
 * 
 * Displays:
 * - All 10 build presets (0-9) in a horizontal bar
 * - Key number in each preset box
 * - Active preset highlighted
 * - Q/E rotate and click hints
 * 
 * Always visible when playing.
 */

import { useGameStore } from '../state/store';
import { DEFAULT_BUILD_PRESETS, BuildMode, GameMode } from '@worldify/shared';

/** Mode colors for visual distinction */
const MODE_COLORS: Record<BuildMode, string> = {
  [BuildMode.ADD]: 'bg-green-600/80',
  [BuildMode.SUBTRACT]: 'bg-red-600/80',
  [BuildMode.PAINT]: 'bg-blue-600/80',
  [BuildMode.FILL]: 'bg-yellow-600/80',
};

/** Shape icons (simple unicode shapes) */
const SHAPE_ICONS: Record<string, string> = {
  cube: '◼',
  sphere: '●',
  cylinder: '▮',
};

export function BuildToolbar() {
  const build = useGameStore((s) => s.build);
  const gameMode = useGameStore((s) => s.gameMode);

  // Hide when not playing
  if (gameMode !== GameMode.Playing) {
    return null;
  }

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-50">
      {/* Preset bar */}
      <div className="flex items-center gap-1 p-1.5 bg-black/75 rounded-2xl backdrop-blur-sm">
        {/* Reorder presets: 1-9 first, then 0 to match keyboard layout */}
        {[...DEFAULT_BUILD_PRESETS.slice(1), DEFAULT_BUILD_PRESETS[0]].map((preset) => {
          const isActive = build.presetId === preset.id;
          const mode = preset.config.mode;
          const modeColor = MODE_COLORS[mode] || 'bg-gray-600/80';
          const shapeIcon = SHAPE_ICONS[preset.config.shape] || '◼';
          const isNone = preset.id === 0;
          const keyLabel = preset.id === 0 ? '0' : `${preset.id}`;
          
          return (
            <div
              key={preset.id}
              className={`
                relative flex flex-col items-center justify-center
                w-14 h-14 rounded-xl cursor-pointer transition-all
                ${isActive 
                  ? 'ring-2 ring-cyan-400 shadow-lg shadow-cyan-400/30' 
                  : 'hover:bg-white/10'
                }
                ${isNone ? 'bg-white/5' : modeColor}
              `}
              title={preset.name}
            >
              {/* Key number badge */}
              <div className={`
                absolute -top-1 -left-1 w-5 h-5 rounded-md
                flex items-center justify-center
                text-xs font-bold
                ${isActive ? 'bg-cyan-400 text-black' : 'bg-white/20 text-white/80'}
              `}>
                {keyLabel}
              </div>
              
              {/* Shape icon or X for none */}
              <div className={`text-2xl ${isNone ? 'text-white/30' : 'text-white/90'}`}>
                {isNone ? '✕' : shapeIcon}
              </div>
              
              {/* Preset name (abbreviated) */}
              <div className="text-[9px] text-white/70 mt-0.5 truncate max-w-[52px]">
                {preset.name}
              </div>
            </div>
          );
        })}
      </div>

      {/* Hotkey hints */}
      <div className="flex gap-4 text-white/60 text-xs">
        <span>
          <kbd className="px-1.5 py-0.5 bg-white/20 rounded">Q</kbd>
          <kbd className="px-1.5 py-0.5 bg-white/20 rounded ml-0.5">E</kbd>
          <span className="ml-1">Rotate</span>
        </span>
        <span>
          <kbd className="px-1.5 py-0.5 bg-white/20 rounded">Click</kbd>
          <span className="ml-1">Place</span>
        </span>
      </div>
    </div>
  );
}
