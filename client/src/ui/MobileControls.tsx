/**
 * MobileControls - touch input overlay (landscape-first).
 *
 * - Left screen half  → move; a persistent joystick pad sits bottom-left.
 * - Right screen half → look; a persistent look pad sits bottom-right.
 * - Action buttons (Build-toggle / Rotate / Sprint / Jump) sit ABOVE the look pad.
 * - Pause sits top-right.
 * - Centre → draggable build reticle; releasing places the build.
 *
 * In portrait the pads are raised so the build bar (bottom-centre) sits below
 * them; in landscape the pads are in the bottom corners with the bar between.
 */

import { useEffect, useRef, useState } from 'react';
import { ChevronUp, FastForward, Hammer, Undo2, RotateCw, Grid3x3, Check } from 'lucide-react';
import { INPUT_JUMP, INPUT_SPRINT } from '@worldify/shared';
import { controls } from '../game/player/controls';
import { useGameStore } from '../state/store';
import { usePresetThumbnail } from './usePresetThumbnail';
import { THUMB_PRIORITY } from './PresetThumbnailRenderer';

const JOY_RADIUS = 55; // px of finger travel = full deflection
const PAD_SIZE = 140;
const KNOB = 56;
const KNOB_MAX = (PAD_SIZE - KNOB) / 2;
const TOUCH_LOOK_GAIN = 5; // touch look is slower than a mouse; amplify

function toNDC(clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: (clientX / window.innerWidth) * 2 - 1,
    y: -(clientY / window.innerHeight) * 2 + 1,
  };
}

function knobOffset(delta: number): number {
  return Math.max(-1, Math.min(1, delta / JOY_RADIUS)) * KNOB_MAX;
}

