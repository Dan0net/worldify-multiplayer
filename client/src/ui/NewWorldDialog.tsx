/**
 * NewWorldDialog — prompts for a world name + seed plus the terrain's cave settings when creating a
 * new world. Pick the cave algorithm (off / worms / worley / spaghetti / cellular) and tune that
 * mode's parameters; each mode keeps its own parameters in one CaveConfig, so switching mode swaps
 * which sliders show. Every parameter has a short description. The chosen settings are persisted to
 * localStorage so they carry across sessions (so you can tweak → create → tweak without re-entering
 * everything). Name/seed are always fresh.
 */

import { useEffect, useRef, useState } from 'react';
import { Modal } from './Modal';
import { nextWorldName, randomWorldSeed } from '../game/world/WorldManager';
import { DEFAULT_CAVE_CONFIG, type CaveConfig } from '@worldify/shared';

interface NewWorldDialogProps {
  onCancel: () => void;
  onCreate: (name: string, seed: number, caveConfig: CaveConfig) => void;
}

type CaveMode = CaveConfig['mode'];
type Field = { key: keyof CaveConfig; label: string; min: number; max: number; step: number; desc: string };

// Simplified per-mode parameter sliders, each with an explainer.
const MODE_FIELDS: Record<Exclude<CaveMode, 'off'>, Field[]> = {
  worms: [
    { key: 'wormsPerCell', label: 'Density', min: 0, max: 20, step: 0.5, desc: 'How many tunnels are generated in each area.' },
    { key: 'wormCellSize', label: 'Spacing', min: 15, max: 100, step: 5, desc: 'Distance between tunnel start points — larger is sparser.' },
    { key: 'wormSegments', label: 'Length', min: 10, max: 150, step: 5, desc: 'How far each tunnel travels before it ends.' },
    { key: 'wormRadius', label: 'Tunnel size', min: 0.8, max: 5, step: 0.1, desc: 'Radius of the tunnels — bigger means wider caves.' },
    { key: 'wormTurnRate', label: 'Winding', min: 0.1, max: 1, step: 0.05, desc: 'How much tunnels curve and wind (low = straighter).' },
    { key: 'wormPitchRange', label: 'Verticality', min: 0, max: 3, step: 0.05, desc: 'How much tunnels rise and dive (0 = flat and level).' },
  ],
  worley: [
    { key: 'worleyWarpFrequency', label: 'Warp frequency', min: 0.01, max: 0.1, step: 0.005, desc: 'How rapidly tunnels bend along their length.' },
    { key: 'worleyWarpAmplitude', label: 'Warp amount', min: 0, max: 40, step: 1, desc: 'How strongly tunnels wind away from straight.' },
    { key: 'worleyXZCompression', label: 'Horizontal squeeze', min: 0.5, max: 4, step: 0.1, desc: 'Compresses caves horizontally (higher = tighter).' },
    { key: 'worleyYCompression', label: 'Vertical squeeze', min: 0.5, max: 6, step: 0.1, desc: 'Flattens caves — higher means fewer vertical drops.' },
  ],
  spaghetti: [
    { key: 'verticalSquash', label: 'Vertical squash', min: 0.3, max: 3, step: 0.1, desc: 'Flattens caves vertically (>1 = flatter, walkable).' },
    { key: 'frequency', label: 'Frequency', min: 0.01, max: 0.15, step: 0.005, desc: 'Tunnel scale — higher is smaller and denser.' },
    { key: 'radius', label: 'Tube radius', min: 0.03, max: 0.25, step: 0.01, desc: 'Thickness of the tubes.' },
    { key: 'regionThreshold', label: 'Clustering', min: -1, max: 0.8, step: 0.05, desc: 'Cluster caves into regions (−1 = everywhere).' },
    { key: 'regionFrequency', label: 'Region scale', min: 0.002, max: 0.05, step: 0.002, desc: 'Size of the clustered regions.' },
  ],
  cellular: [
    { key: 'verticalSquash', label: 'Vertical squash', min: 0.3, max: 3, step: 0.1, desc: 'Flattens caverns vertically.' },
    { key: 'cellFrequency', label: 'Cell size', min: 0.005, max: 0.05, step: 0.002, desc: 'Lower = larger caverns and longer corridors.' },
    { key: 'edgeThreshold', label: 'Corridor width', min: -1, max: -0.5, step: 0.02, desc: 'Higher opens the corridors wider.' },
    { key: 'warpFrequency', label: 'Warp scale', min: 0.005, max: 0.08, step: 0.005, desc: 'Frequency of the wall distortion.' },
    { key: 'warpAmplitude', label: 'Warp amount', min: 0, max: 20, step: 1, desc: 'Strength of the wall distortion.' },
  ],
};

const MODES: { value: CaveMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'worms', label: 'Worms' },
  { value: 'worley', label: 'Worley' },
  { value: 'spaghetti', label: 'Spaghetti' },
  { value: 'cellular', label: 'Cellular' },
];
const DISTANCE_FNS: CaveConfig['cellDistanceFunction'][] = ['euclidean', 'manhattan', 'hybrid'];

