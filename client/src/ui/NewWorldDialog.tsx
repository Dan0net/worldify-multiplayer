/**
 * NewWorldDialog — prompts for a world name + seed plus the generation layers when creating a new
 * world. Terrain, Worms, and Caverns are independent, combinable layers: toggle any of them, and
 * tune each one's parameters. Terrain is the base landscape (land + roads/water + trees/buildings);
 * with it off, enabled cave layers render as solid casts so you can inspect their shapes. Every
 * parameter has a short description. Settings persist to localStorage so they carry across sessions
 * (tweak → create → tweak). Name/seed are always fresh.
 */

import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { nextWorldName, randomWorldSeed } from '../game/world/WorldManager';
import {
  DEFAULT_CAVE_CONFIG, DEFAULT_TERRAIN_LAYER_CONFIG, normalizeCaveConfig,
  type CaveConfig, type TerrainLayerConfig,
} from '@worldify/shared';

interface NewWorldDialogProps {
  onCancel: () => void;
  onCreate: (name: string, seed: number, caveConfig: CaveConfig, terrainConfig: TerrainLayerConfig) => void;
}

type Field<T> = { key: keyof T; label: string; min: number; max: number; step: number; desc: string };

const TERRAIN_FIELDS: Field<TerrainLayerConfig>[] = [
  { key: 'pathSpacing', label: 'Path spacing', min: 40, max: 220, step: 5, desc: 'Distance between roads/paths — larger is sparser.' },
  { key: 'pathWidth', label: 'Path width', min: 1, max: 8, step: 0.5, desc: 'Width of the roads/paths in meters.' },
  { key: 'pathWarpAmplitude', label: 'Path warp amount', min: 0, max: 150, step: 5, desc: 'How strongly paths meander away from straight.' },
  { key: 'pathWarpFrequency', label: 'Path warp scale', min: 0.002, max: 0.05, step: 0.002, desc: 'Size of the path wiggles — higher is tighter.' },
  { key: 'buildingSpacing', label: 'Building spacing', min: 20, max: 150, step: 5, desc: 'Distance between buildings — larger means fewer.' },
];

const LANDFORM_FIELDS: Field<TerrainLayerConfig>[] = [
  { key: 'landformSeaLevel', label: 'Sea level', min: 0, max: 120, step: 4, desc: 'Water height in voxels — land below this floods.' },
  { key: 'landformMountainHeight', label: 'Mountain height', min: 60, max: 500, step: 10, desc: 'Tallest peaks above sea level (voxels).' },
  { key: 'landformWarpStrength', label: 'Coast warp', min: 0, max: 300, step: 10, desc: 'Large-scale warp — bigger = more sweeping bays/headlands.' },
  { key: 'landformBeachWidth', label: 'Beach width', min: 0, max: 48, step: 2, desc: 'Height of the sand shelf above the waterline (voxels).' },
  { key: 'landformSnowLine', label: 'Snow line', min: 60, max: 400, step: 10, desc: 'Elevation above sea where peaks turn to snow (voxels).' },
];

const WORM_FIELDS: Field<CaveConfig>[] = [
  { key: 'wormsPerCell', label: 'Density', min: 0, max: 20, step: 0.5, desc: 'How many tunnels are generated in each area.' },
  { key: 'wormCellSize', label: 'Spacing', min: 15, max: 100, step: 5, desc: 'Distance between tunnel start points — larger is sparser.' },
  { key: 'wormSegments', label: 'Length', min: 10, max: 150, step: 5, desc: 'How far each tunnel travels before it ends.' },
  { key: 'wormRadius', label: 'Tunnel size', min: 0.8, max: 5, step: 0.1, desc: 'Radius of the tunnels — bigger means wider caves.' },
  { key: 'wormTurnRate', label: 'Winding', min: 0.1, max: 1, step: 0.05, desc: 'How much tunnels curve and wind (low = straighter).' },
  { key: 'wormPitchRange', label: 'Verticality', min: 0, max: 3, step: 0.05, desc: 'How much tunnels rise and dive (0 = flat and level).' },
  { key: 'wormWallAmp', label: 'Wall roughness', min: 0, max: 3, step: 0.1, desc: 'Bumpiness of the tunnel walls (0 = perfectly smooth).' },
  { key: 'wormWallFrequency', label: 'Roughness scale', min: 0.02, max: 0.4, step: 0.01, desc: 'Size of the wall bumps — higher is finer/more frequent.' },
  { key: 'wormRadiusAlongVar', label: 'Size variation', min: 0, max: 1, step: 0.05, desc: 'How much a tunnel bulges and pinches along its length.' },
  { key: 'wormRadiusJitter', label: 'Size variety', min: 0, max: 1, step: 0.05, desc: 'How much tunnel width differs from one tunnel to the next.' },
];

