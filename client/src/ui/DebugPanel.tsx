import { useEffect, useState, ReactNode } from 'react';
import {
  useGameStore, TERRAIN_DEBUG_MODE_NAMES, TERRAIN_DEBUG_MODE_ORDER, type TerrainDebugMode,
  type EnvironmentSettings, type DayStageConfig, type NightStageConfig,
} from '../state/store';
import { textureCache } from '../game/material/TextureCache';
import { setTerrainDebugMode as setShaderDebugMode, applyLightFillSettings, applyBlockLightSettings } from '../game/material/TerrainMaterial';
import { applyEnvironmentSettings, TONE_MAPPING_OPTIONS } from '../game/scene/Lighting';
import { formatTimeOfDay, getDayPhaseLabel, invalidateDayNight } from '../game/scene/DayNightCycle';
import { clearAndReloadChunks } from '../state/transient';
import {
  cycleQualityLevel, QUALITY_LABELS, QUALITY_LEVELS, QUALITY_ROWS, MSAA_OPTIONS,
  qualityMatchesPreset, type QualityLevel,
} from '../game/quality/QualityPresets';
import { applyQualityPatch, syncQualityToStore } from '../game/quality/QualityManager';
import { getCamera } from '../game/scene/camera';
import * as THREE from 'three';

// ============== Collapsible Section Component ==============

interface SectionProps {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  children: ReactNode;
  color?: string;
}

