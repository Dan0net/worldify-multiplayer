/**
 * Hotbar — the build-item bar. Flush to the window bottom with rounded top corners.
 *
 * - Desktop: 10 slots (keys 1..9,0) + a build-menu button (badge 'E').
 * - Touch: the first 5 slots + the build-menu button.
 *
 * Slots read `build.presetMeta[index]` and select via `setBuildPreset`. Empty slots render blank.
 * On desktop, selection is normally by key (the pointer is locked during play); the bar doubles as
 * a key-hint + status display and is tappable on touch.
 */

import { Grid3x3 } from 'lucide-react';
import { slotIsEmpty } from '@worldify/shared';
import { useGameStore } from '../state/store';
import { useIsTouch } from './useDeviceMode';
import { usePresetThumbnail } from './usePresetThumbnail';
import { THUMB_PRIORITY } from './PresetThumbnailRenderer';
import { controls } from '../game/player/controls';

/** Vertical space (px) the bar occupies on touch — MobileControls reserves this in portrait. */
export const HOTBAR_TOUCH_HEIGHT = 72;

/** Slot / menu-button sizing (≈20% larger than the original w-11 / w-14). */
const SLOT_SIZE = 'w-[52px] h-[52px] md:w-[68px] md:h-[68px]';

// Display order in key order: keys 1..9,0 map to slot indices 1..9,0.
const DESKTOP_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 0];
const MOBILE_ORDER = [1, 2, 3, 4, 5];

function HotbarSlot({ index }: { index: number }) {
  const meta = useGameStore((s) => s.build.presetMeta[index]);
  const active = useGameStore((s) => s.build.presetId === index);
  const setBuildPreset = useGameStore((s) => s.setBuildPreset);
  const empty = slotIsEmpty(meta);
  const thumb = usePresetThumbnail(empty ? undefined : meta?.parts, meta?.baseRotation, {
    priority: THUMB_PRIORITY.HIGH,
  });
  const keyLabel = index === 0 ? '0' : String(index);

  return (
    <button
      type="button"
      onPointerDown={(e) => { e.preventDefault(); setBuildPreset(index); }}
      className={`relative pointer-events-auto shrink-0 aspect-square ${SLOT_SIZE} rounded-lg bg-black/60 overflow-hidden border transition-colors ${
        active ? 'border-cyan-400 ring-2 ring-cyan-400/50' : 'border-white/20'
      }`}
      aria-label={empty ? `Slot ${keyLabel} (empty)` : `${meta?.templateName} (${keyLabel})`}
    >
      <span className="absolute top-0.5 left-1 text-[10px] leading-none text-white/70 pointer-events-none">
        {keyLabel}
      </span>
      {!empty && thumb && (
        <img src={thumb} alt="" draggable={false} className="w-full h-full object-contain p-1" />
      )}
    </button>
  );
}

export function Hotbar() {
  const isTouch = useIsTouch();
  const order = isTouch ? MOBILE_ORDER : DESKTOP_ORDER;

  return (
    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 z-50 pointer-events-none">
      <div className="flex items-end gap-1 md:gap-1.5 p-1 rounded-t-xl bg-black/70 backdrop-blur-sm border-x border-t border-white/10">
        {order.map((i) => <HotbarSlot key={i} index={i} />)}
        {/* Build-menu button — rightmost item. Badge 'E' on desktop (the key that opens it). */}
        <button
          type="button"
          onPointerDown={(e) => { e.preventDefault(); controls.toggleBuildMenu(); }}
          className={`relative pointer-events-auto shrink-0 aspect-square ${SLOT_SIZE} rounded-lg bg-black/60 border border-white/20 flex items-center justify-center text-white/90`}
          aria-label="Build menu"
        >
          <Grid3x3 className="w-5 h-5 md:w-6 md:h-6" />
          {!isTouch && (
            <span className="absolute top-0.5 left-1 text-[10px] leading-none text-white/70 pointer-events-none">
              E
            </span>
          )}
        </button>
      </div>
    </div>
  );
}
