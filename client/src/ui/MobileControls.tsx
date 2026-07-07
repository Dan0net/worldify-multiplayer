/**
 * MobileControls - touch input overlay (landscape-first).
 *
 * Layout:
 * - Left half  → floating virtual joystick (movement, 8-way via controls.setTouchMove)
 * - Right half → drag to look (controls.applyLookDelta)
 * - Centre     → draggable build reticle; releasing places the build (place-on-release)
 * - Buttons    → Jump (hold), Sprint (toggle), Rotate ±, Build menu, Map, Pause
 *
 * Rendered only on touch devices while Playing. All zones use touch-action:none;
 * multi-touch works because each zone/button is a separate element tracking its
 * own pointerId.
 */

import { useEffect, useRef, useState } from 'react';
import { INPUT_JUMP, INPUT_SPRINT, GameMode, NONE_PRESET_ID } from '@worldify/shared';
import { controls } from '../game/player/controls';
import { storeBridge } from '../state/bridge';
import { useGameStore } from '../state/store';

const JOY_RADIUS = 55; // px from centre to full deflection

function toNDC(clientX: number, clientY: number): { x: number; y: number } {
  return {
    x: (clientX / window.innerWidth) * 2 - 1,
    y: -(clientY / window.innerHeight) * 2 + 1,
  };
}