function Section({ title, isOpen, onToggle, children, color = 'green' }: SectionProps) {
  const colorClasses: Record<string, string> = {
    green: 'text-green-500 hover:text-green-300',
    yellow: 'text-yellow-500 hover:text-yellow-300',
    cyan: 'text-cyan-500 hover:text-cyan-300',
  };
  
  return (
    <div className="mt-2">
      <button
        onClick={onToggle}
        className={`w-full flex items-center justify-between py-1 px-0 text-left cursor-pointer ${colorClasses[color] || colorClasses.green} transition-colors`}
      >
        <span className="font-bold">{title}</span>
        <span className="text-xs">{isOpen ? '▼' : '▶'}</span>
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

function ColorPicker({ label, value, onChange }: ColorPickerProps) {
  return (
    <div className="flex items-center justify-between mb-1">
      <span className="text-xs">{label}</span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-8 h-5 bg-transparent border border-green-500/50 rounded cursor-pointer"
      />
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
        className={`w-10 h-5 rounded-full relative transition-colors ${
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
            className={`px-1.5 py-0.5 text-[11px] rounded transition-colors ${
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
    setDayNightConfig,
  } = useGameStore();

  // Whether the live quality still matches the selected preset (ignoring view distance).
  const isCustomQuality = !qualityMatchesPreset(quality, qualityLevel);

  /** Edit a day/night stage keyframe and re-derive the cycle live (no reset). */
  const editDayStage = (u: Partial<DayStageConfig>) => { setDayNightConfig({ day: u }); invalidateDayNight(); };
  const editNightStage = (u: Partial<NightStageConfig>) => { setDayNightConfig({ night: u }); invalidateDayNight(); };

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

    // Apply light fill changes to terrain materials
    if ('lightFillPower' in updates || 'lightFillIntensity' in updates) {
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
        className="absolute top-5 left-5 py-1.5 px-3 bg-black/80 text-green-500 font-mono text-xs rounded-lg cursor-pointer hover:bg-black/90 transition-colors select-none pointer-events-auto"
        onClick={toggleDebugPanelExpanded}
        title="Click to expand debug panel"
      >
        <span className={fps < 30 ? 'text-red-400' : fps < 55 ? 'text-yellow-400' : ''}>{fps} FPS</span>
        <span className="ml-2 text-green-500/50">▶</span>
      </div>
    );
  }

  return (
    <div className="absolute top-5 left-5 py-2.5 px-4 bg-black/80 text-green-500 font-mono text-xs rounded-lg max-h-[calc(100dvh-200px)] overflow-y-auto min-w-[200px] pointer-events-auto">
      
      {/* Collapse button */}
      <button
        onClick={toggleDebugPanelExpanded}
        className="w-full flex items-center justify-between mb-1 cursor-pointer text-green-500 hover:text-green-300 transition-colors"
        title="Collapse debug panel"
      >
        <span className={`font-bold ${fps < 30 ? 'text-red-400' : fps < 55 ? 'text-yellow-400' : ''}`}>{fps} FPS</span>
        <span className="text-xs">▼</span>
      </button>

      {/* ============== PERFORMANCE SECTION (client-side only) ============== */}
      <Section
        title="⚡ Performance"
        isOpen={debugPanelSections.performance}
        onToggle={() => toggleDebugSection('performance')}
        color="cyan"
      >
        <div className="text-cyan-400">
          <div className="grid grid-cols-2 gap-x-3">
            <div>FPS:</div><div className={fps < 30 ? 'text-red-400' : fps < 55 ? 'text-yellow-400' : ''}>{fps}</div>
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
        title="🔧 Debug"
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
            <span className="w-4 h-4 flex items-center justify-center">
              {terrainDebugMode > 0 ? '🔍' : '○'}
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
            <span className="w-4 h-4 flex items-center justify-center">⚡</span>
            <span>F8 Quality: {QUALITY_LABELS[qualityLevel]}</span>
          </label>
        </div>
        
        <div className="mt-2 pt-2 border-t border-green-500/30 text-yellow-400">
          <div className="mb-1 text-green-500 text-xs">Cache:</div>
          <label 
            className="flex items-center gap-2 cursor-pointer hover:text-yellow-300"
            onClick={handleClearTextureCache}
          >
            <span className="w-4 h-4 flex items-center justify-center text-red-400">
              {cacheClearing ? '⏳' : '✕'}
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
        title="⚡ Quality"
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
                className={`flex-1 py-1 text-xs rounded transition-colors ${
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
        title="🎨 Materials"
        isOpen={debugPanelSections.materials}
        onToggle={() => toggleDebugSection('materials')}
        color="yellow"
      >
        {/* Texture Multipliers */}
        <div className="mb-3">
          <div className="text-yellow-400 text-xs mb-1 font-bold">📐 Texture Adjustments</div>
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
          <div className="text-yellow-400 text-xs mb-1 font-bold">🔲 Tri-Planar Blending</div>
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
          <div className="text-yellow-400 text-xs mb-1 font-bold">🍃 Wind Animation</div>
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
        title="💧 Water"
        isOpen={debugPanelSections.water ?? false}
        onToggle={() => toggleDebugSection('water')}
        color="cyan"
      >
        {/* Wave Animation */}
        <div className="mb-3">
          <div className="text-cyan-400 text-xs mb-1 font-bold">🌊 Waves</div>
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
          <div className="text-cyan-400 text-xs mb-1 font-bold">✨ Surface</div>
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
          <div className="text-cyan-400 text-xs mb-1 font-bold">🎨 Tint</div>
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
        title="🌓 Day-Night Cycle"
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
          <div className="text-cyan-400 text-xs mb-1 font-bold">🕐 Time</div>
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

        {/* Day stage keyframe — edits apply live via the cycle (no reset) */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold">☀️ Day Stage</div>
          <ColorPicker label="Sun Color" value={dayNightConfig.day.sunColor} onChange={(v) => editDayStage({ sunColor: v })} />
          <Slider label="Sun Intensity" value={dayNightConfig.day.sunIntensity} min={0} max={10} step={0.1} onChange={(v) => editDayStage({ sunIntensity: v })} />
          <ColorPicker label="Sky" value={dayNightConfig.day.hemisphereSkyColor} onChange={(v) => editDayStage({ hemisphereSkyColor: v })} />
          <ColorPicker label="Ground" value={dayNightConfig.day.hemisphereGroundColor} onChange={(v) => editDayStage({ hemisphereGroundColor: v })} />
          <Slider label="Fill Intensity" value={dayNightConfig.day.hemisphereIntensity} min={0} max={5} step={0.1} onChange={(v) => editDayStage({ hemisphereIntensity: v })} />
          <Slider label="Sky/Ambient (IBL)" value={dayNightConfig.day.environmentIntensity} min={0} max={3} step={0.05} onChange={(v) => editDayStage({ environmentIntensity: v })} />
        </div>

        {/* Night stage keyframe */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold">🌙 Night Stage</div>
          <ColorPicker label="Moon Color" value={dayNightConfig.night.moonColor} onChange={(v) => editNightStage({ moonColor: v })} />
          <Slider label="Moon Intensity" value={dayNightConfig.night.moonIntensity} min={0} max={3} step={0.05} onChange={(v) => editNightStage({ moonIntensity: v })} />
          <ColorPicker label="Sky" value={dayNightConfig.night.hemisphereSkyColor} onChange={(v) => editNightStage({ hemisphereSkyColor: v })} />
          <ColorPicker label="Ground" value={dayNightConfig.night.hemisphereGroundColor} onChange={(v) => editNightStage({ hemisphereGroundColor: v })} />
          <Slider label="Fill Intensity" value={dayNightConfig.night.hemisphereIntensity} min={0} max={5} step={0.1} onChange={(v) => editNightStage({ hemisphereIntensity: v })} />
          <Slider label="Sky/Ambient (IBL)" value={dayNightConfig.night.environmentIntensity} min={0} max={3} step={0.05} onChange={(v) => editNightStage({ environmentIntensity: v })} />
        </div>

        {/* Manual sun/moon position — used only when the cycle is off */}
        {(environment.dayNightEnabled ?? true) === false && (
          <div className="mb-3 pt-2 border-t border-cyan-500/30">
            <div className="text-cyan-400 text-xs mb-1 font-bold">🧭 Manual Position (cycle off)</div>
            <Slider label="Sun Azimuth" value={environment.sunAzimuth ?? 135} min={0} max={360} step={1} onChange={(v) => handleEnvironmentChange({ sunAzimuth: v })} formatValue={(v) => `${(v ?? 0).toFixed(0)}°`} />
            <Slider label="Sun Elevation" value={environment.sunElevation ?? 45} min={-90} max={90} step={1} onChange={(v) => handleEnvironmentChange({ sunElevation: v })} formatValue={(v) => `${(v ?? 0).toFixed(0)}°`} />
            <Slider label="Moon Azimuth" value={environment.moonAzimuth ?? 315} min={0} max={360} step={1} onChange={(v) => handleEnvironmentChange({ moonAzimuth: v })} formatValue={(v) => `${(v ?? 0).toFixed(0)}°`} />
            <Slider label="Moon Elevation" value={environment.moonElevation ?? -45} min={-90} max={90} step={1} onChange={(v) => handleEnvironmentChange({ moonElevation: v })} formatValue={(v) => `${(v ?? 0).toFixed(0)}°`} />
          </div>
        )}
      </Section>

      {/* ============== ENVIRONMENT SECTION ============== */}
      <Section
        title="🌅 Environment"
        isOpen={debugPanelSections.environment}
        onToggle={() => toggleDebugSection('environment')}
        color="cyan"
      >
        {/* Sun Settings */}
        <div className="mb-3">
          <div className="text-cyan-400 text-xs mb-1 font-bold">☀️ Sun</div>
          <ColorPicker
            label="Color"
            value={environment.sunColor}
            onChange={(v) => handleEnvironmentChange({ sunColor: v })}
          />
          <Slider
            label="Intensity"
            value={environment.sunIntensity}
            min={0}
            max={10}
            step={0.1}
            onChange={(v) => handleEnvironmentChange({ sunIntensity: v })}
          />
          <Slider
            label="Distance"
            value={environment.sunDistance}
            min={50}
            max={300}
            step={10}
            onChange={(v) => handleEnvironmentChange({ sunDistance: v })}
          />
        </div>

        {/* Moon Settings */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold">🌙 Moon</div>
          <ColorPicker
            label="Color"
            value={environment.moonColor}
            onChange={(v) => handleEnvironmentChange({ moonColor: v })}
          />
          <Slider
            label="Intensity"
            value={environment.moonIntensity}
            min={0}
            max={5}
            step={0.1}
            onChange={(v) => handleEnvironmentChange({ moonIntensity: v })}
          />
        </div>

        {/* Hemisphere Light (replaces ambient for natural outdoor lighting) */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="flex items-center justify-between mb-1">
            <span className="text-cyan-400 text-xs font-bold">🌐 Hemisphere (Fill)</span>
            <Toggle
              label=""
              value={environment.hemisphereEnabled ?? true}
              onChange={(v) => handleEnvironmentChange({ hemisphereEnabled: v })}
            />
          </div>
          {(environment.hemisphereEnabled ?? true) && (
            <>
              <ColorPicker
                label="Sky"
                value={environment.hemisphereSkyColor ?? '#87ceeb'}
                onChange={(v) => handleEnvironmentChange({ hemisphereSkyColor: v })}
              />
              <ColorPicker
                label="Ground"
                value={environment.hemisphereGroundColor ?? '#3d5c3d'}
                onChange={(v) => handleEnvironmentChange({ hemisphereGroundColor: v })}
              />
              <Slider
                label="Intensity"
                value={environment.hemisphereIntensity ?? 1.0}
                min={0}
                max={10}
                step={0.1}
                onChange={(v) => handleEnvironmentChange({ hemisphereIntensity: v })}
              />
            </>
          )}
        </div>

        {/* Sky/Ambient Lighting (IBL) */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold">🌐 Sky/Ambient Lighting</div>
          <Slider
            label="Intensity"
            value={environment.environmentIntensity}
            min={0}
            max={3}
            step={0.1}
            onChange={(v) => handleEnvironmentChange({ environmentIntensity: v })}
          />
        </div>

        {/* Shadows */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold">🌑 Shadows</div>
          <Slider
            label="Bias"
            value={environment.shadowBias}
            min={-0.01}
            max={0.01}
            step={0.0001}
            onChange={(v) => handleEnvironmentChange({ shadowBias: v })}
            formatValue={(v) => v.toFixed(4)}
          />
          <Slider
            label="Normal Bias"
            value={environment.shadowNormalBias}
            min={0}
            max={0.1}
            step={0.001}
            onChange={(v) => handleEnvironmentChange({ shadowNormalBias: v })}
            formatValue={(v) => v.toFixed(3)}
          />
          <Select
            label="Map Size"
            value={environment.shadowMapSize}
            options={shadowMapOptions}
            onChange={(v) => handleEnvironmentChange({ shadowMapSize: v })}
          />
        </div>

        {/* Tone Mapping */}
        <div className="mb-1 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold">🎨 Tone Mapping</div>
          <Select
            label="Type"
            value={environment.toneMapping}
            options={TONE_MAPPING_OPTIONS.map(o => ({ label: o.label, value: o.value as number }))}
            onChange={(v) => handleEnvironmentChange({ toneMapping: v as THREE.ToneMapping })}
          />
          <Slider
            label="Exposure"
            value={environment.toneMappingExposure}
            min={0.1}
            max={3}
            step={0.05}
            onChange={(v) => handleEnvironmentChange({ toneMappingExposure: v })}
          />
        </div>
        
        {/* Post-Processing */}
        <div className="mb-3">
          <div className="text-green-400 text-xs mb-1">Post-Processing</div>
          <Slider
            label="SSAO Intensity"
            value={environment.ssaoIntensity}
            min={0}
            max={10}
            step={0.1}
            onChange={(v) => handleEnvironmentChange({ ssaoIntensity: v })}
          />
          <Slider
            label="SSAO Radius"
            value={environment.ssaoRadius}
            min={0}
            max={0.5}
            step={0.01}
            onChange={(v) => handleEnvironmentChange({ ssaoRadius: v })}
          />
          <Slider
            label="Bloom Intensity"
            value={environment.bloomIntensity}
            min={0}
            max={3}
            step={0.05}
            onChange={(v) => handleEnvironmentChange({ bloomIntensity: v })}
          />
          <Slider
            label="Bloom Threshold"
            value={environment.bloomThreshold}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => handleEnvironmentChange({ bloomThreshold: v })}
          />
          <Slider
            label="Bloom Radius"
            value={environment.bloomRadius}
            min={0}
            max={3}
            step={0.01}
            onChange={(v) => handleEnvironmentChange({ bloomRadius: v })}
          />
          <Slider
            label="God Rays Decay"
            value={environment.godRaysDecay}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => handleEnvironmentChange({ godRaysDecay: v })}
          />
          <Slider
            label="God Rays Exposure"
            value={environment.godRaysExposure}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => handleEnvironmentChange({ godRaysExposure: v })}
          />
          <Slider
            label="Saturation"
            value={environment.saturation}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => handleEnvironmentChange({ saturation: v })}
          />
        </div>
        
        {/* Voxel Light Fill */}
        <div className="mb-3">
          <div className="text-green-400 text-xs mb-1">Voxel Light Fill</div>
          <Slider
            label="Fill Power"
            value={environment.lightFillPower}
            min={0.1}
            max={10}
            step={0.1}
            onChange={(v) => handleEnvironmentChange({ lightFillPower: v })}
          />
          <Slider
            label="Fill Intensity"
            value={environment.lightFillIntensity}
            min={0}
            max={10}
            step={0.1}
            onChange={(v) => handleEnvironmentChange({ lightFillIntensity: v })}
          />
        </div>

        {/* Block Light (emitters, e.g. lava) — warm glow independent of the sun */}
        <div className="mb-3">
          <div className="text-green-400 text-xs mb-1">💡 Block Light</div>
          <ColorPicker
            label="Color"
            value={environment.blockLightColor}
            onChange={(v) => handleEnvironmentChange({ blockLightColor: v })}
          />
          <Slider
            label="Intensity"
            value={environment.blockLightIntensity}
            min={0}
            max={4}
            step={0.05}
            onChange={(v) => handleEnvironmentChange({ blockLightIntensity: v })}
          />
        </div>
      </Section>
    </div>
  );
}
