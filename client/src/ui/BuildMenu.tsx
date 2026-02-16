/**
 * BuildMenu - Full-screen overlay for build configuration
 *
 * Opens on Tab key or right-click while playing.
 * Two sections:
 * - Preset templates: Select a build preset (wall, floor, stairs, etc.) for the active slot
 * - Materials: Assign a material to the selected preset
 *
 * Closes on Tab, right-click, or Escape.
 */

import { useCallback, useState } from 'react';
import { useGameStore } from '../state/store';
import {
  NONE_PRESET_ID,
  MATERIAL_NAMES,
  MATERIAL_COLORS,
  GameMode,
  PRESET_TEMPLATES,
  PresetCategory,
  BuildMode,
  type MaterialName,
} from '@worldify/shared';
import { useMaterialThumbnails } from './useMaterialThumbnails';

// ============== Constants ==============

/** Format material name for display */
function formatName(name: string): string {
  return name.replace(/_/g, ' ').replace(/\d+$/, m => ` ${m}`);
}

/** Mode badge colors */
const MODE_BADGE_COLORS: Record<BuildMode, string> = {
  [BuildMode.ADD]: 'bg-green-600',
  [BuildMode.SUBTRACT]: 'bg-red-600',
  [BuildMode.PAINT]: 'bg-blue-600',
  [BuildMode.FILL]: 'bg-yellow-600',
};

/** Shape unicode icons */
const SHAPE_ICONS: Record<string, string> = {
  cube: '◼',
  sphere: '●',
  cylinder: '▮',
  prism: '◣',
};

/** All categories in display order */
const CATEGORIES = [
  PresetCategory.WALLS,
  PresetCategory.FLOORS,
  PresetCategory.STAIRS,
  PresetCategory.STRUCTURAL,
  PresetCategory.TERRAIN,
];

/** Menu tab */
type MenuTab = 'presets' | 'materials';

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

/** Preset template button */
function PresetButton({
  name,
  mode,
  shape,
  isActive,
  onSelect,
}: {
  name: string;
  mode: BuildMode;
  shape: string;
  isActive: boolean;
  onSelect: () => void;
}) {
  const modeColor = MODE_BADGE_COLORS[mode] || 'bg-gray-600';
  const icon = SHAPE_ICONS[shape] || '◼';

  return (
    <button
      onClick={onSelect}
      className={`
        group relative flex items-center gap-2 px-3 py-2 rounded-lg border transition-all text-left
        ${isActive
          ? 'border-cyan-400 bg-cyan-400/15 shadow-lg shadow-cyan-400/20'
          : 'border-white/10 bg-white/5 hover:border-white/30 hover:bg-white/10'
        }
      `}
      title={name}
    >
      {/* Mode color indicator */}
      <div className={`w-2 h-2 rounded-full ${modeColor} shrink-0`} />
      {/* Shape icon */}
      <span className="text-sm text-white/70">{icon}</span>
      {/* Name */}
      <span className={`text-sm truncate ${isActive ? 'text-white' : 'text-white/80'}`}>
        {name}
      </span>
    </button>
  );
}

// ============== Main Component ==============

export function BuildMenu() {
  const build = useGameStore((s) => s.build);
  const gameMode = useGameStore((s) => s.gameMode);
  const setBuildMenuOpen = useGameStore((s) => s.setBuildMenuOpen);
  const updatePresetConfig = useGameStore((s) => s.updatePresetConfig);
  const applyPresetTemplate = useGameStore((s) => s.applyPresetTemplate);

  const { presetId, menuOpen, presetConfigs, presetMeta } = build;

  // Current preset's config and meta
  const currentConfig = presetConfigs[presetId];
  const currentMeta = presetMeta[presetId];
  const currentMaterial = currentConfig?.material ?? 0;
  const isNonePreset = presetId === NONE_PRESET_ID;
  const currentTemplateName = currentMeta?.templateName ?? '';

  // Tab state
  const [activeTab, setActiveTab] = useState<MenuTab>('presets');

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

  const handleSelectTemplate = useCallback((templateIndex: number) => {
    if (!isNonePreset) {
      applyPresetTemplate(presetId, templateIndex);
    }
  }, [presetId, isNonePreset, applyPresetTemplate]);

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
        {/* Tab bar */}
        <div className="flex border-b border-white/10 shrink-0">
          <button
            onClick={() => setActiveTab('presets')}
            className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors
              ${activeTab === 'presets'
                ? 'text-cyan-400 border-b-2 border-cyan-400'
                : 'text-white/50 hover:text-white/70'
              }`}
          >
            Presets
          </button>
          <button
            onClick={() => setActiveTab('materials')}
            className={`flex-1 px-4 py-2.5 text-sm font-medium transition-colors
              ${activeTab === 'materials'
                ? 'text-cyan-400 border-b-2 border-cyan-400'
                : 'text-white/50 hover:text-white/70'
              }`}
          >
            Materials
          </button>
        </div>

        <div className="flex flex-col gap-2 p-4 flex-1 min-h-0">
          {isNonePreset ? (
            <div className="flex items-center justify-center h-32 text-white/40 text-sm">
              Select a build slot (keys 2-9, 0) to configure it
            </div>
          ) : activeTab === 'presets' ? (
            /* ---- Presets Tab ---- */
            <div className="overflow-y-auto pr-1 scrollbar-thin">
              {CATEGORIES.map((category) => {
                const templates = PRESET_TEMPLATES
                  .map((t, idx) => ({ ...t, idx }))
                  .filter((t) => t.category === category);
                if (templates.length === 0) return null;

                return (
                  <div key={category} className="mb-3">
                    <h3 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-1.5">
                      {category}
                    </h3>
                    <div className="grid grid-cols-3 gap-1.5">
                      {templates.map((t) => (
                        <PresetButton
                          key={t.idx}
                          name={t.name}
                          mode={t.config.mode}
                          shape={t.config.shape}
                          isActive={currentTemplateName === t.name}
                          onSelect={() => handleSelectTemplate(t.idx)}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            /* ---- Materials Tab ---- */
            <>
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

              {/* Current material info */}
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
            </>
          )}

          {/* Current slot summary */}
          {!isNonePreset && (
            <div className="flex items-center gap-2 pt-2 border-t border-white/10 shrink-0">
              <div className={`w-2.5 h-2.5 rounded-full ${MODE_BADGE_COLORS[currentConfig?.mode] || 'bg-gray-600'}`} />
              <span className="text-xs text-white/60">
                Slot {presetId}: <span className="text-white/80">{currentTemplateName || 'Custom'}</span>
                {' · '}
                <span className="text-white/60">{formatName(MATERIAL_NAMES[currentMaterial] ?? 'unknown')}</span>
              </span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