export function MobileControls() {
  const buildEnabled = useGameStore((s) => s.build.buildMode);
  const toggleBuildMenu = useGameStore((s) => s.toggleBuildMenu);
  const toggleBuildMode = useGameStore((s) => s.toggleBuildMode);
  // Narrow selectors — the current build's config/rotation only change on
  // selection, not per frame (unlike hasValidTarget), so this won't thrash.
  const currentConfig = useGameStore((s) => s.build.presetConfigs[s.build.presetId]);
  const currentRotation = useGameStore((s) => s.build.presetMeta[s.build.presetId]?.baseRotation);
  const buildThumb = usePresetThumbnail(currentConfig, currentRotation, { priority: THUMB_PRIORITY.HIGH });

  const [sprintOn, setSprintOn] = useState(false);
  const [joy, setJoy] = useState<{ dx: number; dy: number } | null>(null);
  const [lookVis, setLookVis] = useState<{ dx: number; dy: number } | null>(null);
  const [reticlePos, setReticlePos] = useState<{ x: number; y: number } | null>(null);

  const joy0 = useRef<{ id: number; x: number; y: number } | null>(null);
  const look0 = useRef<{ id: number; x: number; y: number; sx: number; sy: number } | null>(null);
  const reticleId = useRef<number | null>(null);

  useEffect(() => {
    controls.castNDC = { x: 0, y: 0 };
    return () => {
      controls.castNDC = null;
      controls.setTouchMove(0, 0);
      controls.setTouchButton(INPUT_JUMP, false);
      controls.setTouchButton(INPUT_SPRINT, false);
    };
  }, []);

  // The build-item bar is gone, so the pads sit low in both orientations.
  const padBottom = 24;

  // ---- Move (left half) ----
  const onJoyDown = (e: React.PointerEvent) => {
    if (joy0.current !== null) return;
    joy0.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setJoy({ dx: 0, dy: 0 });
  };
  const onJoyMove = (e: React.PointerEvent) => {
    const j = joy0.current;
    if (!j || j.id !== e.pointerId) return;
    const dx = e.clientX - j.x;
    const dy = e.clientY - j.y;
    controls.setTouchMove(dx / JOY_RADIUS, dy / JOY_RADIUS);
    setJoy({ dx, dy });
  };
  const onJoyUp = (e: React.PointerEvent) => {
    if (joy0.current?.id !== e.pointerId) return;
    joy0.current = null;
    controls.setTouchMove(0, 0);
    setJoy(null);
  };

  // ---- Look (right half) ----
  const onLookDown = (e: React.PointerEvent) => {
    if (look0.current !== null) return;
    look0.current = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
    setLookVis({ dx: 0, dy: 0 });
  };
  const onLookMove = (e: React.PointerEvent) => {
    const l = look0.current;
    if (!l || l.id !== e.pointerId) return;
    controls.applyLookDelta((e.clientX - l.x) * TOUCH_LOOK_GAIN, (e.clientY - l.y) * TOUCH_LOOK_GAIN);
    l.x = e.clientX;
    l.y = e.clientY;
    setLookVis({ dx: e.clientX - l.sx, dy: e.clientY - l.sy });
  };
  const onLookUp = (e: React.PointerEvent) => {
    if (look0.current?.id !== e.pointerId) return;
    look0.current = null;
    setLookVis(null);
  };

  // ---- Reticle (centre): drag to move the cast point; a Place button commits ----
  const onReticleDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    reticleId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onReticleMove = (e: React.PointerEvent) => {
    if (reticleId.current !== e.pointerId) return;
    e.stopPropagation();
    setReticlePos({ x: e.clientX, y: e.clientY }); // move the on-screen crosshair
    controls.castNDC = toNDC(e.clientX, e.clientY);
  };
  const onReticleUp = (e: React.PointerEvent) => {
    if (reticleId.current !== e.pointerId) return;
    e.stopPropagation();
    reticleId.current = null;
    // Leave the reticle where it was dragged; placement happens via the Place button.
  };

  const holdJump = (on: boolean) => controls.setTouchButton(INPUT_JUMP, on);
  const toggleSprint = () => {
    const next = !sprintOn;
    setSprintOn(next);
    controls.setTouchButton(INPUT_SPRINT, next);
  };

  // Round icon button — stronger contrast + consistent icon sizing than the old emoji glyphs.
  const btn = 'pointer-events-auto flex items-center justify-center rounded-full bg-black/55 border border-white/25 text-white active:scale-90 active:bg-white/15 transition-transform shadow-lg select-none';
  const pad = 'absolute rounded-full border-2 border-white/20 bg-white/5 pointer-events-none';
  const knob = 'absolute rounded-full bg-white/40 pointer-events-none';
  const label = 'absolute text-white/40 text-[10px] pointer-events-none text-center';

  return (
    <div className="fixed inset-0 z-40 pointer-events-none select-none" style={{ touchAction: 'none' }}>
      {/* Touch zones (full halves) */}
      <div className="absolute left-0 top-0 bottom-0 w-1/2 pointer-events-auto" style={{ touchAction: 'none' }}
        onPointerDown={onJoyDown} onPointerMove={onJoyMove} onPointerUp={onJoyUp} onPointerCancel={onJoyUp} />
      <div className="absolute right-0 top-0 bottom-0 w-1/2 pointer-events-auto" style={{ touchAction: 'none' }}
        onPointerDown={onLookDown} onPointerMove={onLookMove} onPointerUp={onLookUp} onPointerCancel={onLookUp} />

      {/* MOVE pad (bottom-left) */}
      <div className={pad} style={{ left: 24, bottom: padBottom, width: PAD_SIZE, height: PAD_SIZE }} />
      <div className={knob} style={{ left: 24 + KNOB_MAX + knobOffset(joy?.dx ?? 0), bottom: padBottom + KNOB_MAX - knobOffset(joy?.dy ?? 0), width: KNOB, height: KNOB }} />
      <div className={label} style={{ left: 24, bottom: padBottom + PAD_SIZE + 2, width: PAD_SIZE }}>MOVE</div>

      {/* LOOK pad (bottom-right) */}
      <div className={pad} style={{ right: 24, bottom: padBottom, width: PAD_SIZE, height: PAD_SIZE }} />
      <div className={knob} style={{ right: 24 + KNOB_MAX - knobOffset(lookVis?.dx ?? 0), bottom: padBottom + KNOB_MAX - knobOffset(lookVis?.dy ?? 0), width: KNOB, height: KNOB }} />
      <div className={label} style={{ right: 24, bottom: padBottom + PAD_SIZE + 2, width: PAD_SIZE }}>LOOK</div>

      {/* Build reticle — draggable; follows the finger so the crosshair moves */}
      {buildEnabled && (
        <div
          className="absolute w-16 h-16 rounded-full border-2 border-cyan-300/80 bg-cyan-300/10 pointer-events-auto"
          style={
            reticlePos
              ? { left: reticlePos.x, top: reticlePos.y, transform: 'translate(-50%,-50%)', touchAction: 'none' }
              : { left: '50%', top: '50%', transform: 'translate(-50%,-50%)', touchAction: 'none' }
          }
          onPointerDown={onReticleDown} onPointerMove={onReticleMove} onPointerUp={onReticleUp} onPointerCancel={onReticleUp}
        >
          <div className="absolute top-1/2 left-1/2 w-2 h-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-200" />
        </div>
      )}

      {/* Action buttons — ABOVE the look pad (bottom-right).
          Bottom row (always): build-mode toggle · run · jump.
          Top row (build mode only): undo · rotate · build menu · place. */}
      <div
        className="absolute right-4 flex flex-col items-end gap-2.5"
        style={{ bottom: padBottom + PAD_SIZE + 20, paddingRight: 'env(safe-area-inset-right)' }}
      >
        {buildEnabled && (
          <div className="flex items-center gap-2.5">
            <button className={`${btn} w-12 h-12`} onPointerDown={(e) => { e.preventDefault(); controls.triggerUndo(); }} aria-label="Undo">
              <Undo2 size={22} strokeWidth={2.2} />
            </button>
            <button className={`${btn} w-12 h-12`} onPointerDown={(e) => { e.preventDefault(); useGameStore.getState().rotateBuild(1); }} aria-label="Rotate">
              <RotateCw size={22} strokeWidth={2.2} />
            </button>
            <button className={`${btn} w-12 h-12`} onPointerDown={(e) => { e.preventDefault(); toggleBuildMenu(); }} aria-label="Build menu">
              <Grid3x3 size={22} strokeWidth={2.2} />
            </button>
            <button className={`${btn} w-14 h-14 !bg-green-600/70 !border-green-300/70`} onPointerDown={(e) => { e.preventDefault(); controls.triggerPlace(); }} aria-label="Place build">
              <Check size={28} strokeWidth={2.6} />
            </button>
          </div>
        )}
        <div className="flex items-center gap-2.5">
          <button
            className={`${btn} w-12 h-12 overflow-hidden ${buildEnabled ? '!border-cyan-300/70 ring-2 ring-cyan-400/40' : ''}`}
            onPointerDown={(e) => { e.preventDefault(); toggleBuildMode(); }}
            aria-label={buildEnabled ? 'Exit build mode' : 'Enter build mode'}
          >
            {buildEnabled && buildThumb
              ? <img src={buildThumb} alt="" className="w-9 h-9 object-contain" draggable={false} />
              : <Hammer size={22} strokeWidth={2.2} />}
          </button>
          <button
            className={`${btn} w-12 h-12 ${sprintOn ? '!bg-cyan-500/40 !border-cyan-300' : ''}`}
            onPointerDown={(e) => { e.preventDefault(); toggleSprint(); }}
            aria-label="Toggle run"
          >
            <FastForward size={22} strokeWidth={2.2} />
          </button>
          <button
            className={`${btn} w-16 h-16`}
            onPointerDown={(e) => { e.preventDefault(); holdJump(true); }}
            onPointerUp={(e) => { e.preventDefault(); holdJump(false); }}
            onPointerCancel={() => holdJump(false)}
            onPointerLeave={() => holdJump(false)}
            aria-label="Jump"
          >
            <ChevronUp size={30} strokeWidth={2.6} />
          </button>
        </div>
      </div>

      {/* The menu (X) button lives in the top-right map cluster (MapOverlay). */}
    </div>
  );
}
