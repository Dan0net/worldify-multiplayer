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
  DEFAULT_CAVE_CONFIG, DEFAULT_TERRAIN_LAYER_CONFIG, DEFAULT_LANDFORM_CURVE, normalizeCaveConfig,
  Curve, type CurvePoint,
  type CaveConfig, type TerrainLayerConfig,
} from '@worldify/shared';

interface NewWorldDialogProps {
  onCancel: () => void;
  onCreate: (name: string, seed: number, caveConfig: CaveConfig, terrainConfig: TerrainLayerConfig) => void;
}

type Field<T> = { key: keyof T; label: string; min: number; max: number; step: number; desc: string };

// World scale knobs — masterScale affects EVERY layer (land, rivers, paths, caves, buildings);
// landScale scales only the land + rivers on top of it.
const WORLD_FIELDS: Field<TerrainLayerConfig>[] = [
  { key: 'masterScale', label: 'World scale', min: 0.25, max: 6, step: 0.25, desc: 'Overall feature scale — stretches EVERYTHING (land, rivers, paths, caves, buildings). 1 = default.' },
  { key: 'landScale', label: 'Land scale', min: 0.25, max: 6, step: 0.25, desc: 'Scales the land + rivers only, on top of World scale. 1 = default.' },
];

const RIVER_FIELDS: Field<TerrainLayerConfig>[] = [
  { key: 'riverSpacing', label: 'River spacing', min: 60, max: 500, step: 10, desc: 'Distance between rivers — larger is sparser.' },
  { key: 'riverWidth', label: 'River width', min: 2, max: 40, step: 1, desc: 'Width of the river channels in meters.' },
  { key: 'riverDepth', label: 'River depth', min: 1, max: 30, step: 1, desc: 'How deep the channel bed cuts below the land (voxels).' },
  { key: 'riverWarpAmplitude', label: 'River warp amount', min: 0, max: 300, step: 10, desc: 'How far rivers meander away from straight.' },
  { key: 'riverWarpFrequency', label: 'River warp scale', min: 0.002, max: 0.03, step: 0.002, desc: 'Size of the river wiggles — higher is tighter.' },
];

const TERRAIN_FIELDS: Field<TerrainLayerConfig>[] = [
  { key: 'pathSpacing', label: 'Path spacing', min: 40, max: 220, step: 5, desc: 'Distance between roads/paths — larger is sparser.' },
  { key: 'pathWidth', label: 'Path width', min: 1, max: 8, step: 0.5, desc: 'Width of the roads/paths in meters.' },
  { key: 'pathWarpAmplitude', label: 'Path warp amount', min: 0, max: 150, step: 5, desc: 'How strongly paths meander away from straight.' },
  { key: 'pathWarpFrequency', label: 'Path warp scale', min: 0.002, max: 0.05, step: 0.002, desc: 'Size of the path wiggles — higher is tighter.' },
  { key: 'buildingSpacing', label: 'Building spacing', min: 20, max: 150, step: 5, desc: 'Distance between buildings — larger means fewer.' },
];

