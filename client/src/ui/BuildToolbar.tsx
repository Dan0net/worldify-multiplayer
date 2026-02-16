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
import type { BuildState } from '../state/store';
import { DEFAULT_BUILD_PRESETS, BuildMode, GameMode, NONE_PRESET_ID, MATERIAL_COLORS } from '@worldify/shared';
import { KeyInstructions, GAME_KEY_ROWS } from './KeyInstructions';
import { BuildMenu } from './BuildMenu';

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

/** Reusable hotbar strip — renders the 10 preset slots */
export function HotbarStrip({
  build,
  onSelect,
}: {
  build: BuildState;
  onSelect?: (presetId: number) => void;
}) {
  return (
    <div className="flex items-center gap-1 p-1.5 bg-black/75 rounded-2xl backdrop-blur-sm">
      {[...DEFAULT_BUILD_PRESETS.slice(1), DEFAULT_BUILD_PRESETS[0]].map((preset) => {
        const isActive = build.presetId === preset.id;
        const config = build.presetConfigs[preset.id];
        const mode = config.mode;
        const modeColor = MODE_COLORS[mode] || 'bg-gray-600/80';
        const shapeIcon = SHAPE_ICONS[config.shape] || '◼';
        const isNone = preset.id === NONE_PRESET_ID;
        const keyLabel = `${preset.id}`;
        const materialColor = MATERIAL_COLORS[config.material] ?? '#888';

        return (
          <div
            key={preset.id}
            onClick={() => onSelect?.(preset.id)}
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

            {/* Material color dot */}
            {!isNone && (
              <div
                className="absolute -top-1 -right-1 w-4 h-4 rounded-full border border-black/30"
                style={{ backgroundColor: materialColor }}
              />
            )}

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
  );
}

export function BuildToolbar() {
  const build = useGameStore((s) => s.build);
  const gameMode = useGameStore((s) => s.gameMode);

  // Hide when not playing
  if (gameMode !== GameMode.Playing) {
    return null;
  }

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-50">
      {/* Build menu pops up above the hotbar */}
      <BuildMenu />

      <HotbarStrip build={build} />

      {/* Hotkey hints */}
      <KeyInstructions rows={GAME_KEY_ROWS} />
    </div>
  );
}
