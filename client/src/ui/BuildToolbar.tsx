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
import { DEFAULT_BUILD_PRESETS, NONE_PRESET_ID, type BuildConfig, type Quat } from '@worldify/shared';
import { KeyInstructions, GAME_KEY_ROWS } from './KeyInstructions';
import { BuildMenu } from './BuildMenu';
import { usePresetThumbnail } from './usePresetThumbnail';
import { useIsTouch } from './useDeviceMode';


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
        relative flex items-center justify-center shrink-0 aspect-square
        w-11 h-11 md:w-24 md:h-24 rounded-xl md:rounded-2xl cursor-pointer transition-all
        bg-black/80
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
          className="w-9 h-9 md:w-[88px] md:h-[88px] object-contain"
          draggable={false}
        />
      ) : (
        <div className={`text-xl md:text-3xl ${isNone ? 'text-white/30' : 'text-white/90'}`}>
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
    <div className="flex items-center gap-1 md:gap-1.5">
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
  const setBuildPreset = useGameStore((s) => s.setBuildPreset);
  const isTouch = useIsTouch();

  return (
    <div
      className={`absolute left-1/2 -translate-x-1/2 max-w-[100vw] flex items-center gap-2 pointer-events-none ${
        isTouch ? 'top-2 flex-col-reverse' : 'bottom-4 flex-col'
      }`}
    >
      {/* Build menu: above the hotbar on desktop (bottom bar), below it on touch (top bar) */}
      <BuildMenu />

      {/* Scroll horizontally if the strip is wider than the viewport */}
      <div className="max-w-[100vw] overflow-x-auto px-2 pointer-events-auto">
        <HotbarStrip build={build} onSelect={setBuildPreset} />
      </div>

      {/* Hotkey hints (desktop only) */}
      {!isTouch && <KeyInstructions rows={GAME_KEY_ROWS} />}
    </div>
  );
}