const LANDFORM_FIELDS: Field<TerrainLayerConfig>[] = [
  { key: 'landformScale', label: 'Feature scale', min: 0.5, max: 8, step: 0.25, desc: 'Bigger = smaller, more compact land/sea features.' },
  { key: 'landformWarpScale', label: 'Coast warp scale', min: 0.4, max: 4, step: 0.1, desc: 'Warp frequency relative to the land scale (finer coastline wiggle).' },
  { key: 'landformWarpStrength', label: 'Coast warp amount', min: 0, max: 300, step: 10, desc: 'How far the warp bends coastlines/ranges — bigger = more sweeping.' },
  { key: 'landformSeaLevel', label: 'Sea level', min: 0, max: 160, step: 4, desc: 'Water height in voxels — land below this floods.' },
  { key: 'landformSeaDepth', label: 'Sea depth', min: 40, max: 400, step: 10, desc: 'How deep the ocean floor drops below sea level (voxels).' },
  { key: 'landformMountainHeight', label: 'Mountain height', min: 60, max: 500, step: 10, desc: 'Tallest peaks above sea level (voxels).' },
  { key: 'landformBeachWidth', label: 'Beach height', min: 0, max: 48, step: 2, desc: 'How far the flat beach sits above the water (voxels).' },
  { key: 'landformSnowLine', label: 'Snow line', min: 60, max: 400, step: 10, desc: 'Elevation above sea where peaks turn to snow (voxels).' },
  { key: 'landformDetailFrequency', label: 'Detail scale', min: 1, max: 20, step: 0.5, desc: 'Surface-bump frequency relative to the land size — higher = finer bumps.' },
  { key: 'landformDetailFlat', label: 'Detail (flat)', min: 0, max: 8, step: 0.5, desc: 'Surface texture on flat ground (voxels) — a little so plains aren\'t glassy.' },
  { key: 'landformDetailSteep', label: 'Detail (steep)', min: 0, max: 30, step: 1, desc: 'Extra ruggedness on steep slopes (voxels) — jagged mountains.' },
  { key: 'landformRockSlopeDeg', label: 'Rock slope', min: 20, max: 80, step: 5, desc: 'Slope angle (degrees) where the surface turns from grass to rock cliffs.' },
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

/**
 * Draggable elevation-curve editor. Points map the continental noise (x: 0..1, left→right) to a
 * normalized height offset (y: -1 ocean floor .. +1 mountain peak). Drag a point to reshape sea /
 * beach / plains / mountains; the smooth line is the actual monotone-cubic curve the generator uses.
 * End points move only vertically; interior points stay ordered between their neighbours.
 */
function CurveEditor({ points, onChange }: { points: CurvePoint[]; onChange: (p: CurvePoint[]) => void }) {
  const W = 264, H = 120, pad = 10;
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const px = (x: number) => pad + x * (W - 2 * pad);
  const py = (y: number) => pad + (1 - (y + 1) / 2) * (H - 2 * pad);
  const fromPx = (cx: number, cy: number) => ({
    x: Math.min(1, Math.max(0, (cx - pad) / (W - 2 * pad))),
    y: Math.min(1, Math.max(-1, (1 - (cy - pad) / (H - 2 * pad)) * 2 - 1)),
  });
  const move = (clientX: number, clientY: number) => {
    if (drag === null || !svgRef.current) return;
    const r = svgRef.current.getBoundingClientRect();
    const { x, y } = fromPx(clientX - r.left, clientY - r.top);
    const pts = points.map((p) => ({ ...p }));
    const isEnd = drag === 0 || drag === pts.length - 1;
    pts[drag].y = y;
    if (!isEnd) pts[drag].x = Math.min(pts[drag + 1].x - 0.02, Math.max(pts[drag - 1].x + 0.02, x));
    onChange(pts);
  };
  // Sample the actual compiled curve for a faithful preview line.
  const curve = new Curve(points);
  let path = '';
  for (let i = 0; i <= 40; i++) {
    const x = i / 40;
    path += `${i === 0 ? 'M' : 'L'} ${px(x).toFixed(1)} ${py(curve.eval(x)).toFixed(1)} `;
  }
  const seaY = py(0);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-white/80 text-xs">Elevation curve</span>
      <svg
        ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`}
        className="bg-black/40 rounded-lg border border-white/15 touch-none select-none"
        onPointerMove={(e) => { if (drag !== null) { e.preventDefault(); move(e.clientX, e.clientY); } }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {/* sea level reference */}
        <line x1={pad} y1={seaY} x2={W - pad} y2={seaY} stroke="rgba(96,165,250,0.5)" strokeWidth="1" strokeDasharray="3 3" />
        <text x={W - pad} y={seaY - 3} textAnchor="end" fontSize="8" fill="rgba(96,165,250,0.8)">sea</text>
        <path d={path} fill="none" stroke="rgb(129,140,248)" strokeWidth="2" />
        {points.map((p, i) => (
          <circle
            key={i} cx={px(p.x)} cy={py(p.y)} r={5}
            fill={drag === i ? 'rgb(129,140,248)' : 'white'} stroke="rgb(79,70,229)" strokeWidth="1.5"
            className="cursor-grab"
            onPointerDown={(e) => { e.preventDefault(); (e.target as Element).setPointerCapture?.(e.pointerId); setDrag(i); }}
          />
        ))}
      </svg>
      <div className="flex items-center justify-between">
        <span className="text-white/40 text-[10px] leading-tight">Drag points: left→right is low→high land; the dashed line is sea level.</span>
        <button
          className="text-white/50 hover:text-white/80 text-[10px] cursor-pointer underline"
          onClick={() => onChange(DEFAULT_LANDFORM_CURVE.map((p) => ({ ...p })))}
        >
          Reset
        </button>
      </div>
    </div>
  );
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

  const anyLayer = terrain.enabled || terrain.landformEnabled || terrain.riversEnabled || cave.wormsEnabled || cave.cavernsEnabled;
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
              Buildings
            </button>
            <button className={pill(terrain.landformEnabled)} onClick={() => patchTerrain({ landformEnabled: !terrain.landformEnabled })}>
              Landforms
            </button>
            <button className={pill(terrain.riversEnabled)} onClick={() => patchTerrain({ riversEnabled: !terrain.riversEnabled })}>
              Rivers
            </button>
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
            {subheading('World scale')}
            {WORLD_FIELDS.map((f) => fieldSlider(f, terrain, patchTerrain))}
            {terrain.enabled && (
              <>
                {subheading('Buildings')}
                {TERRAIN_FIELDS.map((f) => fieldSlider(f, terrain, patchTerrain))}
              </>
            )}
            {terrain.landformEnabled && (
              <>
                {subheading('Landforms (sea / beach / mountains)')}
                {LANDFORM_FIELDS.map((f) => fieldSlider(f, terrain, patchTerrain))}
                <CurveEditor
                  points={terrain.landformCurve ?? DEFAULT_LANDFORM_CURVE}
                  onChange={(landformCurve) => patchTerrain({ landformCurve })}
                />
              </>
            )}
            {terrain.riversEnabled && (
              <>
                {subheading('Rivers')}
                {RIVER_FIELDS.map((f) => fieldSlider(f, terrain, patchTerrain))}
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
