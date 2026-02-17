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

import { useCallback, useMemo, useState } from 'react';
import { useGameStore } from '../state/store';
import {
  NONE_PRESET_ID,
  MATERIAL_NAMES,
  GameMode,
  PRESET_TEMPLATES,
  BuildMode,
  BuildShape,
  type BuildConfig,
} from '@worldify/shared';
import { usePresetThumbnail } from './usePresetThumbnail';
import { BuildConfigTab } from './BuildConfigTab';

// ============== Constants ==============

/** Menu tab */
type MenuTab = 'presets' | 'materials' | 'config';

// ============== Sub-components ==============

/** Material cube thumbnail — renders a 4×4×4 cube with the given material */
function MaterialCubeThumb({
  materialId,
  isActive,
  onSelect,
}: {
  materialId: number;
  isActive: boolean;
  onSelect: () => void;
}) {
  const config = useMemo<BuildConfig>(() => ({
    shape: BuildShape.CUBE,
    mode: BuildMode.ADD,
    size: { x: 4, y: 4, z: 4 },
    material: materialId,
  }), [materialId]);
  const thumbnailUrl = usePresetThumbnail(config);

  return (
    <button
      onClick={onSelect}
      className={`
        relative flex items-center justify-center
        w-24 h-24 rounded-2xl transition-all snap-start
        bg-black/60 backdrop-blur-sm
        ${isActive
          ? 'ring-2 ring-cyan-400 shadow-lg shadow-cyan-400/30'
          : 'hover:bg-white/10'
        }
      `}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          className="w-[88px] h-[88px] object-contain"
          draggable={false}
        />
      ) : (
        <span className="text-3xl text-white/70">◼</span>
      )}
    </button>
  );
}

/** Preset template button — thumbnail-only, matches toolbar slot sizing */
function PresetButton({
  thumbnailUrl,
  isActive,
  onSelect,
}: {
  thumbnailUrl?: string | null;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`
        relative flex items-center justify-center
        w-24 h-24 rounded-2xl transition-all snap-start
        bg-black/60 backdrop-blur-sm
        ${isActive
          ? 'ring-2 ring-cyan-400 shadow-lg shadow-cyan-400/30'
          : 'hover:bg-white/10'
        }
      `}
    >
      {thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          alt=""
          className="w-[88px] h-[88px] object-contain"
          draggable={false}
        />
      ) : (
        <span className="text-3xl text-white/70">◼</span>
      )}
    </button>
  );
}

/** Wrapper that pairs a PresetButton with its thumbnail hook */
function PresetButtonWithThumb({
  template,
  isActive,
  onSelect,
}: {
  template: { config: import('@worldify/shared').BuildConfig; baseRotation?: import('@worldify/shared').Quat; idx: number };
  isActive: boolean;
  onSelect: () => void;
}) {
  const thumbnailUrl = usePresetThumbnail(template.config, template.baseRotation);
  return (
    <PresetButton
      thumbnailUrl={thumbnailUrl}
      isActive={isActive}
      onSelect={onSelect}
    />
  );
}

// ============== Main Component ==============

export function BuildMenu() {
  const build = useGameStore((s) => s.build);
  const gameMode = useGameStore((s) => s.gameMode);
  const setBuildMenuOpen = useGameStore((s) => s.setBuildMenuOpen);
  const updatePresetConfig = useGameStore((s) => s.updatePresetConfig);
  const updatePresetMeta = useGameStore((s) => s.updatePresetMeta);
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
        className="relative z-[100] w-full flex flex-col max-h-[60vh]"
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={handleContextMenu}
      >
        {/* Tab bar — own background, spaced from content */}
        <div className="flex gap-1.5 shrink-0 mb-2">
          <button
            onClick={() => setActiveTab('presets')}
            className={`flex-1 px-4 py-2 text-sm font-medium rounded-xl transition-colors backdrop-blur-sm
              ${activeTab === 'presets'
                ? 'bg-cyan-400/20 text-cyan-400'
                : 'bg-black/60 text-white/50 hover:text-white/70 hover:bg-black/80'
              }`}
          >
            Presets
          </button>
          <button
            onClick={() => setActiveTab('materials')}
            className={`flex-1 px-4 py-2 text-sm font-medium rounded-xl transition-colors backdrop-blur-sm
              ${activeTab === 'materials'
                ? 'bg-cyan-400/20 text-cyan-400'
                : 'bg-black/60 text-white/50 hover:text-white/70 hover:bg-black/80'
              }`}
          >
            Materials
          </button>
          <button
            onClick={() => setActiveTab('config')}
            className={`flex-1 px-4 py-2 text-sm font-medium rounded-xl transition-colors backdrop-blur-sm
              ${activeTab === 'config'
                ? 'bg-cyan-400/20 text-cyan-400'
                : 'bg-black/60 text-white/50 hover:text-white/70 hover:bg-black/80'
              }`}
          >
            Config
          </button>
        </div>

        <div className="flex flex-col flex-1 min-h-0 mb-2">
          {isNonePreset ? (
            <div className="flex items-center justify-center h-32 text-white/40 text-sm p-4 bg-black/60 rounded-2xl backdrop-blur-sm">
              Select a build slot (keys 2-9, 0) to configure it
            </div>
          ) : activeTab === 'config' ? (
            /* ---- Config Tab ---- */
            <div className="p-4 bg-black/60 rounded-2xl backdrop-blur-sm">
            {currentConfig && currentMeta ? (
              <BuildConfigTab
                config={currentConfig}
                meta={currentMeta}
                presetId={presetId}
                onUpdateConfig={updatePresetConfig}
                onUpdateMeta={updatePresetMeta}
              />
            ) : (
              <div className="flex items-center justify-center h-32 text-white/40 text-sm">
                No preset selected
              </div>
            )}
            </div>
          ) : activeTab === 'presets' ? (
            /* ---- Presets Tab ---- */
            <div className="overflow-y-auto -mr-[20px] max-h-[300px] snap-y snap-mandatory scrollbar-glass">
              <div className="flex flex-wrap gap-1.5">
                {PRESET_TEMPLATES.map((t, idx) => (
                  <PresetButtonWithThumb
                    key={idx}
                    template={{ ...t, idx }}
                    isActive={currentTemplateName === t.name}
                    onSelect={() => handleSelectTemplate(idx)}
                  />
                ))}
              </div>
            </div>
          ) : (
            /* ---- Materials Tab ---- */
            <div className="overflow-y-auto -mr-[20px] max-h-[300px] snap-y snap-mandatory scrollbar-glass">
              <div className="flex flex-wrap gap-1.5">
                {MATERIAL_NAMES.map((_name, id) => (
                  <MaterialCubeThumb
                    key={id}
                    materialId={id}
                    isActive={currentMaterial === id}
                    onSelect={() => handleSelectMaterial(id)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
