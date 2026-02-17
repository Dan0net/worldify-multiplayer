/**
 * BuildConfigTab - Configuration panel for fine-tuning the active build preset.
 *
 * Allows editing shape, size, rotation, mode, alignment, snap shape, hollow thickness,
 * open/closed ends, arc sweep, and auto-rotate.
 */

import { useCallback, useMemo } from 'react';
import {
  BuildShape,
  BuildMode,
  BuildPresetAlign,
  BuildPresetSnapShape,
  eulerToQuat,
  quatToEuler,
  type BuildConfig,
  type PresetSlotMeta,
} from '@worldify/shared';
import { usePresetThumbnail } from './usePresetThumbnail';

// ============== Constants ==============

const SHAPE_OPTIONS: { value: BuildShape; label: string; icon: string }[] = [
  { value: BuildShape.CUBE, label: 'Cube', icon: '◼' },
  { value: BuildShape.SPHERE, label: 'Sphere', icon: '●' },
  { value: BuildShape.CYLINDER, label: 'Cylinder', icon: '▮' },
  { value: BuildShape.PRISM, label: 'Prism', icon: '◣' },
];

const MODE_OPTIONS: { value: BuildMode; label: string; color: string }[] = [
  { value: BuildMode.ADD, label: 'Add', color: 'bg-green-600' },
  { value: BuildMode.SUBTRACT, label: 'Subtract', color: 'bg-red-600' },
  { value: BuildMode.PAINT, label: 'Paint', color: 'bg-blue-600' },
  { value: BuildMode.FILL, label: 'Fill', color: 'bg-yellow-600' },
];

const ALIGN_OPTIONS: { value: BuildPresetAlign; label: string; desc: string }[] = [
  { value: BuildPresetAlign.CENTER, label: 'Center', desc: 'Center on hit point' },
  { value: BuildPresetAlign.BASE, label: 'Base', desc: 'Bottom at hit point' },
  { value: BuildPresetAlign.PROJECT, label: 'Project', desc: 'Project along surface' },
  { value: BuildPresetAlign.SURFACE, label: 'Surface', desc: 'Offset from surface' },
  { value: BuildPresetAlign.CARVE, label: 'Carve', desc: 'Carve into surface' },
];

const SNAP_OPTIONS: { value: BuildPresetSnapShape; label: string }[] = [
  { value: BuildPresetSnapShape.NONE, label: 'None' },
  { value: BuildPresetSnapShape.CUBE, label: 'Cube' },
  { value: BuildPresetSnapShape.PLANE, label: 'Plane' },
  { value: BuildPresetSnapShape.PRISM, label: 'Prism' },
  { value: BuildPresetSnapShape.LINE, label: 'Line' },
  { value: BuildPresetSnapShape.POINT, label: 'Point' },
  { value: BuildPresetSnapShape.CYLINDER, label: 'Cylinder' },
];

/** Max size per axis in voxel units */
const MAX_SIZE = 16;
/** Allowed size values: 0.71, 1.0, then 1.5, 2.0, 2.5 ... up to MAX_SIZE */
const SIZE_VALUES = [0.71, 1.0, ...Array.from({ length: (MAX_SIZE - 1) / 0.5 }, (_, i) => 1.5 + i * 0.5)];
/** Rotation step in degrees for the rotation control */
const ROTATION_STEP = 15;

// ============== Sub-components ==============

/** Segmented button group */
function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  renderOption,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  renderOption?: (opt: { value: T; label: string }, active: boolean) => React.ReactNode;
}) {
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            className={`
              px-2.5 py-1 rounded text-xs font-medium transition-all
              ${active
                ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-400/50'
                : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10 hover:text-white/80'
              }
            `}
          >
            {renderOption ? renderOption(opt, active) : opt.label}
          </button>
        );
      })}
    </div>
  );
}

/** Snap a raw slider index to the nearest allowed size value */
function indexToSize(index: number): number {
  return SIZE_VALUES[Math.max(0, Math.min(SIZE_VALUES.length - 1, Math.round(index)))];
}

