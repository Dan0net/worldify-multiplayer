/**
 * BuildToolbar - UI component showing current build mode and preset
 * 
 * Displays:
 * - Current preset name and key
 * - Build mode (ADD/SUBTRACT/PAINT/FILL)
 * - Current rotation
 * - Hotkey hints
 * 
 * Hides when preset 0 (None) is selected.
 */

import { useGameStore } from '../state/store';
import { getPreset, BUILD_ROTATION_STEP, BuildMode } from '@worldify/shared';

/** Mode colors for visual distinction */
const MODE_COLORS: Record<BuildMode, string> = {
  [BuildMode.ADD]: 'bg-green-600',
  [BuildMode.SUBTRACT]: 'bg-red-600',
  [BuildMode.PAINT]: 'bg-blue-600',
  [BuildMode.FILL]: 'bg-yellow-600',
};

/** Mode labels */
const MODE_LABELS: Record<BuildMode, string> = {
  [BuildMode.ADD]: 'ADD',
  [BuildMode.SUBTRACT]: 'DIG',
  [BuildMode.PAINT]: 'PAINT',
  [BuildMode.FILL]: 'FILL',
};

export function BuildToolbar() {
  const build = useGameStore((s) => s.build);
  const isSpectating = useGameStore((s) => s.isSpectating);

  // Hide when spectating or build mode disabled (preset 0)
  if (isSpectating || build.presetId === 0) {
    return null;
  }

  const preset = getPreset(build.presetId);
  const rotationDegrees = build.rotationSteps * BUILD_ROTATION_STEP;
  const mode = preset.config.mode;
  const modeColor = MODE_COLORS[mode] || 'bg-gray-600';
  const modeLabel = MODE_LABELS[mode] || mode.toUpperCase();

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 z-50">
      {/* Main toolbar */}
      <div className="flex items-center gap-3 py-2 px-4 bg-black/70 rounded-lg backdrop-blur-sm">
        {/* Preset key indicator */}
        <div className="flex items-center justify-center w-8 h-8 bg-white/20 rounded text-white font-bold text-lg">
          {build.presetId}
        </div>

        {/* Preset name */}
        <div className="text-white font-medium min-w-[80px]">
          {preset.name}
        </div>

        {/* Mode badge */}
        <div className={`px-2 py-1 rounded text-white text-xs font-bold ${modeColor}`}>
          {modeLabel}
        </div>

        {/* Rotation indicator */}
        <div className="flex items-center gap-1 text-white/80 text-sm">
          <span className="text-lg">↻</span>
          <span>{rotationDegrees}°</span>
        </div>

        {/* Valid target indicator */}
        <div className={`w-2 h-2 rounded-full ${build.hasValidTarget ? 'bg-green-500' : 'bg-red-500'}`} 
             title={build.hasValidTarget ? 'Valid target' : 'No target'} />
      </div>

      {/* Hotkey hints */}
      <div className="flex gap-4 text-white/60 text-xs">
        <span><kbd className="px-1 bg-white/20 rounded">1-9</kbd> Tool</span>
        <span><kbd className="px-1 bg-white/20 rounded">0</kbd> Disable</span>
        <span><kbd className="px-1 bg-white/20 rounded">Q</kbd><kbd className="px-1 bg-white/20 rounded">E</kbd> Rotate</span>
        <span><kbd className="px-1 bg-white/20 rounded">Click</kbd> Place</span>
      </div>
    </div>
  );
}
