/**
 * BuildMenu — full-window build configuration overlay.
 *
 * Opens on Tab / right-click / the mobile build-menu button while playing, and
 * soft-pauses play (the game loop freezes the player while `menuOpen`). It takes
 * over the whole window with a translucent scrim so the world stays visible
 * behind it, and always shows all presets, materials, and config options for the
 * current build. Scrolls and reflows for portrait + landscape.
 *
 * Closes on the ✕ button, Tab, right-click, or Escape.
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
import { THUMB_PRIORITY } from './PresetThumbnailRenderer';
import { BuildConfigTab } from './BuildConfigTab';
import { isTouch } from '../game/deviceMode';

type MenuTab = 'presets' | 'materials' | 'config';

// ============== Sub-components ==============

/** A thumbnail tile (preset or material) sized for comfortable tapping. */
function ThumbTile({
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
      className={`relative flex items-center justify-center shrink-0 cursor-pointer
        w-20 h-20 md:w-24 md:h-24 rounded-2xl bg-black/60
        ${isActive ? 'ring-2 ring-cyan-400 shadow-lg shadow-cyan-400/30' : 'hover:bg-white/10 active:bg-white/15'}`}
    >
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" className="w-[72px] h-[72px] md:w-[88px] md:h-[88px] object-contain" draggable={false} />
      ) : (
        <span className="text-3xl text-white/50">◼</span>
      )}
    </button>
  );
}

function PresetTile({
  template,
  isActive,
  onSelect,
}: {
  template: { config: BuildConfig; baseRotation?: import('@worldify/shared').Quat; parts?: import('@worldify/shared').BuildPart[] };
  isActive: boolean;
  onSelect: () => void;
}) {
  const thumbnailUrl = usePresetThumbnail(template.config, template.baseRotation, { priority: THUMB_PRIORITY.HIGH }, template.parts);
  return <ThumbTile thumbnailUrl={thumbnailUrl} isActive={isActive} onSelect={onSelect} />;
}

function MaterialTile({
  materialId,
  isActive,
  onSelect,
}: {
  materialId: number;
  isActive: boolean;
  onSelect: () => void;
}) {
  const config = useMemo<BuildConfig>(() => ({
    shape: BuildShape.CUBE, mode: BuildMode.ADD, size: { x: 4, y: 4, z: 4 }, material: materialId,
  }), [materialId]);
  const thumbnailUrl = usePresetThumbnail(config, undefined, { priority: THUMB_PRIORITY.HIGH });
  return <ThumbTile thumbnailUrl={thumbnailUrl} isActive={isActive} onSelect={onSelect} />;
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

  const currentConfig = presetConfigs[presetId];
  const currentMeta = presetMeta[presetId];
  const currentMaterial = currentConfig?.material ?? 0;
  const isNonePreset = presetId === NONE_PRESET_ID;
  const currentTemplateName = currentMeta?.templateName ?? '';

  const [activeTab, setActiveTab] = useState<MenuTab>('presets');

  // Current-build preview shown in the header (top priority — renders immediately).
  const previewUrl = usePresetThumbnail(currentConfig, currentMeta?.baseRotation, { priority: THUMB_PRIORITY.PREVIEW }, currentMeta?.parts);

  const handleClose = useCallback(() => {
    setBuildMenuOpen(false);
    // Re-lock pointer after a tick (browser requirement); skip on touch.
    if (!isTouch()) requestAnimationFrame(() => document.body.requestPointerLock());
  }, [setBuildMenuOpen]);

  const handleSelectMaterial = useCallback((materialId: number) => {
    if (!isNonePreset) updatePresetConfig(presetId, { material: materialId });
  }, [presetId, isNonePreset, updatePresetConfig]);

  const handleSelectTemplate = useCallback((templateIndex: number) => {
    if (!isNonePreset) applyPresetTemplate(presetId, templateIndex);
  }, [presetId, isNonePreset, applyPresetTemplate]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => e.preventDefault(), []);

  if (gameMode !== GameMode.Playing || !menuOpen) return null;

  const tabBtn = (tab: MenuTab, label: string) => (
    <button
      onClick={() => setActiveTab(tab)}
      className={`flex-1 px-3 py-2.5 text-sm font-medium rounded-xl cursor-pointer
        ${activeTab === tab ? 'bg-cyan-400/20 text-cyan-400' : 'bg-black/60 text-white/50 hover:text-white/80 hover:bg-black/80'}`}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm pointer-events-auto flex md:items-center md:justify-center"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
      onContextMenu={handleContextMenu}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      {/* Full-screen on mobile; on desktop a card that fits its content (a fixed 6-column
          tile grid), so the header bar spans exactly the tile-grid width — not wider. */}
      <div className="flex flex-col w-full h-full md:w-fit md:max-w-[92vw] md:h-auto md:max-h-[82vh] md:rounded-2xl md:border md:border-white/10 md:bg-neutral-900/95 md:shadow-2xl overflow-hidden">
      {/* Header: current-build preview + tabs (does not scroll) */}
      <div className="shrink-0 flex items-center gap-2 md:gap-3 p-2 md:px-4 md:py-3 border-b border-white/10">
        <div className="shrink-0 w-14 h-14 md:w-16 md:h-16 rounded-2xl bg-black/60 flex items-center justify-center overflow-hidden">
          {previewUrl
            ? <img src={previewUrl} alt="" className="w-[52px] h-[52px] md:w-[60px] md:h-[60px] object-contain" draggable={false} />
            : <span className="text-2xl text-white/40">◼</span>}
        </div>
        <div className="flex-1 flex gap-1.5 min-w-0">
          {tabBtn('presets', 'Presets')}
          {tabBtn('materials', 'Materials')}
          {tabBtn('config', 'Config')}
        </div>
      </div>

      {/* Body: scrolls; thin scrollbar so the fixed 6-col grid fits the card width exactly. */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-compact p-3 md:p-4">
        <div className="mx-auto w-full md:w-fit">
          {activeTab === 'presets' && (
            <div className="flex flex-wrap gap-2 justify-center md:grid md:grid-cols-6 md:justify-items-start">
              {PRESET_TEMPLATES.map((t, idx) => (
                <PresetTile
                  key={idx}
                  template={t}
                  isActive={currentTemplateName === t.name}
                  onSelect={() => handleSelectTemplate(idx)}
                />
              ))}
            </div>
          )}

          {activeTab === 'materials' && (
            <div className="flex flex-wrap gap-2 justify-center md:grid md:grid-cols-6 md:justify-items-start">
              {MATERIAL_NAMES.map((_name, id) => (
                <MaterialTile
                  key={id}
                  materialId={id}
                  isActive={currentMaterial === id}
                  onSelect={() => handleSelectMaterial(id)}
                />
              ))}
            </div>
          )}

          {activeTab === 'config' && currentConfig && currentMeta && (
            <div className="md:w-[616px] max-w-full">
              <BuildConfigTab
                config={currentConfig}
                meta={currentMeta}
                presetId={presetId}
                onUpdateConfig={updatePresetConfig}
                onUpdateMeta={updatePresetMeta}
              />
            </div>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}
