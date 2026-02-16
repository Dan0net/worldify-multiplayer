/**
 * Reusable key instruction hints shown at the bottom of the screen.
 * Used by BuildToolbar, SpectatorOverlay, and Landing.
 */

interface KeyGroup {
  keys: string[];
  label: string;
}

interface KeyInstructionsProps {
  /** Groups of key-label pairs to display, split into rows */
  rows: KeyGroup[][];
  className?: string;
}

/**
 * Renders rows of keyboard shortcut hints using a consistent visual style.
 * Each row contains groups of kbd-styled keys with a descriptive label.
 */
export function KeyInstructions({ rows, className = '' }: KeyInstructionsProps) {
  return (
    <div className={`flex flex-col items-center gap-1 ${className}`}>
      {rows.map((row, ri) => (
        <div key={ri} className="flex gap-4 text-white/60 text-xs flex-wrap justify-center">
          {row.map((group, gi) => (
            <span key={gi}>
              {group.keys.map((k, ki) => (
                <kbd key={ki} className={`px-1.5 py-0.5 bg-white/20 rounded${ki > 0 ? ' ml-0.5' : ''}`}>
                  {k}
                </kbd>
              ))}
              <span className="ml-1">{group.label}</span>
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Standard key instruction rows for in-game (movement + build + utility) */
export const GAME_KEY_ROWS: KeyGroup[][] = [
  [
    { keys: ['W', 'A', 'S', 'D'], label: 'Move' },
    { keys: ['Space'], label: 'Jump' },
    { keys: ['Shift'], label: 'Sprint' },
  ],
  [
    { keys: ['1-9'], label: 'Build tools' },
    { keys: ['Click'], label: 'Place' },
    { keys: ['Q', 'E'], label: 'Rotate' },
    { keys: ['Scroll'], label: 'Rotate' },
  ],
  [
    { keys: ['G'], label: 'Grid snap' },
    { keys: ['T'], label: 'Point snap' },
    { keys: ['Tab'], label: 'Build menu' },
    { keys: ['M'], label: 'Map' },
    { keys: ['Esc'], label: 'Menu' },
  ],
];
