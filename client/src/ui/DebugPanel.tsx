import { useEffect, useRef, useState, ReactNode } from 'react';
import { hexToRgb, rgbToHex, rgbToHsv, hsvToRgb } from '@worldify/shared';
import {
  ChevronDown, ChevronRight, Zap, Wrench, Search, Sliders, Palette, Droplet, Waves,
  Sparkles, Wind, Sun, Moon, Clock, Grid3x3, Lightbulb, Sunrise, Trash2,
} from 'lucide-react';
import {
  useGameStore, TERRAIN_DEBUG_MODE_NAMES, TERRAIN_DEBUG_MODE_ORDER, type TerrainDebugMode,
  BUILD_PREVIEW_LIGHTING_ORDER, BUILD_PREVIEW_LIGHTING_LABELS, type BuildPreviewLighting,
  type EnvironmentSettings, type DayNightKeyframe, type DayNightConfig,
} from '../state/store';
import { textureCache } from '../game/material/TextureCache';
import { setTerrainDebugMode as setShaderDebugMode, applyLightFillSettings, applyBlockLightSettings } from '../game/material/TerrainMaterial';
import { applyEnvironmentSettings } from '../game/scene/Lighting';
import { formatTimeOfDay, getDayPhaseLabel, invalidateDayNight } from '../game/scene/DayNightCycle';
import { clearAndReloadChunks } from '../state/transient';
import {
  cycleQualityLevel, QUALITY_LABELS, QUALITY_LEVELS, QUALITY_ROWS, MSAA_OPTIONS,
  qualityMatchesPreset, type QualityLevel,
} from '../game/quality/QualityPresets';
import { applyQualityPatch, syncQualityToStore } from '../game/quality/QualityManager';
import { getCamera } from '../game/scene/camera';

// ============== Collapsible Section Component ==============

interface SectionProps {
  title: string;
  icon?: ReactNode;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
  color?: string;
}

function Section({ title, icon, isOpen, onToggle, children, color = 'green' }: SectionProps) {
  const colorClasses: Record<string, string> = {
    green: 'text-green-500 hover:text-green-300',
    yellow: 'text-yellow-500 hover:text-yellow-300',
    cyan: 'text-cyan-500 hover:text-cyan-300',
  };

  return (
    <div className="mt-2">
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between py-1 px-0 text-left cursor-pointer ${colorClasses[color] || colorClasses.green}`}
      >
        <span className="font-bold flex items-center gap-1.5">{icon}{title}</span>
        {isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {isOpen && (
        <div className="pl-2 border-l border-green-500/30">
          {children}
        </div>
      )}
    </div>
  );
}

// ============== Slider Component ==============

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  formatValue?: (value: number) => string;
}

function Slider({ label, value, min, max, step = 0.01, onChange, formatValue }: SliderProps) {
  const displayValue = formatValue ? formatValue(value) : value.toFixed(2);
  
  return (
    <div className="flex flex-col gap-0.5 mb-1">
      <div className="flex justify-between text-xs">
        <span>{label}</span>
        <span className="text-yellow-400">{displayValue}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 bg-green-900 rounded-lg appearance-none cursor-pointer accent-yellow-400"
      />
    </div>
  );
}

// ============== Color Picker Component ==============

interface ColorPickerProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * Custom colour picker: a swatch that opens a popover with a hex field, a hue slider, and a
 * 2D saturation/value square. Emits `#rrggbb` hex strings (same contract as the old native input).
 */
function ColorPicker({ label, value, onChange }: ColorPickerProps) {
  const [open, setOpen] = useState(false);
  const rgb = hexToRgb(value);
  const hsv = rgbToHsv(rgb.r, rgb.g, rgb.b);
  const svRef = useRef<HTMLDivElement>(null);

  const emitHsv = (h: number, s: number, v: number) => {
    const c = hsvToRgb(h, s, v);
    onChange(rgbToHex(c.r, c.g, c.b));
  };

  const handleSV = (e: React.PointerEvent) => {
    const el = svRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const s = clamp01((e.clientX - rect.left) / rect.width);
    const v = 1 - clamp01((e.clientY - rect.top) / rect.height);
    emitHsv(hsv.h, s, v);
  };

  const hc = hsvToRgb(hsv.h, 1, 1);
  const hueHex = rgbToHex(hc.r, hc.g, hc.b);

  return (
    <div className="mb-1">
      <div className="flex items-center justify-between">
        <span className="text-xs">{label}</span>
        <button
          onClick={() => setOpen((o) => !o)}
          className="w-8 h-5 rounded border border-white/30 cursor-pointer"
          style={{ backgroundColor: value }}
          aria-label={`${label} colour`}
        />
      </div>
      {open && (
        <div className="mt-1 p-2 rounded-lg bg-black/80 border border-white/15 flex flex-col gap-2">
          {/* Saturation / value square */}
          <div
            ref={svRef}
            className="relative w-full h-24 rounded cursor-crosshair touch-none"
            style={{
              backgroundColor: hueHex,
              backgroundImage:
                'linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent)',
            }}
            onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); handleSV(e); }}
            onPointerMove={(e) => { if (e.buttons === 1) handleSV(e); }}
          >
            <span
              className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white shadow pointer-events-none"
              style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, backgroundColor: value }}
            />
          </div>
          {/* Hue slider */}
          <input
            type="range" min={0} max={360} step={1} value={Math.round(hsv.h)}
            onChange={(e) => emitHsv(parseInt(e.target.value, 10), hsv.s || 1, hsv.v || 1)}
            className="w-full h-2 rounded appearance-none cursor-pointer"
            style={{ background: 'linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)' }}
          />
          {/* Hex field */}
          <input
            type="text" value={value}
            onChange={(e) => {
              const v = e.target.value.trim();
              if (/^#[0-9a-fA-F]{6}$/.test(v)) onChange(v.toLowerCase());
            }}
            className="bg-black/60 border border-white/20 rounded text-xs px-1.5 py-0.5 text-white font-mono"
          />
        </div>
      )}
    </div>
  );
}

