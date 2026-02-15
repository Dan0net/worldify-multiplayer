import { useEffect, useState, ReactNode } from 'react';
import { useGameStore, TERRAIN_DEBUG_MODE_NAMES, EnvironmentSettings } from '../state/store';
import { textureCache } from '../game/material/TextureCache';
import { setTerrainDebugMode as setShaderDebugMode } from '../game/material/TerrainMaterial';
import { updatePostProcessing } from '../game/scene/postprocessing';
import { applyEnvironmentSettings, TONE_MAPPING_OPTIONS } from '../game/scene/Lighting';
import { formatTimeOfDay, getDayPhaseLabel } from '../game/scene/DayNightCycle';
import { storeBridge } from '../state/bridge';
import { cycleQualityLevel, QUALITY_LABELS, QUALITY_LEVELS, type QualityLevel } from '../game/quality/QualityPresets';
import {
  applyVisibilityRadius,
  applySsaoEnabled,
  applyBloomEnabled,
  applyColorCorrectionEnabled,
  applyShadowsEnabled,
  applyShadowMapSize,
  applyMoonShadows,
  applyAnisotropy,
  applyPixelRatio,
  applyMsaaSamples,
  syncQualityToStore,
} from '../game/quality/QualityManager';
import { setShaderMapDefines } from '../game/material/TerrainMaterial';
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
        className={`w-full flex items-center justify-between py-1 px-0 text-left ${colorClasses[color] || colorClasses.green} transition-colors`}
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

// ============== Main Debug Panel ==============

