/**
 * NewWorldDialog — prompts for a world name + seed (both pre-filled) plus the
 * terrain's cave settings when creating a new world. The cave section lets you
 * pick the cave algorithm (off / spaghetti / cellular / worms) and tune that
 * mode's parameters; each mode keeps its own parameters in one CaveConfig object,
 * so switching mode just swaps which sliders are shown. The chosen config is
 * stored on the world and drives its terrain generation.
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
type Field = { key: keyof CaveConfig; label: string; min: number; max: number; step: number };

// Parameter sliders shown per cave mode. Global fields apply to every carving mode.
const GLOBAL_FIELDS: Field[] = [
  { key: 'surfaceMargin', label: 'Surface margin', min: 0, max: 10, step: 1 },
  { key: 'surfaceTaper', label: 'Surface taper', min: 0, max: 12, step: 1 },
];
const MODE_FIELDS: Record<Exclude<CaveMode, 'off'>, Field[]> = {
  spaghetti: [
    { key: 'verticalSquash', label: 'Vertical squash', min: 0.3, max: 3, step: 0.1 },
    { key: 'frequency', label: 'Frequency', min: 0.01, max: 0.15, step: 0.005 },
    { key: 'radius', label: 'Tube radius', min: 0.03, max: 0.25, step: 0.01 },
    { key: 'regionThreshold', label: 'Region threshold', min: -1, max: 0.8, step: 0.05 },
    { key: 'regionFrequency', label: 'Region frequency', min: 0.002, max: 0.05, step: 0.002 },
  ],
  cellular: [
    { key: 'verticalSquash', label: 'Vertical squash', min: 0.3, max: 3, step: 0.1 },
    { key: 'cellFrequency', label: 'Cell frequency', min: 0.005, max: 0.05, step: 0.002 },
    { key: 'edgeThreshold', label: 'Corridor width', min: -1, max: -0.5, step: 0.02 },
    { key: 'warpFrequency', label: 'Warp frequency', min: 0.005, max: 0.08, step: 0.005 },
    { key: 'warpAmplitude', label: 'Warp amplitude', min: 0, max: 20, step: 1 },
  ],
  // Worley's two primary knobs (Cave size / Cave spacing) are handled specially below via a
  // width-preserving coupling; these are the advanced direct params kept per request.
  worley: [
    { key: 'worleyWarpFrequency', label: 'Warp frequency', min: 0.01, max: 0.1, step: 0.005 },
    { key: 'worleyWarpAmplitude', label: 'Warp amplitude', min: 0, max: 40, step: 1 },
    { key: 'worleyXZCompression', label: 'Horizontal squeeze', min: 0.5, max: 4, step: 0.1 },
    { key: 'worleyYCompression', label: 'Vertical squeeze', min: 0.5, max: 6, step: 0.1 },
  ],
  worms: [
    { key: 'wormsPerCell', label: 'Worms / cell', min: 0, max: 20, step: 0.5 },
    { key: 'wormCellSize', label: 'Spawn cell (m)', min: 10, max: 100, step: 5 },
    { key: 'wormSegments', label: 'Length (steps)', min: 10, max: 150, step: 5 },
    { key: 'wormStep', label: 'Step (m)', min: 0.5, max: 3, step: 0.1 },
    { key: 'wormRadius', label: 'Radius (m)', min: 0.8, max: 5, step: 0.1 },
    { key: 'wormRadiusJitter', label: 'Radius jitter', min: 0, max: 1, step: 0.05 },
    { key: 'wormRadiusAlongVar', label: 'Radius variation', min: 0, max: 1, step: 0.05 },
    { key: 'wormWallAmp', label: 'Wall roughness (m)', min: 0, max: 2, step: 0.1 },
    { key: 'wormWallFrequency', label: 'Wall bump freq', min: 0.02, max: 0.4, step: 0.01 },
    { key: 'wormSteerFrequency', label: 'Winding freq', min: 0.01, max: 0.3, step: 0.01 },
    { key: 'wormTurnRate', label: 'Turn rate', min: 0.1, max: 1, step: 0.05 },
    { key: 'wormPitchRange', label: 'Vertical range', min: 0, max: 3, step: 0.05 },
    { key: 'wormMaxPitch', label: 'Max pitch', min: 0.1, max: 3, step: 0.05 },
    { key: 'wormDownwardDrift', label: 'Downward drift', min: 0, max: 1, step: 0.02 },
    { key: 'wormConvergence', label: 'Convergence', min: 0, max: 1, step: 0.05 },
    { key: 'wormDepthRange', label: 'Depth range (m)', min: 5, max: 100, step: 5 },
    { key: 'wormSurfaceOvershoot', label: 'Surface overshoot (m)', min: 0, max: 15, step: 1 },
  ],
};

const MODES: { value: CaveMode; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'worley', label: 'Worley' },
  { value: 'worms', label: 'Worms' },
  { value: 'spaghetti', label: 'Spaghetti' },
  { value: 'cellular', label: 'Cellular' },
];
const DISTANCE_FNS: CaveConfig['cellDistanceFunction'][] = ['euclidean', 'manhattan', 'hybrid'];

/**
 * Worley "Cave spacing" + "Cave size" (both 0..1) → the underlying frequency/cutoff. Spacing maps
 * to frequency (higher slider = lower frequency = caves further apart); the cutoff is coupled to the
 * frequency so tunnel WIDTH stays constant as spacing changes (empirically `cut ≈ 3·freq − 0.368`
 * holds ~14% fill), and Size shifts the cutoff on top. Defaults (0.5, 0.833) reproduce
 * DEFAULT_CAVE_CONFIG (freq 0.006, cut −0.35).
 */