// ============== Select Component ==============

interface SelectProps<T> {
  label: string;
  value: T;
  options: { label: string; value: T }[];
  onChange: (value: T) => void;
}

function Select<T extends string | number>({ label, value, options, onChange }: SelectProps<T>) {
  return (
    <div className="flex items-center justify-between mb-1">
      <span className="text-xs">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange((typeof value === 'number' ? parseInt(e.target.value) : e.target.value) as T)}
        className="bg-black/50 border border-green-500/50 rounded text-xs px-1 py-0.5 text-yellow-400"
      >
        {options.map((opt) => (
          <option key={String(opt.value)} value={opt.value as string | number}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ============== Toggle Component ==============

interface ToggleProps {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}

function Toggle({ label, value, onChange }: ToggleProps) {
  return (
    <div className="flex items-center justify-between mb-1">
      <span className="text-xs">{label}</span>
      <button
        onClick={() => onChange(!value)}
        className={`w-10 h-5 rounded-full relative ${
          value ? 'bg-green-600' : 'bg-gray-600'
        }`}
      >
        <span
          className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
            value ? 'left-5' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

// ============== Segmented single-select row ==============

interface SegmentedRowProps {
  label: string;
  segments: { label: string }[];
  active: number; // index of the active segment, or -1
  onSelect: (index: number) => void;
}

/** A labelled row of mutually-exclusive segment buttons (Off/On, 2/4/6/8, …). */
function SegmentedRow({ label, segments, active, onSelect }: SegmentedRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 mb-1">
      <span className="text-xs whitespace-nowrap">{label}</span>
      <div className="flex gap-0.5">
        {segments.map((seg, i) => (
          <button
            key={seg.label}
            onClick={() => onSelect(i)}
            className={`px-1.5 py-0.5 text-[11px] rounded ${
              i === active ? 'bg-yellow-600 text-white' : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
            }`}
          >
            {seg.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ============== Main Debug Panel ==============

export function DebugPanel() {
  const {
    fps,
    perfStats,
    voxelDebug,
    voxelStats,
    toggleVoxelDebug,
    textureState,
    terrainDebugMode,
    cycleTerrainDebugMode,
    setTerrainDebugMode,
    buildPreviewLighting,
    setBuildPreviewLighting,
    forceRegenerateChunks,
    environment,
    setEnvironment,
    materialSettings,
    waterSettings,
    debugPanelSections,
    toggleDebugSection,
    // Quality state
    qualityLevel,
    quality,
    fov,
    renderScale,
    setRenderScale,
    msaaSamples,
    setMsaaSamples,
    dayNightConfig,
    updateKeyframe,
    setDayNightConfig,
  } = useGameStore();

  // Whether the live quality still matches the selected preset (ignoring view distance).
  const isCustomQuality = !qualityMatchesPreset(quality, qualityLevel);

  // Which keyframe is being edited in the keyframe editor.
  const [kfIndex, setKfIndex] = useState(0);
  const keyframe = dayNightConfig.keyframes[kfIndex];

  /** Edit the selected keyframe and re-derive the cycle live (no reset). */
  const editKeyframe = (u: Partial<DayNightKeyframe>) => { updateKeyframe(kfIndex, u); invalidateDayNight(); };
  /** Edit a global cycle setting (sun/moon appearance, arc, timing) and re-derive live. */
  const editGlobal = (u: Partial<Omit<DayNightConfig, 'keyframes'>>) => { setDayNightConfig(u); invalidateDayNight(); };

  const [cacheClearing, setCacheClearing] = useState(false);
  const [_chunksClearing, setChunksClearing] = useState(false);

  const handleClearTextureCache = async () => {
    setCacheClearing(true);
    await textureCache.clearCache();
    setCacheClearing(false);
    console.log('Texture cache cleared - reload page to re-download');
  };

  const handleClearChunks = () => {
    setChunksClearing(true);
    clearAndReloadChunks();
    setTimeout(() => setChunksClearing(false), 500);
  };

  const handleToggleForceRegenerate = () => {
    useGameStore.getState().toggleForceRegenerate();
    handleClearChunks();
  };

  const handleCycleQuality = () => {
    // Read from store directly to avoid stale closure in F8 event handler
    const currentLevel = useGameStore.getState().qualityLevel;
    const currentVisibility = useGameStore.getState().quality.visibilityRadius;
    const next = cycleQualityLevel(currentLevel);
    syncPresetToStore(next, currentVisibility);
  };

  /** Apply a full quality preset and sync all individual settings to store */
  const syncPresetToStore = (level: QualityLevel, customVisibility?: number) => {
    syncQualityToStore(level, customVisibility);
  };

  // Apply environment changes to the scene. Only the CHANGED fields are applied — never a
  // re-push of the whole environment — so editing one setting can't clobber the day-night
  // cycle's animated sun/moon/hemisphere state (the old reset bug).
  const handleEnvironmentChange = (updates: Partial<EnvironmentSettings>) => {
    setEnvironment(updates);
    applyEnvironmentSettings(updates);

    // SSAO/bloom/godrays/saturation are all store-driven via effects.ts — no direct call needed.

    // Apply voxel light-fill curves to terrain materials
    if ('skyFillPower' in updates || 'blockFillPower' in updates) {
      applyLightFillSettings(updates);
    }

    // Apply block-light (emitter) colour/intensity to terrain materials (live, no remesh)
    if ('blockLightColor' in updates || 'blockLightIntensity' in updates) {
      applyBlockLightSettings(updates);
    }
  };

  // Apply material settings changes to shaders
  const handleMaterialChange = (updates: Partial<typeof materialSettings>) => {
    useGameStore.getState().setMaterialSettings(updates);
  };

  // Reset material settings to defaults
  const handleResetMaterialSettings = () => {
    useGameStore.getState().resetMaterialSettings();
  };

  // Apply water settings changes to shaders
  const handleWaterChange = (updates: Partial<typeof waterSettings>) => {
    useGameStore.getState().setWaterSettings(updates);
  };

  // Reset water settings to defaults
  const handleResetWaterSettings = () => {
    useGameStore.getState().resetWaterSettings();
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      switch (e.key) {
        case 'F1':
          e.preventDefault();
          toggleVoxelDebug('showChunkBounds');
          break;
        case 'F2':
          e.preventDefault();
          toggleVoxelDebug('showEmptyChunks');
          break;
        case 'F3':
          e.preventDefault();
          toggleVoxelDebug('showCollisionMesh');
          break;
        case 'F4':
          e.preventDefault();
          toggleVoxelDebug('showChunkCoords');
          break;
        case 'F5':
          e.preventDefault();
          toggleVoxelDebug('showWireframe');
          break;
        case 'F7':
          e.preventDefault();
          cycleTerrainDebugMode();
          break;
        case 'F8':
          e.preventDefault();
          handleCycleQuality();
          break;
        case 'F9':
          e.preventDefault();
          handleToggleForceRegenerate();
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleVoxelDebug, cycleTerrainDebugMode]);
  
  // Sync terrain debug mode to shader
  useEffect(() => {
    setShaderDebugMode(terrainDebugMode);
  }, [terrainDebugMode]);

  // Shadow map size options (advanced/manual — quality preset drives the applied value)
  const shadowMapOptions = [
    { label: '512', value: 512 },
    { label: '1024', value: 1024 },
    { label: '2048', value: 2048 },
    { label: '4096', value: 4096 },
  ];

  const debugPanelExpanded = useGameStore((s) => s.debugPanelExpanded);
  const toggleDebugPanelExpanded = useGameStore((s) => s.toggleDebugPanelExpanded);

  // Compact mode: just FPS with expand button
  if (!debugPanelExpanded) {
    return (
      <div
        className="absolute top-5 left-5 py-1.5 px-3 bg-black/80 text-green-500 font-mono text-xs rounded-lg cursor-pointer hover:bg-black/90 select-none pointer-events-auto flex items-center gap-2"
        onClick={toggleDebugPanelExpanded}
        title="Click to expand debug panel"
      >
        <span className={fps < 30 ? 'text-red-400' : fps < 55 ? 'text-yellow-400' : ''}>{fps} FPS</span>
        <ChevronRight size={13} className="text-green-500/50" />
      </div>
    );
  }

  return (
    <div className="absolute top-5 left-5 bg-black/80 text-green-500 font-mono text-xs rounded-lg max-h-[calc(100dvh-200px)] min-w-[200px] pointer-events-auto flex flex-col overflow-hidden">

      {/* FPS + collapse — pinned at the top (does not scroll). */}
      <button
        onClick={toggleDebugPanelExpanded}
        className="shrink-0 flex items-center justify-between px-4 pt-2 pb-1.5 cursor-pointer text-green-500 hover:text-green-300"
        title="Collapse debug panel"
      >
        <span className={`font-bold ${fps < 30 ? 'text-red-400' : fps < 55 ? 'text-yellow-400' : ''}`}>{fps} FPS</span>
        <ChevronDown size={13} />
      </button>

      {/* Scrollable body — starts below the FPS row, thin scrollbar. */}
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-compact px-4 pb-2.5">

      {/* ============== PERFORMANCE SECTION (client-side only) ============== */}
      {/* FPS is shown in the sticky header above — not duplicated here. */}
      <Section
        title="Performance"
        icon={<Zap size={13} />}
        isOpen={debugPanelSections.performance}
        onToggle={() => toggleDebugSection('performance')}
        color="cyan"
      >
        <div className="text-cyan-400">
          <div className="grid grid-cols-2 gap-x-3">
            <div>Frame:</div><div className={perfStats.gameUpdate > 16.6 ? 'text-red-400' : ''}>{perfStats.gameUpdate.toFixed(1)} ms</div>
          </div>

          <div className="mt-2 pt-2 border-t border-cyan-500/30">
            <div className="mb-1 text-cyan-300 text-xs">Frame Timing (ms avg):</div>
            <div className="grid grid-cols-2 gap-x-3">
              <div>Render:</div><div className={perfStats.render > 8 ? 'text-yellow-400' : ''}>{perfStats.render.toFixed(1)}</div>
              <div>Voxel:</div><div className={perfStats.voxelUpdate > 4 ? 'text-yellow-400' : ''}>{perfStats.voxelUpdate.toFixed(1)}</div>
              <div>Remesh:</div><div className={perfStats.remesh > 4 ? 'text-yellow-400' : ''}>{perfStats.remesh.toFixed(1)}</div>
              <div>Lighting:</div><div className={perfStats.lighting > 4 ? 'text-yellow-400' : ''}>{perfStats.lighting.toFixed(1)}</div>
              <div>Physics:</div><div>{perfStats.physics.toFixed(1)}</div>
            </div>
          </div>

          <div className="mt-2 pt-2 border-t border-cyan-500/30">
            <div className="mb-1 text-cyan-300 text-xs">Renderer:</div>
            <div className="grid grid-cols-2 gap-x-3">
              <div>Draw calls:</div><div className={perfStats.drawCalls > 500 ? 'text-yellow-400' : ''}>{perfStats.drawCalls}</div>
              <div>Triangles:</div><div>{perfStats.triangles > 1000000 ? (perfStats.triangles / 1000000).toFixed(1) + 'M' : perfStats.triangles > 1000 ? (perfStats.triangles / 1000).toFixed(0) + 'K' : perfStats.triangles}</div>
              <div>Geometries:</div><div>{perfStats.geometries}</div>
              <div>Textures:</div><div>{perfStats.textures}</div>
              <div>Programs:</div><div>{perfStats.programs}</div>
            </div>
          </div>

          <div className="mt-2 pt-2 border-t border-cyan-500/30">
            <div className="mb-1 text-cyan-300 text-xs">World:</div>
            <div className="grid grid-cols-2 gap-x-3">
              <div>Chunks:</div><div>{voxelStats.chunksLoaded}</div>
              <div>Meshes:</div><div>{voxelStats.meshesVisible}</div>
              <div>Remesh Q:</div><div className={perfStats.remeshQueueSize > 10 ? 'text-yellow-400' : ''}>{perfStats.remeshQueueSize}</div>
              <div>Pending:</div><div>{perfStats.pendingChunks}</div>
              <div>Mesh calls:</div><div>{perfStats.meshDispatches}</div>
              <div>Collider Q:</div><div className={perfStats.colliderQueueSize > 10 ? 'text-yellow-400' : ''}>{perfStats.colliderQueueSize}</div>
            </div>
          </div>

          <div className="mt-2 pt-2 border-t border-cyan-500/30">
            {perfStats.jsHeapMB > 0 && <div>JS Heap: {perfStats.jsHeapMB} MB</div>}
            <a href="/materials" className="text-cyan-500 hover:text-cyan-300 underline block">
              Textures: {textureState}
            </a>
          </div>
        </div>
      </Section>

      {/* ============== DEBUG SECTION ============== */}
      <Section
        title="Debug"
        icon={<Wrench size={13} />}
        isOpen={debugPanelSections.debug}
        onToggle={() => toggleDebugSection('debug')}
        color="yellow"
      >
        <div className="text-yellow-400">
          <div className="mb-1 text-green-500 text-xs">Voxel (F1-F5):</div>
          <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
            <input
              type="checkbox"
              checked={voxelDebug.showChunkBounds}
              onChange={() => toggleVoxelDebug('showChunkBounds')}
              className="accent-yellow-400"
            />
            <span>F1 Bounds</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
            <input
              type="checkbox"
              checked={voxelDebug.showEmptyChunks}
              onChange={() => toggleVoxelDebug('showEmptyChunks')}
              className="accent-yellow-400"
            />
            <span>F2 Empty</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
            <input
              type="checkbox"
              checked={voxelDebug.showCollisionMesh}
              onChange={() => toggleVoxelDebug('showCollisionMesh')}
              className="accent-yellow-400"
            />
            <span>F3 Collision</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
            <input
              type="checkbox"
              checked={voxelDebug.showChunkCoords}
              onChange={() => toggleVoxelDebug('showChunkCoords')}
              className="accent-yellow-400"
            />
            <span>F4 Coords</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
            <input
              type="checkbox"
              checked={voxelDebug.showWireframe}
              onChange={() => toggleVoxelDebug('showWireframe')}
              className="accent-yellow-400"
            />
            <span>F5 Wireframe</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
            <input
              type="checkbox"
              checked={voxelDebug.stitchSeams}
              onChange={() => toggleVoxelDebug('stitchSeams')}
              className="accent-yellow-400"
            />
            <span>Seam stitch</span>
          </label>
        </div>

        <div className="mt-2 pt-2 border-t border-green-500/30 text-yellow-400">
          <div className="mb-1 text-green-500 text-xs">Shader (F7-F8):</div>
          <div className="flex items-center gap-2">
            <span className={`w-4 h-4 flex items-center justify-center ${terrainDebugMode > 0 ? 'text-yellow-300' : 'text-yellow-300/30'}`}>
              <Search size={14} />
            </span>
            <select
              value={terrainDebugMode}
              onChange={(e) => setTerrainDebugMode(Number(e.target.value) as TerrainDebugMode)}
              className="flex-1 bg-black/60 border border-green-500/40 rounded px-1 py-0.5 text-yellow-300 text-xs cursor-pointer"
            >
              {TERRAIN_DEBUG_MODE_ORDER.map((m) => (
                <option key={m} value={m} className="bg-black text-yellow-300">
                  {TERRAIN_DEBUG_MODE_NAMES[m]}
                </option>
              ))}
            </select>
          </div>
          <label
            className="flex items-center gap-2 cursor-pointer hover:text-yellow-300"
            onClick={handleCycleQuality}
          >
            <span className="w-4 h-4 flex items-center justify-center"><Zap size={14} /></span>
            <span>F8 Quality: {QUALITY_LABELS[qualityLevel]}</span>
          </label>
        </div>

        <div className="mt-2 pt-2 border-t border-green-500/30 text-yellow-400">
          <div className="mb-1 text-green-500 text-xs">Build Preview:</div>
          <div className="flex items-center gap-2">
            <span className={`w-4 h-4 flex items-center justify-center ${buildPreviewLighting === 'off' ? 'text-yellow-300/30' : 'text-yellow-300'}`}>
              <Lightbulb size={14} />
            </span>
            <select
              value={buildPreviewLighting}
              onChange={(e) => setBuildPreviewLighting(e.target.value as BuildPreviewLighting)}
              className="flex-1 bg-black/60 border border-green-500/40 rounded px-1 py-0.5 text-yellow-300 text-xs cursor-pointer"
              title="Preview lighting: Off (light only after commit), Deferred (spill lights at settle), Full (real-time spill every frame)"
            >
              {BUILD_PREVIEW_LIGHTING_ORDER.map((m) => (
                <option key={m} value={m} className="bg-black text-yellow-300">
                  {BUILD_PREVIEW_LIGHTING_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-2 pt-2 border-t border-green-500/30 text-yellow-400">
          <div className="mb-1 text-green-500 text-xs">Cache:</div>
          <label 
            className="flex items-center gap-2 cursor-pointer hover:text-yellow-300"
            onClick={handleClearTextureCache}
          >
            <span className={`w-4 h-4 flex items-center justify-center text-red-400 ${cacheClearing ? 'animate-pulse' : ''}`}>
              <Trash2 size={14} />
            </span>
            <span>Clear Texture Cache</span>
          </label>
          <label 
            className="flex items-center gap-2 cursor-pointer hover:text-yellow-300"
            onClick={handleToggleForceRegenerate}
          >
            <input
              type="checkbox"
              checked={forceRegenerateChunks}
              onChange={handleToggleForceRegenerate}
              className="accent-red-400"
            />
            <span className={forceRegenerateChunks ? 'text-red-400' : ''}>F9 Force Regen</span>
          </label>
        </div>
      </Section>

      {/* ============== QUALITY SECTION ============== */}
      <Section
        title="Quality"
        icon={<Sliders size={13} />}
        isOpen={debugPanelSections.quality}
        onToggle={() => toggleDebugSection('quality')}
        color="yellow"
      >
        {/* Preset Selector */}
        <div className="mb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-yellow-400 text-xs font-bold">Preset (F8)</span>
            {isCustomQuality && <span className="text-[10px] text-orange-400">Custom</span>}
          </div>
          <div className="flex gap-1">
            {QUALITY_LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => syncPresetToStore(level, quality.visibilityRadius)}
                className={`flex-1 py-1 text-xs rounded ${
                  !isCustomQuality && qualityLevel === level
                    ? 'bg-yellow-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {QUALITY_LABELS[level]}
              </button>
            ))}
          </div>
        </div>

        {/* Preset-driven levers — one segmented control each */}
        <div className="mb-2 pt-2 border-t border-yellow-500/30">
          {QUALITY_ROWS.map((row) => (
            <SegmentedRow
              key={row.key}
              label={row.label}
              segments={row.segments}
              active={row.match(quality)}
              onSelect={(i) => applyQualityPatch(row.segments[i].patch)}
            />
          ))}
        </div>

        {/* Independent of preset */}
        <div className="mb-2 pt-2 border-t border-yellow-500/30">
          <div className="text-yellow-400 text-xs mb-1 font-bold">Independent of preset</div>
          <SegmentedRow
            label="MSAA"
            segments={MSAA_OPTIONS}
            active={MSAA_OPTIONS.findIndex((o) => o.value === msaaSamples)}
            onSelect={(i) => setMsaaSamples(MSAA_OPTIONS[i].value)}
          />
          <Slider
            label="Resolution"
            value={Math.round(renderScale * 100)}
            min={50}
            max={100}
            step={5}
            onChange={(v) => setRenderScale(v / 100)}
            formatValue={(v) => `${v}%`}
          />
          <Slider
            label="FoV"
            value={fov}
            min={75}
            max={120}
            step={1}
            onChange={(v) => {
              useGameStore.getState().setFov(v);
              const cam = getCamera();
              if (cam) { cam.fov = v; cam.updateProjectionMatrix(); }
            }}
            formatValue={(v) => `${v}°`}
          />
        </div>

        {/* Fine-tuning */}
        <div className="mb-2 pt-2 border-t border-yellow-500/30">
          <div className="text-yellow-400 text-xs mb-1 font-bold">Fine-tuning</div>
          <Slider
            label="Shadow Softness"
            value={environment.shadowBlurRadius}
            min={1}
            max={25}
            step={1}
            onChange={(v) => handleEnvironmentChange({ shadowBlurRadius: v })}
          />
        </div>
      </Section>

      {/* ============== MATERIALS SECTION ============== */}
      <Section
        title="Materials"
        icon={<Palette size={13} />}
        isOpen={debugPanelSections.materials}
        onToggle={() => toggleDebugSection('materials')}
        color="yellow"
      >
        {/* Texture Multipliers */}
        <div className="mb-3">
          <div className="text-yellow-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Sliders size={12} /> Texture Adjustments</div>
          <Slider
            label="Roughness"
            value={materialSettings.roughnessMultiplier}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => handleMaterialChange({ roughnessMultiplier: v })}
          />
          <Slider
            label="Metalness Offset"
            value={materialSettings.metalnessOffset}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => handleMaterialChange({ metalnessOffset: v })}
          />
          <Slider
            label="AO Intensity"
            value={materialSettings.aoIntensity}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => handleMaterialChange({ aoIntensity: v })}
          />
          <Slider
            label="Normal Strength"
            value={materialSettings.normalStrength}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => handleMaterialChange({ normalStrength: v })}
          />
        </div>
        
        {/* Tri-planar Blending */}
        <div className="mb-3 pt-2 border-t border-yellow-500/30">
          <div className="text-yellow-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Grid3x3 size={12} /> Tri-Planar Blending</div>
          <Slider
            label="Blend Sharpness"
            value={materialSettings.blendSharpness}
            min={1}
            max={8}
            step={0.1}
            onChange={(v) => handleMaterialChange({ blendSharpness: v })}
          />
          <Slider
            label="Repeat Scale"
            value={materialSettings.repeatScale}
            min={0.5}
            max={4}
            step={0.1}
            onChange={(v) => handleMaterialChange({ repeatScale: v })}
          />
        </div>
        
        {/* Wind Animation */}
        <div className="mb-3 pt-2 border-t border-yellow-500/30">
          <div className="text-yellow-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Wind size={12} /> Wind Animation</div>
          <Slider
            label="Strength"
            value={materialSettings.windStrength}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(v) => handleMaterialChange({ windStrength: v })}
          />
          <Slider
            label="Speed"
            value={materialSettings.windSpeed}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => handleMaterialChange({ windSpeed: v })}
          />
          <Slider
            label="Frequency"
            value={materialSettings.windFrequency}
            min={0.1}
            max={3}
            step={0.1}
            onChange={(v) => handleMaterialChange({ windFrequency: v })}
          />
        </div>
        
        {/* Reset Button */}
        <div className="pt-2 border-t border-yellow-500/30">
          <button
            onClick={handleResetMaterialSettings}
            className="w-full py-1 px-2 bg-yellow-900/50 hover:bg-yellow-800/50 text-yellow-400 rounded text-xs"
          >
            Reset to Defaults
          </button>
        </div>
      </Section>

      {/* ============== WATER SECTION ============== */}
      <Section
        title="Water"
        icon={<Droplet size={13} />}
        isOpen={debugPanelSections.water ?? false}
        onToggle={() => toggleDebugSection('water')}
        color="cyan"
      >
        {/* Wave Animation */}
        <div className="mb-3">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Waves size={12} /> Waves</div>
          <Slider
            label="Amplitude"
            value={waterSettings.waveAmplitude}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(v) => handleWaterChange({ waveAmplitude: v })}
          />
          <Slider
            label="Frequency"
            value={waterSettings.waveFrequency}
            min={0.1}
            max={3}
            step={0.1}
            onChange={(v) => handleWaterChange({ waveFrequency: v })}
          />
          <Slider
            label="Speed"
            value={waterSettings.waveSpeed}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => handleWaterChange({ waveSpeed: v })}
          />
        </div>
        
        {/* Surface Effects */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Sparkles size={12} /> Surface</div>
          <Slider
            label="Normal Strength"
            value={waterSettings.normalStrength}
            min={0.5}
            max={5}
            step={0.1}
            onChange={(v) => handleWaterChange({ normalStrength: v })}
          />
          <Slider
            label="Normal Scale"
            value={waterSettings.normalScale}
            min={0.1}
            max={3}
            step={0.1}
            onChange={(v) => handleWaterChange({ normalScale: v })}
          />
          <Slider
            label="Scatter Strength"
            value={waterSettings.scatterStrength}
            min={0}
            max={3}
            step={0.1}
            onChange={(v) => handleWaterChange({ scatterStrength: v })}
          />
          <Slider
            label="Scatter Scale"
            value={waterSettings.scatterScale}
            min={0}
            max={5}
            step={0.05}
            onChange={(v) => handleWaterChange({ scatterScale: v })}
          />
          <Slider
            label="Roughness"
            value={waterSettings.roughness}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => handleWaterChange({ roughness: v })}
          />
          <Slider
            label="Fresnel Power"
            value={waterSettings.fresnelPower}
            min={1}
            max={8}
            step={0.1}
            onChange={(v) => handleWaterChange({ fresnelPower: v })}
          />
          <Slider
            label="Opacity"
            value={waterSettings.waterOpacity}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => handleWaterChange({ waterOpacity: v })}
          />
        </div>
        
        {/* Color Tint */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Palette size={12} /> Tint</div>
          <Slider
            label="Red"
            value={waterSettings.waterTint[0]}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => handleWaterChange({ waterTint: [v, waterSettings.waterTint[1], waterSettings.waterTint[2]] })}
          />
          <Slider
            label="Green"
            value={waterSettings.waterTint[1]}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => handleWaterChange({ waterTint: [waterSettings.waterTint[0], v, waterSettings.waterTint[2]] })}
          />
          <Slider
            label="Blue"
            value={waterSettings.waterTint[2]}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => handleWaterChange({ waterTint: [waterSettings.waterTint[0], waterSettings.waterTint[1], v] })}
          />
        </div>
        
        {/* Reset Button */}
        <div className="pt-2 border-t border-cyan-500/30">
          <button
            onClick={handleResetWaterSettings}
            className="w-full py-1 px-2 bg-cyan-900/50 hover:bg-cyan-800/50 text-cyan-400 rounded text-xs"
          >
            Reset to Defaults
          </button>
        </div>
      </Section>

      {/* ============== DAY-NIGHT CYCLE SECTION ============== */}
      <Section
        title="Day-Night Cycle"
        icon={<Moon size={13} />}
        isOpen={debugPanelSections.dayNightCycle ?? false}
        onToggle={() => toggleDebugSection('dayNightCycle')}
        color="cyan"
      >
        {/* Master Toggle */}
        <div className="mb-3">
          <Toggle
            label="Enable Cycle"
            value={environment.dayNightEnabled ?? false}
            onChange={(v) => handleEnvironmentChange({ dayNightEnabled: v })}
          />
        </div>

        {/* Time Display and Controls */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Clock size={12} /> Time</div>
          <div className="text-center mb-1">
            <span className="text-yellow-400 text-lg">{formatTimeOfDay(environment.timeOfDay)}</span>
            <span className="text-cyan-300 text-xs ml-2">{getDayPhaseLabel(environment.timeOfDay)}</span>
          </div>
          <Slider
            label="Time of Day"
            value={environment.timeOfDay}
            min={0}
            max={1}
            step={0.001}
            onChange={(v) => handleEnvironmentChange({ timeOfDay: v })}
            formatValue={(v) => formatTimeOfDay(v)}
          />
          <Slider
            label="Speed (min/s)"
            value={environment.timeSpeed}
            min={0}
            max={60}
            step={1}
            onChange={(v) => handleEnvironmentChange({ timeSpeed: v })}
            formatValue={(v) => v === 0 ? 'Paused' : `${(v ?? 0).toFixed(0)}`}
          />
        </div>

        {/* Sun — global appearance + arc (position follows the day-length arc) */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Sun size={12} /> Sun</div>
          <Slider label="Height" value={dayNightConfig.sunHeight} min={10} max={90} step={1} onChange={(v) => editGlobal({ sunHeight: v })} formatValue={(v) => `${(v ?? 0).toFixed(0)}°`} />
          <Slider label="Distance" value={dayNightConfig.sunDistance} min={50} max={400} step={10} onChange={(v) => editGlobal({ sunDistance: v })} formatValue={(v) => `${(v ?? 0).toFixed(0)}`} />
          <Slider label="Size" value={dayNightConfig.sunSize} min={0.2} max={4} step={0.05} onChange={(v) => editGlobal({ sunSize: v })} />
          <Slider label="Intensity" value={dayNightConfig.sunIntensity} min={0} max={10} step={0.1} onChange={(v) => editGlobal({ sunIntensity: v })} />
        </div>

        {/* Moon — its own global appearance + arc */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Moon size={12} /> Moon</div>
          <Slider label="Height" value={dayNightConfig.moonHeight} min={10} max={90} step={1} onChange={(v) => editGlobal({ moonHeight: v })} formatValue={(v) => `${(v ?? 0).toFixed(0)}°`} />
          <Slider label="Distance" value={dayNightConfig.moonDistance} min={50} max={400} step={10} onChange={(v) => editGlobal({ moonDistance: v })} formatValue={(v) => `${(v ?? 0).toFixed(0)}`} />
          <Slider label="Size" value={dayNightConfig.moonSize} min={0.2} max={4} step={0.05} onChange={(v) => editGlobal({ moonSize: v })} />
          <Slider label="Intensity" value={dayNightConfig.moonIntensity} min={0} max={3} step={0.05} onChange={(v) => editGlobal({ moonIntensity: v })} />
        </div>

        {/* Timing — dawn/dusk transition windows; day & night hold between them */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Clock size={12} /> Timing</div>
          <Slider label="Sunrise Start" value={dayNightConfig.sunriseStart} min={0} max={0.999} step={0.001} onChange={(v) => editGlobal({ sunriseStart: v })} formatValue={(v) => formatTimeOfDay(v)} />
          <Slider label="Sunrise End" value={dayNightConfig.sunriseEnd} min={0} max={0.999} step={0.001} onChange={(v) => editGlobal({ sunriseEnd: v })} formatValue={(v) => formatTimeOfDay(v)} />
          <Slider label="Sunset Start" value={dayNightConfig.sunsetStart} min={0} max={0.999} step={0.001} onChange={(v) => editGlobal({ sunsetStart: v })} formatValue={(v) => formatTimeOfDay(v)} />
          <Slider label="Sunset End" value={dayNightConfig.sunsetEnd} min={0} max={0.999} step={0.001} onChange={(v) => editGlobal({ sunsetEnd: v })} formatValue={(v) => formatTimeOfDay(v)} />
          <Slider label="Twilight" value={dayNightConfig.twilightAngle} min={1} max={20} step={0.5} onChange={(v) => editGlobal({ twilightAngle: v })} formatValue={(v) => `${(v ?? 0).toFixed(1)}°`} />
        </div>

        {/* Voxel light fill curves + block light */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Lightbulb size={12} /> Voxel Light</div>
          <Slider label="Sky Fill Power" value={environment.skyFillPower} min={0.25} max={2} step={0.05} onChange={(v) => handleEnvironmentChange({ skyFillPower: v })} />
          <Slider label="Block Fill Power" value={environment.blockFillPower} min={0.25} max={4} step={0.05} onChange={(v) => handleEnvironmentChange({ blockFillPower: v })} />
          <ColorPicker label="Block Color" value={environment.blockLightColor} onChange={(v) => handleEnvironmentChange({ blockLightColor: v })} />
          <Slider label="Block Intensity" value={environment.blockLightIntensity} min={0} max={4} step={0.05} onChange={(v) => handleEnvironmentChange({ blockLightIntensity: v })} />
        </div>

        {/* Shadows */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Moon size={12} /> Shadows</div>
          <Slider label="Bias" value={environment.shadowBias} min={-0.01} max={0.01} step={0.0001} onChange={(v) => handleEnvironmentChange({ shadowBias: v })} formatValue={(v) => v.toFixed(4)} />
          <Slider label="Normal Bias" value={environment.shadowNormalBias} min={0} max={0.1} step={0.001} onChange={(v) => handleEnvironmentChange({ shadowNormalBias: v })} formatValue={(v) => v.toFixed(3)} />
          <Select label="Map Size" value={environment.shadowMapSize} options={shadowMapOptions} onChange={(v) => handleEnvironmentChange({ shadowMapSize: v })} />
        </div>

        {/* Keyframe editor — pick a phase palette, edit its colours + fill */}
        <div className="mb-2 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold flex items-center gap-1.5"><Sunrise size={12} /> Palettes</div>
          <div className="flex gap-1 mb-2">
            {dayNightConfig.keyframes.map((k, i) => (
              <button
                key={k.name}
                onClick={() => setKfIndex(i)}
                className={`flex-1 px-1 py-1 text-[11px] rounded cursor-pointer ${
                  i === kfIndex ? 'bg-cyan-600 text-white' : 'bg-white/10 text-white/60 hover:bg-white/20'
                }`}
              >
                {k.name}
              </button>
            ))}
          </div>
          {keyframe && (
            <>
              <ColorPicker label="Sun Color" value={keyframe.sunColor} onChange={(v) => editKeyframe({ sunColor: v })} />
              <ColorPicker label="Moon Color" value={keyframe.moonColor} onChange={(v) => editKeyframe({ moonColor: v })} />
              <ColorPicker label="Sky Zenith" value={keyframe.skyZenithColor} onChange={(v) => editKeyframe({ skyZenithColor: v })} />
              <ColorPicker label="Sky Horizon" value={keyframe.skyHorizonColor} onChange={(v) => editKeyframe({ skyHorizonColor: v })} />
              <ColorPicker label="Ground" value={keyframe.groundColor} onChange={(v) => editKeyframe({ groundColor: v })} />
              <Slider label="Fill Intensity" value={keyframe.hemisphereIntensity} min={0} max={5} step={0.1} onChange={(v) => editKeyframe({ hemisphereIntensity: v })} />
            </>
          )}
        </div>
      </Section>

      {/* ============== POST-PROCESSING SECTION ============== */}
      <Section
        title="Post-Processing"
        icon={<Sparkles size={13} />}
        isOpen={debugPanelSections.environment}
        onToggle={() => toggleDebugSection('environment')}
        color="cyan"
      >
        <Slider label="SSAO Intensity" value={environment.ssaoIntensity} min={0} max={10} step={0.1} onChange={(v) => handleEnvironmentChange({ ssaoIntensity: v })} />
        <Slider label="SSAO Radius" value={environment.ssaoRadius} min={0} max={0.5} step={0.01} onChange={(v) => handleEnvironmentChange({ ssaoRadius: v })} />
        <Slider label="Bloom Intensity" value={environment.bloomIntensity} min={0} max={3} step={0.05} onChange={(v) => handleEnvironmentChange({ bloomIntensity: v })} />
        <Slider label="Bloom Threshold" value={environment.bloomThreshold} min={0} max={1} step={0.01} onChange={(v) => handleEnvironmentChange({ bloomThreshold: v })} />
        <Slider label="Bloom Radius" value={environment.bloomRadius} min={0} max={3} step={0.01} onChange={(v) => handleEnvironmentChange({ bloomRadius: v })} />
        <Slider label="God Rays Decay" value={environment.godRaysDecay} min={0} max={1} step={0.01} onChange={(v) => handleEnvironmentChange({ godRaysDecay: v })} />
        <Slider label="God Rays Exposure" value={environment.godRaysExposure} min={0} max={1} step={0.01} onChange={(v) => handleEnvironmentChange({ godRaysExposure: v })} />
        <Slider label="Saturation" value={environment.saturation} min={0} max={2} step={0.05} onChange={(v) => handleEnvironmentChange({ saturation: v })} />
      </Section>
      </div>
    </div>
  );
}
