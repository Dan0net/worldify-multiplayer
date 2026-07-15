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
  MATERIAL_NAMES,
  GameMode,
  PRESET_TEMPLATES,
  materialCubeParts,
  type BuildPart,
} from '@worldify/shared';
import { usePresetThumbnail } from './usePresetThumbnail';
import { THUMB_PRIORITY } from './PresetThumbnailRenderer';
import { BuildConfigTab } from './BuildConfigTab';
import { isTouch } from '../game/deviceMode';
import { X } from 'lucide-react';

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
  template: { parts: import('@worldify/shared').BuildPart[]; baseRotation?: import('@worldify/shared').Quat };
  isActive: boolean;
  onSelect: () => void;
}) {
  const thumbnailUrl = usePresetThumbnail(template.parts, template.baseRotation, { priority: THUMB_PRIORITY.HIGH });
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
  const parts = useMemo<BuildPart[]>(() => materialCubeParts(materialId), [materialId]);
  const thumbnailUrl = usePresetThumbnail(parts, undefined, { priority: THUMB_PRIORITY.HIGH });
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

  const { presetId, menuOpen, presetMeta } = build;

  const currentMeta = presetMeta[presetId];
  const currentConfig = currentMeta?.parts[0]?.config;
  const currentMaterial = currentConfig?.material ?? 0;
  const currentTemplateName = currentMeta?.templateName ?? '';

  const [activeTab, setActiveTab] = useState<MenuTab>('presets');

  // Current-build preview shown in the header (top priority — renders immediately).
  const previewUrl = usePresetThumbnail(currentMeta?.parts, currentMeta?.baseRotation, { priority: THUMB_PRIORITY.PREVIEW });

  const handleClose = useCallback(() => {
    setBuildMenuOpen(false);
    // Re-lock pointer after a tick (browser requirement); skip on touch.
    if (!isTouch()) requestAnimationFrame(() => document.body.requestPointerLock());
  }, [setBuildMenuOpen]);

  const handleSelectMaterial = useCallback((materialId: number) => {
    updatePresetConfig(presetId, { material: materialId });
  }, [presetId, updatePresetConfig]);

  const handleSelectTemplate = useCallback((templateIndex: number) => {
    applyPresetTemplate(presetId, templateIndex);
  }, [presetId, applyPresetTemplate]);

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
      className="fixed inset-0 z-[100] bg-black/40 backdrop-blur-sm pointer-events-auto flex items-center justify-center"
      style={{
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        paddingLeft: 'env(safe-area-inset-left)',
        paddingRight: 'env(safe-area-inset-right)',
      }}
      onContextMenu={handleContextMenu}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      {/* A centered card on all sizes (never full-screen); tighter on mobile. Clicking the scrim
          outside it closes the menu (handler above). */}
      <div className="flex flex-col w-[94vw] max-w-[94vw] max-h-[80vh] md:w-fit md:max-w-[92vw] md:max-h-[82vh] rounded-2xl border border-white/10 bg-neutral-900/95 shadow-2xl overflow-hidden">
      {/* Header: current-build preview + tabs + close (does not scroll) */}
      <div className="shrink-0 flex items-center gap-2 md:gap-3 p-2 md:px-4 md:py-3 border-b border-white/10">
        <div className="shrink-0 w-12 h-12 md:w-16 md:h-16 rounded-2xl bg-black/60 flex items-center justify-center overflow-hidden">
          {previewUrl
            ? <img src={previewUrl} alt="" className="w-[44px] h-[44px] md:w-[60px] md:h-[60px] object-contain" draggable={false} />
            : <span className="text-2xl text-white/40">◼</span>}
        </div>
        <div className="flex-1 flex gap-1.5 min-w-0">
          {tabBtn('presets', 'Presets')}
          {tabBtn('materials', 'Materials')}
          {tabBtn('config', 'Config')}
        </div>
        <button
          onClick={handleClose}
          aria-label="Close build menu"
          className="shrink-0 w-9 h-9 md:w-10 md:h-10 flex items-center justify-center rounded-xl text-white/60 hover:text-white hover:bg-white/10 cursor-pointer"
        >
          <X className="w-5 h-5" />
        </button>
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