function deriveWorley(size: number, spacing: number): Partial<CaveConfig> {
  const worleyFrequency = 0.016 - 0.012 * spacing;                 // 0.016 (dense) → 0.004 (spaced)
  let worleyCutoff = 3.0 * worleyFrequency - 0.368 - (size - 0.5) * 0.18;
  worleyCutoff = Math.max(-0.55, Math.min(-0.15, worleyCutoff));
  return { worleyFrequency, worleyCutoff, worleySurfaceCutoff: worleyCutoff + 0.18 };
}
const WORLEY_DEFAULT_SIZE = 0.5;
const WORLEY_DEFAULT_SPACING = 0.833;

export function NewWorldDialog({ onCancel, onCreate }: NewWorldDialogProps) {
  const [name, setName] = useState('');
  const [seed, setSeed] = useState(() => String(randomWorldSeed()));
  const [cave, setCave] = useState<CaveConfig>(() => ({ ...DEFAULT_CAVE_CONFIG }));
  // Worley's two primary knobs (0..1); derive freq/cutoff into `cave` via the coupling above.
  const [worleySize, setWorleySize] = useState(WORLEY_DEFAULT_SIZE);
  const [worleySpacing, setWorleySpacing] = useState(WORLEY_DEFAULT_SPACING);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nextWorldName().then(setName);
    nameRef.current?.focus();
  }, []);

  const submit = () => {
    const parsedSeed = parseInt(seed, 10);
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

  const slider = (f: Field) => {
    const value = (cave as unknown as Record<string, number>)[f.key] ?? 0;
    return (
      <label key={f.key} className="flex items-center justify-between gap-3">
        <span className="text-white/70 text-xs shrink-0 w-32">{f.label}</span>
        <input
          type="range"
          min={f.min}
          max={f.max}
          step={f.step}
          value={value}
          onChange={(e) => setField(f.key, parseFloat(e.target.value))}
          className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
        />
        <span className="text-white/50 text-xs tabular-nums w-12 text-right">
          {Number.isInteger(f.step) ? value : value.toFixed(2)}
        </span>
      </label>
    );
  };

  // A 0..1 knob (Worley Size / Spacing) shown as a percentage; recomputes the coupled worley params.
  const knob = (label: string, value: number, set: (v: number) => void, deriveWith: (v: number) => Partial<CaveConfig>) => (
    <label key={label} className="flex items-center justify-between gap-3">
      <span className="text-white/70 text-xs shrink-0 w-32">{label}</span>
      <input
        type="range" min={0} max={1} step={0.02} value={value}
        onChange={(e) => { const v = parseFloat(e.target.value); set(v); setCave((c) => ({ ...c, ...deriveWith(v) })); }}
        className="flex-1 h-1.5 bg-white/20 rounded-lg appearance-none cursor-pointer accent-indigo-500"
      />
      <span className="text-white/50 text-xs tabular-nums w-12 text-right">{Math.round(value * 100)}%</span>
    </label>
  );

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
          <div className="flex flex-col gap-2 max-h-[38vh] overflow-y-auto scrollbar-compact pr-1">
            <div className="flex items-center justify-between gap-3">
              <span className="text-white/70 text-xs">Invert (debug: caves solid)</span>
              <button className={pill(cave.invert)} onClick={() => setCave((c) => ({ ...c, invert: !c.invert }))}>
                {cave.invert ? 'On' : 'Off'}
              </button>
            </div>

            {cave.mode === 'cellular' && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-white/70 text-xs">Cross-section</span>
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
                {knob('Cave size', worleySize, setWorleySize, (v) => deriveWorley(v, worleySpacing))}
                {knob('Cave spacing', worleySpacing, setWorleySpacing, (v) => deriveWorley(worleySize, v))}
              </>
            )}

            {GLOBAL_FIELDS.map(slider)}
            {MODE_FIELDS[cave.mode].map(slider)}
          </div>
        )}
      </div>
    </Modal>
  );
}
