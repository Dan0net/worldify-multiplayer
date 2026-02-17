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
import { DEFAULT_BUILD_PRESETS, GameMode, NONE_PRESET_ID, type BuildConfig, type Quat } from '@worldify/shared';
import { KeyInstructions, GAME_KEY_ROWS } from './KeyInstructions';
import { BuildMenu } from './BuildMenu';
import { usePresetThumbnail } from './usePresetThumbnail';


/** Single hotbar slot — uses hook for thumbnail */
function HotbarSlot({
  presetId,
  config,
  rotation,
  isActive,
  isNone,
  onSelect,
}: {
  presetId: number;
  config: BuildConfig;
  rotation?: Quat;
  isActive: boolean;
  isNone: boolean;
  onSelect?: () => void;
}) {
  const thumbnailUrl = usePresetThumbnail(isNone ? undefined : config, rotation);
  const keyLabel = `${presetId}`;

  return (
    <div
      onClick={onSelect}
      className={`
        relative flex items-center justify-center
        w-24 h-24 rounded-2xl cursor-pointer transition-all
        bg-black/60 backdrop-blur-sm
        ${isActive
          ? 'ring-2 ring-cyan-400 shadow-lg shadow-cyan-400/30'
          : 'hover:bg-white/10'
        }
      `}
    >
      {/* Key number badge */}
      <div className={`
        absolute top-1 left-1.5 z-10
        text-xs font-bold drop-shadow-md
        ${isActive ? 'text-cyan-400' : 'text-white/70'}
      `}>
        {keyLabel}
      </div>

      {/* Thumbnail or fallback */}
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          className="w-[88px] h-[88px] object-contain"
          draggable={false}
        />
      ) : (
        <div className={`text-3xl ${isNone ? 'text-white/30' : 'text-white/90'}`}>
          {isNone ? '✕' : '◼'}
        </div>
      )}
    </div>
  );
}

/** Reusable hotbar strip — renders the 10 preset slots */
export function HotbarStrip({
  build,
  onSelect,
}: {
  build: BuildState;
  onSelect?: (presetId: number) => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      {[...DEFAULT_BUILD_PRESETS.slice(1), DEFAULT_BUILD_PRESETS[0]].map((preset) => {
        const config = build.presetConfigs[preset.id];
        const meta = build.presetMeta[preset.id];
        const isNone = preset.id === NONE_PRESET_ID;
        return (
          <HotbarSlot
            key={preset.id}
            presetId={preset.id}
            config={config}
            rotation={meta?.baseRotation}
            isActive={build.presetId === preset.id}
            isNone={isNone}
            onSelect={() => onSelect?.(preset.id)}
          />
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