export function MobileControls() {
  const buildEnabled = useGameStore((s) => s.build.presetId !== NONE_PRESET_ID);
  const setGameMode = useGameStore((s) => s.setGameMode);
  const toggleMapOverlay = useGameStore((s) => s.toggleMapOverlay);

  const [sprintOn, setSprintOn] = useState(false);
  const [joy, setJoy] = useState<{ baseX: number; baseY: number; dx: number; dy: number } | null>(null);

  const joyId = useRef<number | null>(null);
  const lookId = useRef<{ id: number; x: number; y: number } | null>(null);
  const reticleId = useRef<number | null>(null);

  // On mount rest the cast point at screen centre (== desktop centre-ray);
  // on unmount restore null so desktop uses the camera-forward ray.
  useEffect(() => {
    controls.castNDC = { x: 0, y: 0 };
    return () => {
      controls.castNDC = null;
      controls.setTouchMove(0, 0);
      controls.setTouchButton(INPUT_JUMP, false);
      controls.setTouchButton(INPUT_SPRINT, false);
    };
  }, []);

  // ---- Joystick (left half) ----
  const onJoyDown = (e: React.PointerEvent) => {
    if (joyId.current !== null) return;
    joyId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setJoy({ baseX: e.clientX, baseY: e.clientY, dx: 0, dy: 0 });
  };
  const onJoyMove = (e: React.PointerEvent) => {
    if (joyId.current !== e.pointerId || !joy) return;
    let dx = e.clientX - joy.baseX;
    let dy = e.clientY - joy.baseY;
    const len = Math.hypot(dx, dy);
    if (len > JOY_RADIUS) { dx = (dx / len) * JOY_RADIUS; dy = (dy / len) * JOY_RADIUS; }
    controls.setTouchMove(dx / JOY_RADIUS, dy / JOY_RADIUS);
    setJoy({ ...joy, dx, dy });
  };
  const onJoyUp = (e: React.PointerEvent) => {
    if (joyId.current !== e.pointerId) return;
    joyId.current = null;
    controls.setTouchMove(0, 0);
    setJoy(null);
  };

  // ---- Look (right half) ----
  const onLookDown = (e: React.PointerEvent) => {
    if (lookId.current !== null) return;
    lookId.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onLookMove = (e: React.PointerEvent) => {
    const l = lookId.current;
    if (!l || l.id !== e.pointerId) return;
    controls.applyLookDelta(e.clientX - l.x, e.clientY - l.y);
    l.x = e.clientX; l.y = e.clientY;
  };
  const onLookUp = (e: React.PointerEvent) => {
    if (lookId.current?.id === e.pointerId) lookId.current = null;
  };

  // ---- Reticle (centre): drag to aim, release to place ----
  const onReticleDown = (e: React.PointerEvent) => {
    e.stopPropagation();
    reticleId.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onReticleMove = (e: React.PointerEvent) => {
    if (reticleId.current !== e.pointerId) return;
    e.stopPropagation();
    controls.castNDC = toNDC(e.clientX, e.clientY);
  };
  const onReticleUp = (e: React.PointerEvent) => {
    if (reticleId.current !== e.pointerId) return;
    e.stopPropagation();
    reticleId.current = null;
    controls.triggerPlace();
    controls.castNDC = { x: 0, y: 0 }; // recentre
  };

  // ---- Buttons ----
  const holdJump = (on: boolean) => controls.setTouchButton(INPUT_JUMP, on);
  const toggleSprint = () => {
    const next = !sprintOn;
    setSprintOn(next);
    controls.setTouchButton(INPUT_SPRINT, next);
  };

  const btn = 'pointer-events-auto flex items-center justify-center rounded-full bg-black/50 border border-white/20 text-white/90 active:bg-white/25 select-none';

  return (
    <div className="fixed inset-0 z-40 pointer-events-none select-none" style={{ touchAction: 'none' }}>
      {/* Movement zone (left half) */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1/2 pointer-events-auto"
        style={{ touchAction: 'none' }}
        onPointerDown={onJoyDown}
        onPointerMove={onJoyMove}
        onPointerUp={onJoyUp}
        onPointerCancel={onJoyUp}
      />
      {/* Look zone (right half) */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1/2 pointer-events-auto"
        style={{ touchAction: 'none' }}
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />

      {/* Joystick visual (floating where finger landed) */}
      {joy && (
        <>
          <div
            className="absolute rounded-full border-2 border-white/25"
            style={{ left: joy.baseX - JOY_RADIUS, top: joy.baseY - JOY_RADIUS, width: JOY_RADIUS * 2, height: JOY_RADIUS * 2 }}
          />
          <div
            className="absolute rounded-full bg-white/40"
            style={{ left: joy.baseX + joy.dx - 22, top: joy.baseY + joy.dy - 22, width: 44, height: 44 }}
          />
        </>
      )}

      {/* Build reticle (centre) — only in build mode */}
      {buildEnabled && (
        <div
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-14 h-14 rounded-full border-2 border-cyan-300/80 bg-cyan-300/10 pointer-events-auto"
          style={{ touchAction: 'none' }}
          onPointerDown={onReticleDown}
          onPointerMove={onReticleMove}
          onPointerUp={onReticleUp}
          onPointerCancel={onReticleUp}
        >
          <div className="absolute top-1/2 left-1/2 w-1.5 h-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-200" />
        </div>
      )}

      {/* Right-side action buttons */}
      <div
        className="absolute bottom-4 right-4 flex flex-col items-end gap-3"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)', paddingRight: 'env(safe-area-inset-right)' }}
      >
        <div className="flex gap-3">
          {buildEnabled && (
            <>
              <button className={`${btn} w-12 h-12 text-lg`} onPointerDown={(e) => { e.preventDefault(); storeBridge.rotateBuild(-1); }} aria-label="Rotate left">⟲</button>
              <button className={`${btn} w-12 h-12 text-lg`} onPointerDown={(e) => { e.preventDefault(); storeBridge.rotateBuild(1); }} aria-label="Rotate right">⟳</button>
            </>
          )}
          <button
            className={`${btn} w-14 h-14 text-2xl ${sprintOn ? '!bg-cyan-500/40 border-cyan-300' : ''}`}
            onPointerDown={(e) => { e.preventDefault(); toggleSprint(); }}
            aria-label="Toggle sprint"
          >»</button>
          <button
            className={`${btn} w-20 h-20 text-3xl`}
            onPointerDown={(e) => { e.preventDefault(); holdJump(true); }}
            onPointerUp={(e) => { e.preventDefault(); holdJump(false); }}
            onPointerCancel={() => holdJump(false)}
            onPointerLeave={() => holdJump(false)}
            aria-label="Jump"
          >⤒</button>
        </div>
      </div>

      {/* Top-right utility buttons */}
      <div
        className="absolute top-2 right-2 flex gap-2"
        style={{ paddingTop: 'env(safe-area-inset-top)', paddingRight: 'env(safe-area-inset-right)' }}
      >
        <button className={`${btn} w-11 h-11 text-lg`} onPointerDown={(e) => { e.preventDefault(); storeBridge.setBuildMenuOpen(true); }} aria-label="Build menu">🧱</button>
        <button className={`${btn} w-11 h-11 text-lg`} onPointerDown={(e) => { e.preventDefault(); toggleMapOverlay(); }} aria-label="Toggle map">🗺</button>
        <button className={`${btn} w-11 h-11 text-lg`} onPointerDown={(e) => { e.preventDefault(); setGameMode(GameMode.MainMenu); }} aria-label="Menu">☰</button>
      </div>
    </div>
  );
}
