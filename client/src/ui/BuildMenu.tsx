/**
 * BuildMenu - Full-screen overlay for build configuration
 *
 * Opens on Tab key or right-click while playing.
 * Bottom hotbar: Select which preset slot to configure
 * Material palette: Assign a material to the selected preset
 *
 * Closes on Tab, right-click, or Escape.
 */

import { useCallback } from 'react';
import { useGameStore } from '../state/store';
import {
  NONE_PRESET_ID,
  MATERIAL_NAMES,
  MATERIAL_COLORS,
  GameMode,
  type MaterialName,
} from '@worldify/shared';
import { useMaterialThumbnails } from './useMaterialThumbnails';

// ============== Constants ==============

/** Format material name for display */
function formatName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\d+$/, m => ` ${m}`);
}

// ============== Sub-components ==============

/** Material swatch in the grid */
function MaterialSwatch({
  name,
  color,
  thumbnailUrl,
  isActive,
  onSelect,
}: {
  name: MaterialName;
  color: string;
  thumbnailUrl?: string;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`
        group relative w-10 h-10 rounded-lg border-2 transition-all overflow-hidden
        ${isActive
          ? 'border-cyan-400 shadow-lg shadow-cyan-400/30 scale-110 z-10'
          : 'border-transparent hover:border-white/40 hover:scale-105'
        }
      `}
      style={{ backgroundColor: color }}
      title={formatName(name)}
    >
      {thumbnailUrl && (
        <img
          src={thumbnailUrl}
          alt={name}
          className="absolute inset-0 w-full h-full object-cover"
          draggable={false}
        />
      )}
      {/* Tooltip on hover */}
      <div className="
        absolute -top-8 left-1/2 -translate-x-1/2 
        px-2 py-0.5 bg-black/90 rounded text-xs text-white/90 whitespace-nowrap
        opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-20
      ">
        {formatName(name)}
      </div>
    </button>
  );
}

// ============== Main Component ==============

export function BuildMenu() {
  const build = useGameStore((s) => s.build);
  const gameMode = useGameStore((s) => s.gameMode);
  const setBuildMenuOpen = useGameStore((s) => s.setBuildMenuOpen);
  const updatePresetConfig = useGameStore((s) => s.updatePresetConfig);

  const { presetId, menuOpen, presetConfigs } = build;

  // Current preset's material
  const currentConfig = presetConfigs[presetId];
  const currentMaterial = currentConfig?.material ?? 0;
  const isNonePreset = presetId === NONE_PRESET_ID;

  // Material texture thumbnails (loaded once from albedo.bin)
  const thumbnails = useMaterialThumbnails();

  const handleClose = useCallback(() => {
    setBuildMenuOpen(false);
    // Re-lock pointer after a tiny delay (browser requirement)
    requestAnimationFrame(() => {
      document.body.requestPointerLock();
    });
  }, [setBuildMenuOpen]);

  const handleSelectMaterial = useCallback((materialId: number) => {
    if (!isNonePreset) {
      updatePresetConfig(presetId, { material: materialId });
    }
  }, [presetId, isNonePreset, updatePresetConfig]);

  // Prevent context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  // Only show when playing and menu is open
  if (gameMode !== GameMode.Playing || !menuOpen) {
    return null;
  }

  return (
    <>
      {/* Invisible backdrop to catch outside clicks */}
      <div
        className="fixed inset-0 z-[99]"
        onMouseDown={handleClose}
        onContextMenu={handleContextMenu}
      />

      {/* Menu panel — same width as hotbar, sits directly above it */}
      <div
        className="relative z-[100] w-full flex flex-col max-h-[60vh] bg-black/75 border border-white/10 rounded-2xl overflow-hidden backdrop-blur-sm"
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={handleContextMenu}
      >
        {/* Materials section */}
        <div className="flex flex-col gap-2 p-5 flex-1 min-h-0">
          <h2 className="text-sm font-semibold text-white/60 uppercase tracking-wider">
            Materials
          </h2>

          {isNonePreset ? (
            <div className="flex items-center justify-center h-32 text-white/40 text-sm">
              Select a build tool to change its material
            </div>
          ) : (
            <div className="overflow-y-auto pr-1 scrollbar-thin">
              <div className="grid grid-cols-10 gap-1.5">
                {MATERIAL_NAMES.map((name, id) => (
                  <MaterialSwatch
                    key={id}
                    name={name}
                    color={MATERIAL_COLORS[id] ?? '#888'}
                    thumbnailUrl={thumbnails?.[id]}
                    isActive={currentMaterial === id}
                    onSelect={() => handleSelectMaterial(id)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Current material info */}
          {!isNonePreset && (
            <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/10">
              <div
                className="w-8 h-8 rounded border border-white/20 overflow-hidden"
                style={{ backgroundColor: MATERIAL_COLORS[currentMaterial] ?? '#888' }}
              >
                {thumbnails?.[currentMaterial] && (
                  <img src={thumbnails[currentMaterial]} alt="" className="w-full h-full object-cover" />
                )}
              </div>
              <div>
                <div className="text-sm text-white/80">
                  {formatName(MATERIAL_NAMES[currentMaterial] ?? 'unknown')}
                </div>
                <div className="text-xs text-white/40">Material #{currentMaterial}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