/**
 * Worley "Cave size" + "Cave spacing" (both 0..1) → the underlying frequency/cutoff. Spacing maps to
 * frequency (higher = lower frequency = caves further apart); the cutoff is coupled to the frequency
 * so tunnel WIDTH stays constant as spacing changes (`cut ≈ 3·freq − 0.368` holds ~14% fill), and
 * Size shifts the cutoff on top. Defaults (0.5, 0.833) ≈ DEFAULT_CAVE_CONFIG (freq 0.006, cut −0.35).
 */
function deriveWorley(size: number, spacing: number): Partial<CaveConfig> {
  const worleyFrequency = 0.016 - 0.012 * spacing;
  let worleyCutoff = 3.0 * worleyFrequency - 0.368 - (size - 0.5) * 0.18;
  worleyCutoff = Math.max(-0.55, Math.min(-0.15, worleyCutoff));
  return { worleyFrequency, worleyCutoff };
}
const WORLEY_DEFAULT_SIZE = 0.5;
const WORLEY_DEFAULT_SPACING = 0.833;

// Persist the chosen cave settings across sessions (name/seed stay fresh).
const CAVE_STORE_KEY = 'worldify-new-world-cave';
type SavedCave = { cave: CaveConfig; size: number; spacing: number };
function loadSavedCave(): SavedCave {
  try {
    const raw = localStorage.getItem(CAVE_STORE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        cave: { ...DEFAULT_CAVE_CONFIG, ...(p.cave ?? {}) },
        size: typeof p.worleySize === 'number' ? p.worleySize : WORLEY_DEFAULT_SIZE,
        spacing: typeof p.worleySpacing === 'number' ? p.worleySpacing : WORLEY_DEFAULT_SPACING,
      };
    }
  } catch { /* ignore corrupt/absent */ }
  return { cave: { ...DEFAULT_CAVE_CONFIG }, size: WORLEY_DEFAULT_SIZE, spacing: WORLEY_DEFAULT_SPACING };
}
function saveCave(cave: CaveConfig, worleySize: number, worleySpacing: number) {
  try { localStorage.setItem(CAVE_STORE_KEY, JSON.stringify({ cave, worleySize, worleySpacing })); } catch { /* ignore */ }
}

export function NewWorldDialog({ onCancel, onCreate }: NewWorldDialogProps) {
  const initial = useRef(loadSavedCave()).current;
  const [name, setName] = useState('');
  const [seed, setSeed] = useState(() => String(randomWorldSeed()));
  const [cave, setCave] = useState<CaveConfig>(initial.cave);
  const [worleySize, setWorleySize] = useState(initial.size);
  const [worleySpacing, setWorleySpacing] = useState(initial.spacing);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nextWorldName().then(setName);
    nameRef.current?.focus();
  }, []);

  const submit = () => {
    const parsedSeed = parseInt(seed, 10);
    saveCave(cave, worleySize, worleySpacing);
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

      {/* Cave settings: mode selector + this mode's parameter sliders (scrolls if tall). */}
      <div className="flex flex-col gap-2 border-t border-white/10 pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-white/60 text-xs">Caves</span>
          <div className="flex gap-1.5 flex-wrap justify-end">
            {MODES.map((m) => (
              <button key={m.value} className={pill(cave.mode === m.value)} onClick={() => setCave((c) => ({ ...c, mode: m.value }))}>
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {cave.mode !== 'off' && (
          <div className="flex flex-col gap-2.5 max-h-[42vh] overflow-y-auto scrollbar-compact pr-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/80 text-xs">Invert (debug)</span>
              <button className={pill(cave.invert)} onClick={() => setCave((c) => ({ ...c, invert: !c.invert }))}>
                {cave.invert ? 'On' : 'Off'}
              </button>
            </div>

            {cave.mode === 'cellular' && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-white/80 text-xs">Cross-section</span>
                <div className="flex gap-1.5">
                  {DISTANCE_FNS.map((d) => (
                    <button key={d} className={pill(cave.cellDistanceFunction === d)}
                      onClick={() => setCave((c) => ({ ...c, cellDistanceFunction: d }))}>
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {cave.mode === 'worley' && (
              <>
                {sliderRow('Cave size', 'Overall tunnel and cavern width.', worleySize, 0, 1, 0.02,
                  (v) => { setWorleySize(v); setCave((c) => ({ ...c, ...deriveWorley(v, worleySpacing) })); }, (v) => `${Math.round(v * 100)}%`)}
                {sliderRow('Cave spacing', 'How far apart caves sit — tunnel size stays constant.', worleySpacing, 0, 1, 0.02,
                  (v) => { setWorleySpacing(v); setCave((c) => ({ ...c, ...deriveWorley(worleySize, v) })); }, (v) => `${Math.round(v * 100)}%`)}
              </>
            )}

            {MODE_FIELDS[cave.mode].map(slider)}
          </div>
        )}
      </div>
    </Modal>
  );
}