const CAVERN_FIELDS: Field<CaveConfig>[] = [
  { key: 'cavernsPerCell', label: 'Density', min: 0, max: 4, step: 0.25, desc: 'How many caverns form in each area.' },
  { key: 'cavernCellSize', label: 'Spacing', min: 40, max: 160, step: 5, desc: 'Distance between caverns — larger spaces them further apart.' },
  { key: 'cavernRadius', label: 'Size', min: 6, max: 30, step: 1, desc: 'Base width of each chamber.' },
  { key: 'cavernVerticality', label: 'Verticality', min: 0, max: 3, step: 0.1, desc: 'How tall chambers are relative to their width.' },
  { key: 'cavernWinding', label: 'Winding', min: 0, max: 20, step: 0.5, desc: 'How much the chamber walls meander (0 = clean ellipsoid).' },
  { key: 'cavernWallAmp', label: 'Wall roughness', min: 0, max: 6, step: 0.2, desc: 'Bumpiness of the walls (0 = perfectly smooth).' },
  { key: 'cavernWallFrequency', label: 'Roughness scale', min: 0.05, max: 0.6, step: 0.01, desc: 'Size of the wall bumps — higher is finer.' },
  { key: 'cavernRadiusJitter', label: 'Size variety', min: 0, max: 1, step: 0.05, desc: 'How much chamber size differs from one to the next.' },
  { key: 'cavernWaterLevel', label: 'Water level', min: 0, max: 0.6, step: 0.05, desc: 'How deep the water pool at the bottom of each chamber is.' },
  { key: 'cavernSpikeAmount', label: 'Stalagmites', min: 0, max: 1, step: 0.05, desc: 'Abundance and size of stalagmites and stalactites.' },
  { key: 'cavernTerrainTaper', label: 'Terrain taper', min: 0, max: 1, step: 0.05, desc: 'Shrinks cavern openings where they breach the surface (0 = full-size; never fully sealed).' },
];

// Persist the chosen generation settings across sessions (name/seed stay fresh).
const STORE_KEY = 'worldify-new-world-cave';
type Saved = { cave: CaveConfig; terrain: TerrainLayerConfig };
function loadSaved(): Saved {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        cave: { ...DEFAULT_CAVE_CONFIG, ...normalizeCaveConfig(p.cave ?? p) },
        terrain: { ...DEFAULT_TERRAIN_LAYER_CONFIG, ...(p.terrain ?? {}) },
      };
    }
  } catch { /* ignore corrupt/absent */ }
  return { cave: { ...DEFAULT_CAVE_CONFIG }, terrain: { ...DEFAULT_TERRAIN_LAYER_CONFIG } };
}
function saveSettings(cave: CaveConfig, terrain: TerrainLayerConfig) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ cave, terrain })); } catch { /* ignore */ }
}