export function DebugPanel() {
  const { 
    ping, 
    fps, 
    tickMs, 
    connectionStatus, 
    serverTick, 
    playerCount,
    perfStats,
    voxelDebug,
    voxelStats,
    toggleVoxelDebug,
    textureState,
    terrainDebugMode,
    cycleTerrainDebugMode,
    forceRegenerateChunks,
    environment,
    setEnvironment,
    materialSettings,
    waterSettings,
    debugPanelSections,
    toggleDebugSection,
    // Quality state
    qualityLevel,
    visibilityRadius,
    ssaoEnabled,
    bloomEnabled,
    colorCorrectionEnabled,
    shadowsEnabled,
    moonShadows,
    shadowMapSize,
    anisotropy,
    maxPixelRatio,
    msaaSamples,
    shaderNormalMaps,
    shaderAoMaps,
    shaderMetalnessMaps,
  } = useGameStore();

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
    storeBridge.clearAndReloadChunks();
    setTimeout(() => setChunksClearing(false), 500);
  };

  const handleToggleForceRegenerate = () => {
    storeBridge.toggleForceRegenerate();
    handleClearChunks();
  };

  const handleCycleQuality = () => {
    // Read from store directly to avoid stale closure in F8 event handler
    const currentLevel = useGameStore.getState().qualityLevel;
    const currentVisibility = useGameStore.getState().visibilityRadius;
    const next = cycleQualityLevel(currentLevel);
    syncPresetToStore(next, currentVisibility);
  };

  /** Apply a full quality preset and sync all individual settings to store */
  const syncPresetToStore = (level: QualityLevel, customVisibility?: number) => {
    syncQualityToStore(level, customVisibility);
  };

  const handleVisibilityRadiusChange = (radius: number) => {
    storeBridge.setVisibilityRadius(radius);
    applyVisibilityRadius(radius);
  };

  const handleShaderMapToggle = (map: 'normal' | 'ao' | 'metalness', enabled: boolean) => {
    if (map === 'normal') storeBridge.setShaderNormalMaps(enabled);
    else if (map === 'ao') storeBridge.setShaderAoMaps(enabled);
    else storeBridge.setShaderMetalnessMaps(enabled);
    setShaderMapDefines({
      normalMaps: map === 'normal' ? enabled : shaderNormalMaps,
      aoMaps: map === 'ao' ? enabled : shaderAoMaps,
      metalnessMaps: map === 'metalness' ? enabled : shaderMetalnessMaps,
    });
  };

  // Apply environment changes to the scene
  const handleEnvironmentChange = (updates: Partial<EnvironmentSettings>) => {
    setEnvironment(updates);
    applyEnvironmentSettings({ ...environment, ...updates });
    
    // Apply post-processing changes if any relevant settings changed
    if ('ssaoKernelRadius' in updates || 'ssaoMinDistance' in updates ||
        'bloomIntensity' in updates || 'bloomThreshold' in updates || 'bloomRadius' in updates ||
        'saturation' in updates) {
      updatePostProcessing(updates);
    }
  };

  // Apply material settings changes to shaders
  const handleMaterialChange = (updates: Partial<typeof materialSettings>) => {
    storeBridge.setMaterialSettings(updates);
  };

  // Reset material settings to defaults
  const handleResetMaterialSettings = () => {
    storeBridge.resetMaterialSettings();
  };

  // Apply water settings changes to shaders
  const handleWaterChange = (updates: Partial<typeof waterSettings>) => {
    storeBridge.setWaterSettings(updates);
  };

  // Reset water settings to defaults
  const handleResetWaterSettings = () => {
    storeBridge.resetWaterSettings();
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

  // Shadow map size options (0 = off)
  const shadowMapOptions = [
    { label: 'Off', value: 0 },
    { label: '512', value: 512 },
    { label: '1024', value: 1024 },
    { label: '2048', value: 2048 },
    { label: '4096', value: 4096 },
  ];

  // MSAA sample count options
  const msaaOptions = [
    { label: 'Off', value: 0 },
    { label: '2x', value: 2 },
    { label: '4x', value: 4 },
  ];

  return (
    <div className="fixed top-5 left-5 py-2.5 px-4 bg-black/80 text-green-500 font-mono text-xs rounded-lg z-50 max-h-[90vh] overflow-y-auto min-w-[200px]">
      
      {/* ============== STATS SECTION ============== */}
      <Section
        title="📊 Stats"
        isOpen={debugPanelSections.stats}
        onToggle={() => toggleDebugSection('stats')}
      >
        <div>Status: {connectionStatus}</div>
        <div>Players: {playerCount}</div>
        <div>Ping: {ping}ms</div>
        <div>FPS: {fps}</div>
        <div>Tick: {tickMs.toFixed(1)}ms</div>
        <div>Server: {serverTick}</div>
        
        <div className="mt-2 pt-2 border-t border-green-500/30">
          <div>Chunks: {voxelStats.chunksLoaded}</div>
          <div>Meshes: {voxelStats.meshesVisible}</div>
          <div>Debug: {voxelStats.debugObjects}</div>
        </div>
        
        <div className="mt-2 pt-2 border-t border-green-500/30">
          <a href="/materials" className="text-green-500 hover:text-green-300 underline block">
            Textures: {textureState}
          </a>
        </div>
      </Section>

      {/* ============== PERFORMANCE SECTION ============== */}
      <Section
        title="⚡ Performance"
        isOpen={debugPanelSections.performance}
        onToggle={() => toggleDebugSection('performance')}
        color="cyan"
      >
        <div className="text-cyan-400">
          <div className="mb-1 text-cyan-300 text-xs">Frame Timing (ms avg):</div>
          <div className="grid grid-cols-2 gap-x-3">
            <div>Total:</div><div className={perfStats.gameUpdate > 16.6 ? 'text-red-400' : ''}>{perfStats.gameUpdate.toFixed(1)}</div>
            <div>Render:</div><div className={perfStats.render > 8 ? 'text-yellow-400' : ''}>{perfStats.render.toFixed(1)}</div>
            <div>Voxel:</div><div className={perfStats.voxelUpdate > 4 ? 'text-yellow-400' : ''}>{perfStats.voxelUpdate.toFixed(1)}</div>
            <div>Remesh:</div><div className={perfStats.remesh > 4 ? 'text-yellow-400' : ''}>{perfStats.remesh.toFixed(1)}</div>
            <div>Physics:</div><div>{perfStats.physics.toFixed(1)}</div>
            <div>Build:</div><div className={perfStats.buildPreview > 4 ? 'text-red-400' : ''}>{perfStats.buildPreview.toFixed(1)}</div>
            <div>Players:</div><div>{perfStats.players.toFixed(1)}</div>
            <div>Env:</div><div>{perfStats.environment.toFixed(1)}</div>
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
            <div className="mb-1 text-cyan-300 text-xs">Voxel Queue:</div>
            <div className="grid grid-cols-2 gap-x-3">
              <div>Remesh Q:</div><div className={perfStats.remeshQueueSize > 10 ? 'text-yellow-400' : ''}>{perfStats.remeshQueueSize}</div>
              <div>Pending:</div><div>{perfStats.pendingChunks}</div>
            </div>
          </div>

          {perfStats.jsHeapMB > 0 && (
            <div className="mt-2 pt-2 border-t border-cyan-500/30">
              <div>JS Heap: {perfStats.jsHeapMB} MB</div>
            </div>
          )}
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
        </div>
        
        <div className="mt-2 pt-2 border-t border-green-500/30 text-yellow-400">
          <div className="mb-1 text-green-500 text-xs">Shader (F7-F8):</div>
          <label 
            className="flex items-center gap-2 cursor-pointer hover:text-yellow-300"
            onClick={cycleTerrainDebugMode}
          >
            <span className="w-4 h-4 flex items-center justify-center">
              {terrainDebugMode > 0 ? '🔍' : '○'}
            </span>
            <span>F7 {TERRAIN_DEBUG_MODE_NAMES[terrainDebugMode]}</span>
          </label>
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
          <div className="text-yellow-400 text-xs mb-1 font-bold">Preset (F8)</div>
          <div className="flex gap-1">
            {QUALITY_LEVELS.map((level) => (
              <button
                key={level}
                onClick={() => syncPresetToStore(level, visibilityRadius)}
                className={`flex-1 py-1 text-xs rounded transition-colors ${
                  qualityLevel === level
                    ? 'bg-yellow-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {QUALITY_LABELS[level]}
              </button>
            ))}
          </div>
        </div>

        {/* Rendering */}
        <div className="mb-2 pt-2 border-t border-yellow-500/30">
          <div className="text-yellow-400 text-xs mb-1 font-bold">🖥️ Rendering</div>
          <Slider
            label="View Distance"
            value={visibilityRadius}
            min={2}
            max={10}
            step={1}
            onChange={handleVisibilityRadiusChange}
            formatValue={(v) => `${v} chunks`}
          />
          <Slider
            label="Pixel Ratio"
            value={maxPixelRatio}
            min={0.5}
            max={2}
            step={0.25}
            onChange={(v) => {
              storeBridge.setMaxPixelRatio(v);
              applyPixelRatio(v);
            }}
            formatValue={(v) => `${v}x`}
          />
          <Slider
            label="Anisotropy"
            value={anisotropy}
            min={1}
            max={16}
            step={1}
            onChange={(v) => {
              storeBridge.setAnisotropy(v);
              applyAnisotropy(v);
            }}
            formatValue={(v) => `${v}x`}
          />
          <Select
            label="MSAA"
            value={msaaSamples}
            options={msaaOptions}
            onChange={(v) => {
              storeBridge.setMsaaSamples(v);
              applyMsaaSamples(v);
            }}
          />
        </div>

        {/* Shadows */}
        <div className="mb-2 pt-2 border-t border-yellow-500/30">
          <div className="text-yellow-400 text-xs mb-1 font-bold">🌑 Shadows</div>
          <Toggle
            label="Shadows"
            value={shadowsEnabled}
            onChange={(v) => {
              storeBridge.setShadowsEnabled(v);
              applyShadowsEnabled(v);
            }}
          />
          {shadowsEnabled && (
            <>
              <Select
                label="Map Size"
                value={shadowMapSize}
                options={shadowMapOptions}
                onChange={(v) => {
                  if (v === 0) {
                    storeBridge.setShadowsEnabled(false);
                    applyShadowsEnabled(false);
                  } else {
                    storeBridge.setShadowMapSize(v);
                    applyShadowMapSize(v);
                  }
                }}
              />
              <Toggle
                label="Moon Shadows"
                value={moonShadows}
                onChange={(v) => {
                  storeBridge.setMoonShadows(v);
                  applyMoonShadows(v);
                }}
              />
            </>
          )}
        </div>

        {/* Post-Processing */}
        <div className="mb-2 pt-2 border-t border-yellow-500/30">
          <div className="text-yellow-400 text-xs mb-1 font-bold">✨ Post-Processing</div>
          <Toggle
            label="SSAO"
            value={ssaoEnabled}
            onChange={(v) => {
              storeBridge.setSsaoEnabled(v);
              applySsaoEnabled(v);
            }}
          />
          <Toggle
            label="Bloom"
            value={bloomEnabled}
            onChange={(v) => {
              storeBridge.setBloomEnabled(v);
              applyBloomEnabled(v);
            }}
          />
          <Toggle
            label="Color Correction"
            value={colorCorrectionEnabled}
            onChange={(v) => {
              storeBridge.setColorCorrectionEnabled(v);
              applyColorCorrectionEnabled(v);
            }}
          />
        </div>

        {/* Shader Maps */}
        <div className="mb-2 pt-2 border-t border-yellow-500/30">
          <div className="text-yellow-400 text-xs mb-1 font-bold">🗺️ Shader Maps</div>
          <Toggle
            label="Normal Maps"
            value={shaderNormalMaps}
            onChange={(v) => handleShaderMapToggle('normal', v)}
          />
          <Toggle
            label="AO Maps"
            value={shaderAoMaps}
            onChange={(v) => handleShaderMapToggle('ao', v)}
          />
          <Toggle
            label="Metalness Maps"
            value={shaderMetalnessMaps}
            onChange={(v) => handleShaderMapToggle('metalness', v)}
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
            label="Metalness"
            value={materialSettings.metalnessMultiplier}
            min={0}
            max={2}
            step={0.05}
            onChange={(v) => handleMaterialChange({ metalnessMultiplier: v })}
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
            max={1}
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

        {/* Auto-Calculation Overrides */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold">🔄 Auto-Calculate</div>
          <Toggle
            label="Sun Position"
            value={environment.autoSunPosition ?? true}
            onChange={(v) => handleEnvironmentChange({ autoSunPosition: v })}
          />
          <Toggle
            label="Sun Color"
            value={environment.autoSunColor ?? true}
            onChange={(v) => handleEnvironmentChange({ autoSunColor: v })}
          />
          <Toggle
            label="Sun Intensity"
            value={environment.autoSunIntensity ?? true}
            onChange={(v) => handleEnvironmentChange({ autoSunIntensity: v })}
          />
          <Toggle
            label="Moon Position"
            value={environment.autoMoonPosition ?? true}
            onChange={(v) => handleEnvironmentChange({ autoMoonPosition: v })}
          />
          <Toggle
            label="Moon Intensity"
            value={environment.autoMoonIntensity ?? true}
            onChange={(v) => handleEnvironmentChange({ autoMoonIntensity: v })}
          />
          <Toggle
            label="Hemisphere Colors"
            value={environment.autoHemisphereColors ?? true}
            onChange={(v) => handleEnvironmentChange({ autoHemisphereColors: v })}
          />
          <Toggle
            label="Hemisphere Intensity"
            value={environment.autoHemisphereIntensity ?? true}
            onChange={(v) => handleEnvironmentChange({ autoHemisphereIntensity: v })}
          />
          <Toggle
            label="Environment (IBL)"
            value={environment.autoEnvironmentIntensity ?? true}
            onChange={(v) => handleEnvironmentChange({ autoEnvironmentIntensity: v })}
          />
        </div>

        {/* Manual Sun Position (when auto is off) */}
        {(environment.autoSunPosition ?? true) === false && (
          <div className="mb-3 pt-2 border-t border-cyan-500/30">
            <div className="text-cyan-400 text-xs mb-1 font-bold">☀️ Sun Position (Manual)</div>
            <Slider
              label="Azimuth"
              value={environment.sunAzimuth ?? 135}
              min={0}
              max={360}
              step={1}
              onChange={(v) => handleEnvironmentChange({ sunAzimuth: v })}
              formatValue={(v) => `${(v ?? 0).toFixed(0)}°`}
            />
            <Slider
              label="Elevation"
              value={environment.sunElevation ?? 45}
              min={-90}
              max={90}
              step={1}
              onChange={(v) => handleEnvironmentChange({ sunElevation: v })}
              formatValue={(v) => `${(v ?? 0).toFixed(0)}°`}
            />
          </div>
        )}

        {/* Manual Moon Position (when auto is off) */}
        {(environment.autoMoonPosition ?? true) === false && (
          <div className="mb-3 pt-2 border-t border-cyan-500/30">
            <div className="text-cyan-400 text-xs mb-1 font-bold">🌙 Moon Position (Manual)</div>
            <Slider
              label="Azimuth"
              value={environment.moonAzimuth ?? 315}
              min={0}
              max={360}
              step={1}
              onChange={(v) => handleEnvironmentChange({ moonAzimuth: v })}
              formatValue={(v) => `${(v ?? 0).toFixed(0)}°`}
            />
            <Slider
              label="Elevation"
              value={environment.moonElevation ?? -45}
              min={-90}
              max={90}
              step={1}
              onChange={(v) => handleEnvironmentChange({ moonElevation: v })}
              formatValue={(v) => `${(v ?? 0).toFixed(0)}°`}
            />
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
                max={3}
                step={0.1}
                onChange={(v) => handleEnvironmentChange({ hemisphereIntensity: v })}
              />
            </>
          )}
        </div>

        {/* Environment/IBL */}
        <div className="mb-3 pt-2 border-t border-cyan-500/30">
          <div className="text-cyan-400 text-xs mb-1 font-bold">🌐 Environment (IBL)</div>
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
            label="SSAO Radius"
            value={environment.ssaoKernelRadius}
            min={0}
            max={32}
            step={1}
            onChange={(v) => handleEnvironmentChange({ ssaoKernelRadius: v })}
          />
          <Slider
            label="SSAO Min Dist"
            value={environment.ssaoMinDistance}
            min={0.001}
            max={0.02}
            step={0.001}
            onChange={(v) => handleEnvironmentChange({ ssaoMinDistance: v })}
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
            max={1}
            step={0.01}
            onChange={(v) => handleEnvironmentChange({ bloomRadius: v })}
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
      </Section>
    </div>
  );
}