/** Find the slider index for a given size value */
function sizeToIndex(value: number): number {
  let best = 0;
  let bestDist = Math.abs(SIZE_VALUES[0] - value);
  for (let i = 1; i < SIZE_VALUES.length; i++) {
    const d = Math.abs(SIZE_VALUES[i] - value);
    if (d < bestDist) { best = i; bestDist = d; }
  }
  return best;
}

/** Compact axis input: label + slider + value */
function AxisInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
  suffix,
  displayValue,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  displayValue?: string;
}) {
  const display = displayValue
    ?? (suffix ? `${Math.round(value)}${suffix}` : value.toFixed(value % 1 ? 2 : 0));
  return (
    <div className="flex items-center gap-1 flex-1 min-w-0">
      <span className="text-[10px] text-white/40 w-3 text-center uppercase shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="flex-1 min-w-0 h-1 accent-cyan-400 bg-white/10 rounded-full appearance-none cursor-pointer
          [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:h-2.5
          [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:cursor-pointer"
      />
      <span className="text-[10px] text-white/60 w-8 text-center shrink-0 tabular-nums">
        {display}
      </span>
    </div>
  );
}

/** Toggle switch */
function Toggle({
  label,
  checked,
  onChange,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  description?: string;
}) {
  return (
    <label className="flex items-center gap-2 cursor-pointer group">
      <div
        className={`
          relative w-8 h-4 rounded-full transition-colors
          ${checked ? 'bg-cyan-500/50' : 'bg-white/10'}
        `}
        onClick={() => onChange(!checked)}
      >
        <div
          className={`
            absolute top-0.5 w-3 h-3 rounded-full transition-all
            ${checked ? 'left-4 bg-cyan-400' : 'left-0.5 bg-white/40'}
          `}
        />
      </div>
      <div>
        <span className="text-xs text-white/70 group-hover:text-white/90">{label}</span>
        {description && (
          <span className="text-xs text-white/30 ml-1">{description}</span>
        )}
      </div>
    </label>
  );
}

/** Section header */
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-xs font-semibold text-white/40 uppercase tracking-wider mb-1.5">
      {children}
    </h4>
  );
}

// ============== Main Component ==============

