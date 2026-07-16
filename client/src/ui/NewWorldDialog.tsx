/**
 * NewWorldDialog — prompts for a world name + seed plus the terrain's cave settings when creating a
 * new world. Worms and caverns are independent, combinable cave types: toggle either, both, or
 * neither, and tune each one's parameters (both share one CaveConfig). Every parameter has a short
 * description. The chosen settings are persisted to localStorage so they carry across sessions (tweak
 * → create → tweak without re-entering everything). Name/seed are always fresh.
 */

import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { nextWorldName, randomWorldSeed } from '../game/world/WorldManager';
import { DEFAULT_CAVE_CONFIG, normalizeCaveConfig, type CaveConfig } from '@worldify/shared';

interface NewWorldDialogProps {
  onCancel: () => void;
  onCreate: (name: string, seed: number, caveConfig: CaveConfig) => void;
}

type Field = { key: keyof CaveConfig; label: string; min: number; max: number; step: number; desc: string };

// Per-type parameter sliders, each with an explainer. Worms and caverns share several concepts
// (spacing, size, winding, verticality, wall roughness, roughness scale, size variety).
const WORM_FIELDS: Field[] = [
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

const CAVERN_FIELDS: Field[] = [
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
];

// Persist the chosen cave settings across sessions (name/seed stay fresh).
const CAVE_STORE_KEY = 'worldify-new-world-cave';
function loadSavedCave(): CaveConfig {
  try {
    const raw = localStorage.getItem(CAVE_STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      // Merge over defaults + migrate any legacy `mode` field to the worms/caverns toggles.
      return { ...DEFAULT_CAVE_CONFIG, ...normalizeCaveConfig(p.cave ?? p) };
    }
  } catch { /* ignore corrupt/absent */ }
  return { ...DEFAULT_CAVE_CONFIG };
}
function saveCave(cave: CaveConfig) {
  try { localStorage.setItem(CAVE_STORE_KEY, JSON.stringify({ cave })); } catch { /* ignore */ }
}

export function NewWorldDialog({ onCancel, onCreate }: NewWorldDialogProps) {
  const initial = useRef(loadSavedCave()).current;
  const [name, setName] = useState('');
  const [seed, setSeed] = useState(() => String(randomWorldSeed()));
  const [cave, setCave] = useState<CaveConfig>(initial);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nextWorldName().then(setName);
    nameRef.current?.focus();
  }, []);

  const submit = () => {
    const parsedSeed = parseInt(seed, 10);
    saveCave(cave);
    onCreate(name.trim(), Number.isFinite(parsedSeed) ? parsedSeed : randomWorldSeed(), cave);
  };

  const setField = (key: keyof CaveConfig, v: number) =>
    setCave((c) => ({ ...c, [key]: v }) as CaveConfig);

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

  const slider = (f: Field) => {
    const value = (cave as unknown as Record<string, number>)[f.key] ?? 0;
    return sliderRow(f.label, f.desc, value, f.min, f.max, f.step,
      (v) => setField(f.key, v), (v) => (Number.isInteger(f.step) ? String(v) : v.toFixed(2)));
  };

  const anyCave = cave.wormsEnabled || cave.cavernsEnabled;

  return (
    <Modal
      title="New World"
      onClose={onCancel}
      footer={
        <>
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

      {/* Cave settings: enable worms and/or caverns, then tune each enabled type (scrolls if tall). */}
      <div className="flex flex-col gap-2 border-t border-white/10 pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-white/60 text-xs">Caves</span>
          <div className="flex gap-1.5 flex-wrap justify-end">
            <button className={pill(cave.wormsEnabled)} onClick={() => setCave((c) => ({ ...c, wormsEnabled: !c.wormsEnabled }))}>
              Worms
            </button>
            <button className={pill(cave.cavernsEnabled)} onClick={() => setCave((c) => ({ ...c, cavernsEnabled: !c.cavernsEnabled }))}>
              Caverns
            </button>
          </div>
        </div>

        {anyCave && (
          <div className="flex flex-col gap-2.5 max-h-[42vh] overflow-y-auto scrollbar-compact pr-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/80 text-xs">Invert (debug)</span>
              <button className={pill(cave.invert)} onClick={() => setCave((c) => ({ ...c, invert: !c.invert }))}>
                {cave.invert ? 'On' : 'Off'}
              </button>
            </div>

            {cave.wormsEnabled && (
              <>
                <span className="text-white/50 text-[11px] font-semibold uppercase tracking-wide pt-1">Worms</span>
                {WORM_FIELDS.map(slider)}
              </>
            )}

            {cave.cavernsEnabled && (
              <>
                <span className="text-white/50 text-[11px] font-semibold uppercase tracking-wide pt-1">Caverns</span>
                {CAVERN_FIELDS.map(slider)}
              </>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