export function NewWorldDialog({ onCancel, onCreate }: NewWorldDialogProps) {
  const initial = useRef(loadSaved()).current;
  const [name, setName] = useState('');
  const [seed, setSeed] = useState(() => String(randomWorldSeed()));
  const [cave, setCave] = useState<CaveConfig>(initial.cave);
  const [terrain, setTerrain] = useState<TerrainLayerConfig>(initial.terrain);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nextWorldName().then(setName);
    nameRef.current?.focus();
  }, []);

  const submit = () => {
    const parsedSeed = parseInt(seed, 10);
    saveSettings(cave, terrain);
    onCreate(name.trim(), Number.isFinite(parsedSeed) ? parsedSeed : randomWorldSeed(), cave, terrain);
  };

  // Copy the dialed-in generation settings to the clipboard as JSON, so they can be shared (e.g. to
  // set as new engine defaults). Falls back to a prompt if the clipboard API is unavailable.
  const exportSettings = async () => {
    const json = JSON.stringify({ cave, terrain }, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt('Copy your generation settings:', json);
    }
  };

  const inputCls =
    'w-full rounded-lg bg-black/50 border border-white/15 px-3 py-2 text-sm text-white ' +
    'outline-none focus:border-indigo-400';
  const btn = (primary: boolean) =>
    `px-4 py-2 rounded-lg text-sm font-semibold cursor-pointer ${
      primary ? 'bg-indigo-600 hover:bg-indigo-500 text-white' : 'bg-white/10 hover:bg-white/20 text-white/80'
    }`;
  const pill = (active: boolean) =>
    `px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer ${
      active ? 'bg-indigo-600 text-white' : 'bg-white/10 hover:bg-white/20 text-white/70'
    }`;

  // A labelled slider row with a value readout and a description line beneath.
  const sliderRow = (label: string, desc: string, value: number, min: number, max: number, step: number,
    onChange: (v: number) => void, fmt: (v: number) => string) => (
    <div key={label} className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-white/80 text-xs shrink-0 w-28">{label}</span>
        <input
          type="range" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
          className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
        />
        <span className="text-white/50 text-xs tabular-nums w-12 text-right">{fmt(value)}</span>
      </div>
      <span className="text-white/40 text-[10px] leading-tight">{desc}</span>
    </div>
  );

  // Render a slider bound to one field of a config object + its setter.
  function fieldSlider<T>(f: Field<T>, obj: T, set: (patch: Partial<T>) => void) {
    const value = (obj as unknown as Record<string, number>)[f.key as string] ?? 0;
    return sliderRow(f.label, f.desc, value, f.min, f.max, f.step,
      (v) => set({ [f.key]: v } as Partial<T>),
      (v) => (Number.isInteger(f.step) ? String(v) : v.toFixed(2)));
  }
  const patchCave = (p: Partial<CaveConfig>) => setCave((c) => ({ ...c, ...p }));
  const patchTerrain = (p: Partial<TerrainLayerConfig>) => setTerrain((t) => ({ ...t, ...p }));

  const anyLayer = terrain.enabled || cave.wormsEnabled || cave.cavernsEnabled;
  const subheading = (text: string) => (
    <span className="text-white/50 text-[11px] font-semibold uppercase tracking-wide pt-1">{text}</span>
  );

  return (
    <Modal
      title="New World"
      onClose={onCancel}
      footer={
        <>
          <button className={`${btn(false)} mr-auto`} onClick={exportSettings} title="Copy these settings to the clipboard to share">
            {copied ? 'Copied!' : 'Export'}
          </button>
          <button className={btn(false)} onClick={onCancel}>Cancel</button>
          <button className={btn(true)} onClick={submit}>Create</button>
        </>
      }
    >
      <label className="flex flex-col gap-1">
        <span className="text-white/60 text-xs">Name</span>
        <input
          ref={nameRef}
          className={inputCls}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          maxLength={40}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-white/60 text-xs">Seed</span>
        <div className="flex gap-2">
          <input
            className={inputCls}
            value={seed}
            inputMode="numeric"
            onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
          <button
            className="px-3 rounded-lg bg-white/10 hover:bg-white/20 text-white/70 text-xs cursor-pointer whitespace-nowrap"
            onClick={() => setSeed(String(randomWorldSeed()))}
          >
            Random
          </button>
        </div>
      </label>

      {/* Generation layers: toggle Terrain / Worms / Caverns, then tune each enabled layer. */}
      <div className="flex flex-col gap-2 border-t border-white/10 pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-white/60 text-xs">Layers</span>
          <div className="flex gap-1.5 flex-wrap justify-end">
            <button className={pill(terrain.enabled)} onClick={() => patchTerrain({ enabled: !terrain.enabled })}>
              Terrain
            </button>
            {terrain.enabled && (
              <button className={pill(terrain.landformEnabled)} onClick={() => patchTerrain({ landformEnabled: !terrain.landformEnabled })}>
                Landforms
              </button>
            )}
            <button className={pill(cave.wormsEnabled)} onClick={() => patchCave({ wormsEnabled: !cave.wormsEnabled })}>
              Worms
            </button>
            <button className={pill(cave.cavernsEnabled)} onClick={() => patchCave({ cavernsEnabled: !cave.cavernsEnabled })}>
              Caverns
            </button>
          </div>
        </div>

        {anyLayer && (
          <div className="flex flex-col gap-2.5 max-h-[42vh] overflow-y-auto scrollbar-compact pr-1">
            {terrain.enabled && (
              <>
                {subheading('Terrain')}
                {TERRAIN_FIELDS.map((f) => fieldSlider(f, terrain, patchTerrain))}
                {terrain.landformEnabled && (
                  <>
                    {subheading('Landforms (sea / beach / mountains)')}
                    {LANDFORM_FIELDS.map((f) => fieldSlider(f, terrain, patchTerrain))}
                  </>
                )}
              </>
            )}
            {cave.wormsEnabled && (
              <>
                {subheading('Worms')}
                {WORM_FIELDS.map((f) => fieldSlider(f, cave, patchCave))}
              </>
            )}
            {cave.cavernsEnabled && (
              <>
                {subheading('Caverns')}
                {CAVERN_FIELDS.map((f) => fieldSlider(f, cave, patchCave))}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
