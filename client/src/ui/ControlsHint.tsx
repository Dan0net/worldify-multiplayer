/**
 * ControlsHint — a row of small control pills along the bottom of the screen,
 * shown only on desktop while playing. Mirrors the real key bindings in controls.ts.
 */

import { useGameStore } from '../state/store';

const HINTS: { keys: string; label: string }[] = [
  { keys: 'WASD', label: 'Move' },
  { keys: 'Space', label: 'Jump' },
  { keys: 'Shift', label: 'Sprint' },
  { keys: 'RMB / R', label: 'Build mode' },
  { keys: 'LMB', label: 'Place / Punch' },
  { keys: 'E / Tab', label: 'Build menu' },
  { keys: 'Q / Wheel', label: 'Rotate' },
  { keys: 'G / T', label: 'Snap' },
  { keys: '1–0', label: 'Select' },
  { keys: 'Z', label: 'Undo' },
  { keys: 'Esc', label: 'Exit' },
];

export function ControlsHint() {
  // Fade + rise in together with the hotbar once the first-person camera intro completes.
  const ready = useGameStore((s) => s.firstPersonReady);
  return (
    // Sits above the hotbar (which is flush to the bottom).
    <div className={`absolute bottom-20 left-1/2 -translate-x-1/2 flex flex-wrap justify-center gap-2 text-xs text-white/70 select-none transition-all duration-500 ease-out ${ready ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-6'}`}>
      {HINTS.map((h) => (
        <span key={h.keys} className="flex items-center gap-1.5 bg-black/40 border border-white/10 rounded-lg px-2 py-1 backdrop-blur-sm">
          <kbd className="font-semibold text-white/90 font-mono">{h.keys}</kbd>
          <span>{h.label}</span>
        </span>
      ))}
    </div>
  );
}
