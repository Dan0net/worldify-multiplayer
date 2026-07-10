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

/** Reusable hotbar strip — renders the preset slots (optionally limited) */
export function HotbarStrip({
  build,
  onSelect,
  limit,
}: {
  build: BuildState;
  onSelect?: (presetId: number) => void;
  /** Max slots to show; always keeps the None slot as the last item. */
  limit?: number;
}) {
  const ordered = [...DEFAULT_BUILD_PRESETS.slice(1), DEFAULT_BUILD_PRESETS[0]];
  const items = limit && limit < ordered.length
    ? [...ordered.slice(0, limit - 1), ordered[ordered.length - 1]]
    : ordered;
  return (
    <div className="flex items-center gap-1 md:gap-1.5" data-testid="hotbar">
      {items.map((preset) => {
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
      className={`absolute left-1/2 -translate-x-1/2 max-w-[100vw] flex flex-col items-center gap-2 pointer-events-none ${
        isTouch ? 'bottom-2' : 'bottom-4'
      }`}
    >
      {/* Build menu pops up above the hotbar */}
      <BuildMenu />

      {/* On touch: 5 slots, no scroll. On desktop: full strip, scroll if needed. */}
      <div className={`max-w-[100vw] px-2 pointer-events-auto ${isTouch ? '' : 'overflow-x-auto'}`}>
        <HotbarStrip build={build} onSelect={setBuildPreset} limit={isTouch ? 5 : undefined} />
      </div>

      {/* Hotkey hints (desktop only) */}
      {!isTouch && <KeyInstructions rows={GAME_KEY_ROWS} />}
    </div>
  );
}