export function BuildConfigTab({
  config,
  meta,
  presetId,
  onUpdateConfig,
  onUpdateMeta,
}: {
  config: BuildConfig;
  meta: PresetSlotMeta;
  presetId: number;
  onUpdateConfig: (presetId: number, updates: Partial<BuildConfig>) => void;
  onUpdateMeta: (presetId: number, updates: Partial<PresetSlotMeta>) => void;
}) {
  const { shape, mode, size, thickness, closed, arcSweep } = config;
  const { align, snapShape, autoRotateY, baseRotation } = meta;

  // Live thumbnail preview of current config
  const thumbnailUrl = usePresetThumbnail(config, meta.baseRotation);

  // Whether closed (open-ended) applies – only when there's a non-zero thickness
  const supportsClosed = (thickness ?? 0) > 0;

  // Decompose baseRotation into Euler angles for the UI
  const euler = useMemo(() => {
    if (!baseRotation) return { x: 0, y: 0, z: 0 };
    const e = quatToEuler(baseRotation);
    return {
      x: Math.round((e.x * 180) / Math.PI),
      y: Math.round((e.y * 180) / Math.PI),
      z: Math.round((e.z * 180) / Math.PI),
    };
  }, [baseRotation]);

  const handleShapeChange = useCallback((newShape: BuildShape) => {
    onUpdateConfig(presetId, { shape: newShape });
  }, [presetId, onUpdateConfig]);

  const handleModeChange = useCallback((newMode: BuildMode) => {
    onUpdateConfig(presetId, { mode: newMode });
  }, [presetId, onUpdateConfig]);

  const handleAlignChange = useCallback((newAlign: BuildPresetAlign) => {
    onUpdateMeta(presetId, { align: newAlign });
  }, [presetId, onUpdateMeta]);

  const handleSnapChange = useCallback((newSnap: BuildPresetSnapShape) => {
    onUpdateMeta(presetId, { snapShape: newSnap });
  }, [presetId, onUpdateMeta]);

  const handleRotationChange = useCallback((axis: 'x' | 'y' | 'z', degrees: number) => {
    const newEuler = { ...euler, [axis]: degrees };
    const xRad = (newEuler.x * Math.PI) / 180;
    const yRad = (newEuler.y * Math.PI) / 180;
    const zRad = (newEuler.z * Math.PI) / 180;
    // If all zero, clear baseRotation
    if (newEuler.x === 0 && newEuler.y === 0 && newEuler.z === 0) {
      onUpdateMeta(presetId, { baseRotation: undefined });
    } else {
      onUpdateMeta(presetId, { baseRotation: eulerToQuat(xRad, yRad, zRad) });
    }
  }, [euler, presetId, onUpdateMeta]);

  return (
    <div className="overflow-y-auto pr-1 scrollbar-thin space-y-3">
      {/* Live shape preview */}
      {thumbnailUrl && (
        <div className="flex justify-center">
          <img
            src={thumbnailUrl}
            alt="Shape preview"
            className="w-32 h-32 rounded-lg border border-white/10 object-cover"
            draggable={false}
          />
        </div>
      )}

      {/* Shape */}
      <div>
        <SectionHeader>Shape</SectionHeader>
        <SegmentedControl
          options={SHAPE_OPTIONS}
          value={shape}
          onChange={handleShapeChange}
          renderOption={(opt, active) => (
            <span className="flex items-center gap-1">
              <span className={active ? 'text-cyan-300' : 'text-white/50'}>{(opt as typeof SHAPE_OPTIONS[0]).icon}</span>
              {opt.label}
            </span>
          )}
        />
      </div>

      {/* Mode */}
      <div>
        <SectionHeader>Mode</SectionHeader>
        <SegmentedControl
          options={MODE_OPTIONS}
          value={mode}
          onChange={handleModeChange}
          renderOption={(opt, _active) => (
            <span className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${(opt as typeof MODE_OPTIONS[0]).color}`} />
              {opt.label}
            </span>
          )}
        />
      </div>

      {/* Size */}
      <div>
        <SectionHeader>Size</SectionHeader>
        <div className="flex gap-1.5 items-center">
          <AxisInput
            label="X"
            value={sizeToIndex(size.x)}
            onChange={(i) => onUpdateConfig(presetId, { size: { ...size, x: indexToSize(i) } })}
            min={0}
            max={SIZE_VALUES.length - 1}
            step={1}
            displayValue={size.x.toFixed(size.x % 1 ? 2 : 0)}
          />
          <AxisInput
            label="Y"
            value={sizeToIndex(size.y)}
            onChange={(i) => onUpdateConfig(presetId, { size: { ...size, y: indexToSize(i) } })}
            min={0}
            max={SIZE_VALUES.length - 1}
            step={1}
            displayValue={size.y.toFixed(size.y % 1 ? 2 : 0)}
          />
          <AxisInput
            label="Z"
            value={sizeToIndex(size.z)}
            onChange={(i) => onUpdateConfig(presetId, { size: { ...size, z: indexToSize(i) } })}
            min={0}
            max={SIZE_VALUES.length - 1}
            step={1}
            displayValue={size.z.toFixed(size.z % 1 ? 2 : 0)}
          />
        </div>
        {/* Quick uniform size */}
        <div className="flex items-center gap-1.5 mt-1.5">
          <span className="text-[10px] text-white/30">Uniform:</span>
          {[0.71, 1, 2, 4, 8].map((s) => (
            <button
              key={s}
              onClick={() => onUpdateConfig(presetId, { size: { x: s, y: s, z: s } })}
              className={`
                px-1.5 py-0.5 text-[10px] rounded border transition-all
                ${size.x === s && size.y === s && size.z === s
                  ? 'border-cyan-400/50 text-cyan-300 bg-cyan-500/20'
                  : 'border-white/10 text-white/50 bg-white/5 hover:bg-white/10'
                }
              `}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Base Rotation */}
      <div>
        <SectionHeader>Base Rotation</SectionHeader>
        <div className="flex gap-1.5 items-center">
          <AxisInput
            label="X"
            value={euler.x}
            onChange={(v) => handleRotationChange('x', Math.round(v / ROTATION_STEP) * ROTATION_STEP)}
            min={-180}
            max={180}
            step={ROTATION_STEP}
            suffix="°"
          />
          <AxisInput
            label="Y"
            value={euler.y}
            onChange={(v) => handleRotationChange('y', Math.round(v / ROTATION_STEP) * ROTATION_STEP)}
            min={-180}
            max={180}
            step={ROTATION_STEP}
            suffix="°"
          />
          <AxisInput
            label="Z"
            value={euler.z}
            onChange={(v) => handleRotationChange('z', Math.round(v / ROTATION_STEP) * ROTATION_STEP)}
            min={-180}
            max={180}
            step={ROTATION_STEP}
            suffix="°"
          />
        </div>
      </div>

      {/* Alignment */}
      <div>
        <SectionHeader>Alignment</SectionHeader>
        <div className="flex gap-1 flex-wrap">
          {ALIGN_OPTIONS.map((opt) => {
            const active = opt.value === align;
            return (
              <button
                key={opt.value}
                onClick={() => handleAlignChange(opt.value)}
                title={opt.desc}
                className={`
                  px-2.5 py-1 rounded text-xs font-medium transition-all
                  ${active
                    ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-400/50'
                    : 'bg-white/5 text-white/60 border border-white/10 hover:bg-white/10 hover:text-white/80'
                  }
                `}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Snap Shape */}
      <div>
        <SectionHeader>Snap Points</SectionHeader>
        <SegmentedControl
          options={SNAP_OPTIONS}
          value={snapShape}
          onChange={handleSnapChange}
        />
      </div>

      {/* Auto-Rotate Y */}
      <div>
        <SectionHeader>Options</SectionHeader>
        <Toggle
          label="Auto-rotate to surface"
          checked={autoRotateY ?? false}
          onChange={(v) => onUpdateMeta(presetId, { autoRotateY: v })}
          description="Shape faces into hit surface"
        />
      </div>

      {/* Hollow / Thickness */}
      <div>
          <SectionHeader>Hollow</SectionHeader>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-white/50 w-16">Thickness</span>
              <input
                type="range"
                min={0}
                max={4}
                step={0.25}
                value={thickness ?? 0}
                onChange={(e) => {
                  const v = parseFloat(e.target.value);
                  onUpdateConfig(presetId, {
                    thickness: v > 0 ? v : undefined,
                  });
                }}
                className="flex-1 h-1.5 accent-cyan-400 bg-white/10 rounded-full appearance-none cursor-pointer
                  [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 
                  [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:cursor-pointer"
              />
              <span className="text-xs text-white/60 w-8 text-center">
                {thickness ? thickness.toFixed(2) : 'Off'}
              </span>
            </div>
            {supportsClosed && (
              <Toggle
                label="Closed ends"
                checked={closed ?? true}
                onChange={(v) => onUpdateConfig(presetId, { closed: v })}
                description="Cap top and bottom"
              />
            )}
          </div>
        </div>

      {/* Arc Sweep */}
      <div>
          <SectionHeader>Arc Sweep</SectionHeader>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min={0}
              max={360}
              step={15}
              value={arcSweep ? Math.round((arcSweep * 180) / Math.PI) : 360}
              onChange={(e) => {
                const deg = parseInt(e.target.value, 10);
                onUpdateConfig(presetId, {
                  arcSweep: deg < 360 ? (deg * Math.PI) / 180 : undefined,
                });
              }}
              className="flex-1 h-1.5 accent-cyan-400 bg-white/10 rounded-full appearance-none cursor-pointer
                [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 
                [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:cursor-pointer"
            />
            <span className="text-xs text-white/60 w-10 text-center">
              {arcSweep ? `${Math.round((arcSweep * 180) / Math.PI)}°` : '360°'}
            </span>
          </div>
        </div>
    </div>
  );
}
