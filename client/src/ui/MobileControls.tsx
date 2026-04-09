/**
 * MobileControls - On-screen touch controls for mobile browsers
 *
 * Layout:
 * - Left side: Virtual joystick for movement (WASD)
 * - Right side: Touch area for camera look (replaces pointer lock mouselook)
 * - Bottom-right: Jump button + Sprint toggle
 * - Bottom-center: Build place button (when build active)
 * - Top-right: Build menu toggle
 */

import { useCallback, useEffect, useRef } from 'react';
import { controls } from '../game/player/controls';
import { useGameStore } from '../state/store';
import { storeBridge } from '../state/bridge';
import { NONE_PRESET_ID } from '@worldify/shared';

// --- Joystick constants ---
const JOYSTICK_SIZE = 140;
const JOYSTICK_KNOB = 56;
const JOYSTICK_MAX_DIST = (JOYSTICK_SIZE - JOYSTICK_KNOB) / 2;
const DEAD_ZONE = 0.15;

/** Virtual joystick for movement */
function Joystick() {
  const containerRef = useRef<HTMLDivElement>(null);
  const knobRef = useRef<HTMLDivElement>(null);
  const touchIdRef = useRef<number | null>(null);
  const originRef = useRef({ x: 0, y: 0 });

  const updateKnob = useCallback((dx: number, dy: number) => {
    if (!knobRef.current) return;
    knobRef.current.style.transform = `translate(${dx}px, ${dy}px)`;
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (touchIdRef.current !== null) return; // Already tracking
    const touch = e.changedTouches[0];
    touchIdRef.current = touch.identifier;
    const rect = containerRef.current!.getBoundingClientRect();
    originRef.current = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    // Immediately process this touch position
    const dx = touch.clientX - originRef.current.x;
    const dy = touch.clientY - originRef.current.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const clampedDist = Math.min(dist, JOYSTICK_MAX_DIST);
    const angle = Math.atan2(dy, dx);
    const clampedDx = Math.cos(angle) * clampedDist;
    const clampedDy = Math.sin(angle) * clampedDist;
    updateKnob(clampedDx, clampedDy);
    const nx = clampedDx / JOYSTICK_MAX_DIST;
    const ny = -clampedDy / JOYSTICK_MAX_DIST; // Invert Y: up = forward
    controls.setTouchMove(
      Math.abs(nx) < DEAD_ZONE ? 0 : nx,
      Math.abs(ny) < DEAD_ZONE ? 0 : ny,
    );
  }, [updateKnob]);

  useEffect(() => {
    const handleMove = (e: TouchEvent) => {
      if (touchIdRef.current === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier !== touchIdRef.current) continue;
        const dx = touch.clientX - originRef.current.x;
        const dy = touch.clientY - originRef.current.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const clampedDist = Math.min(dist, JOYSTICK_MAX_DIST);
        const angle = Math.atan2(dy, dx);
        const clampedDx = Math.cos(angle) * clampedDist;
        const clampedDy = Math.sin(angle) * clampedDist;
        updateKnob(clampedDx, clampedDy);
        const nx = clampedDx / JOYSTICK_MAX_DIST;
        const ny = -clampedDy / JOYSTICK_MAX_DIST;
        controls.setTouchMove(
          Math.abs(nx) < DEAD_ZONE ? 0 : nx,
          Math.abs(ny) < DEAD_ZONE ? 0 : ny,
        );
      }
    };

    const handleEnd = (e: TouchEvent) => {
      if (touchIdRef.current === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === touchIdRef.current) {
          touchIdRef.current = null;
          updateKnob(0, 0);
          controls.setTouchMove(0, 0);
          break;
        }
      }
    };

    window.addEventListener('touchmove', handleMove, { passive: false });
    window.addEventListener('touchend', handleEnd);
    window.addEventListener('touchcancel', handleEnd);
    return () => {
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
      window.removeEventListener('touchcancel', handleEnd);
    };
  }, [updateKnob]);

  return (
    <div
      ref={containerRef}
      onTouchStart={handleTouchStart}
      className="relative rounded-full bg-white/10 border border-white/20 touch-none"
      style={{ width: JOYSTICK_SIZE, height: JOYSTICK_SIZE }}
    >
      {/* Knob */}
      <div
        ref={knobRef}
        className="absolute rounded-full bg-white/40 border-2 border-white/60 shadow-lg"
        style={{
          width: JOYSTICK_KNOB,
          height: JOYSTICK_KNOB,
          left: (JOYSTICK_SIZE - JOYSTICK_KNOB) / 2,
          top: (JOYSTICK_SIZE - JOYSTICK_KNOB) / 2,
          transition: 'none',
        }}
      />
    </div>
  );
}

/** Camera look area — right side of screen */
function LookArea() {
  const touchIdRef = useRef<number | null>(null);
  const lastPosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const handleMove = (e: TouchEvent) => {
      if (touchIdRef.current === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        const touch = e.changedTouches[i];
        if (touch.identifier !== touchIdRef.current) continue;
        const dx = touch.clientX - lastPosRef.current.x;
        const dy = touch.clientY - lastPosRef.current.y;
        lastPosRef.current = { x: touch.clientX, y: touch.clientY };
        controls.applyTouchLook(dx, dy);
      }
    };

    const handleEnd = (e: TouchEvent) => {
      if (touchIdRef.current === null) return;
      for (let i = 0; i < e.changedTouches.length; i++) {
        if (e.changedTouches[i].identifier === touchIdRef.current) {
          touchIdRef.current = null;
          break;
        }
      }
    };

    window.addEventListener('touchmove', handleMove, { passive: false });
    window.addEventListener('touchend', handleEnd);
    window.addEventListener('touchcancel', handleEnd);
    return () => {
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleEnd);
      window.removeEventListener('touchcancel', handleEnd);
    };
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (touchIdRef.current !== null) return;
    const touch = e.changedTouches[0];
    touchIdRef.current = touch.identifier;
    lastPosRef.current = { x: touch.clientX, y: touch.clientY };
  }, []);

  return (
    <div
      onTouchStart={handleTouchStart}
      className="absolute top-0 right-0 touch-none"
      style={{ width: '50%', height: '100%' }}
    />
  );
}

/** Round action button */
function ActionButton({
  label,
  icon,
  size = 64,
  active = false,
  onTouchStart,
  onTouchEnd,
  onClick,
  className = '',
}: {
  label: string;
  icon?: string;
  size?: number;
  active?: boolean;
  onTouchStart?: () => void;
  onTouchEnd?: () => void;
  onClick?: () => void;
  className?: string;
}) {
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      e.stopPropagation();
      onTouchStart?.();
    },
    [onTouchStart],
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      e.stopPropagation();
      onTouchEnd?.();
      onClick?.();
    },
    [onTouchEnd, onClick],
  );

  return (
    <div
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className={`flex items-center justify-center rounded-full touch-none select-none
        ${active ? 'bg-white/40 border-white/70' : 'bg-white/15 border-white/30'}
        border-2 shadow-lg transition-colors ${className}`}
      style={{ width: size, height: size }}
    >
      <span className="text-white font-bold text-sm pointer-events-none">
        {icon || label}
      </span>
    </div>
  );
}

/** Build preset quick-select strip for mobile */
function MobileBuildStrip() {
  const build = useGameStore((s) => s.build);

  return (
    <div className="flex gap-1.5 items-center">
      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((id) => {
        const isActive = build.presetId === id;
        const isNone = id === NONE_PRESET_ID;
        return (
          <button
            key={id}
            onTouchStart={(e) => {
              e.stopPropagation();
              storeBridge.selectBuildPreset(id);
            }}
            className={`flex items-center justify-center rounded-lg touch-none
              w-10 h-10 text-xs font-bold transition-colors
              ${isActive
                ? 'bg-cyan-500/60 text-white border border-cyan-400'
                : 'bg-black/60 text-white/70 border border-white/20'
              }`}
          >
            {isNone ? 'X' : id}
          </button>
        );
      })}
    </div>
  );
}

export function MobileControls() {
  const build = useGameStore((s) => s.build);
  const buildActive = build.presetId !== NONE_PRESET_ID;
  const sprintActiveRef = useRef(false);

  const handleJumpStart = useCallback(() => {
    controls.setTouchJump(true);
  }, []);

  const handleJumpEnd = useCallback(() => {
    controls.setTouchJump(false);
  }, []);

  const handleSprintToggle = useCallback(() => {
    sprintActiveRef.current = !sprintActiveRef.current;
    controls.setTouchSprint(sprintActiveRef.current);
  }, []);

  const handleBuildPlace = useCallback(() => {
    controls.triggerBuildPlace();
  }, []);

  const handleRotateLeft = useCallback(() => {
    storeBridge.rotateBuild(-1);
  }, []);

  const handleRotateRight = useCallback(() => {
    storeBridge.rotateBuild(1);
  }, []);

  const handleBuildMenu = useCallback(() => {
    storeBridge.toggleBuildMenu();
  }, []);

  return (
    <div className="fixed inset-0 z-[60] pointer-events-none">
      {/* Camera look area - covers right half, behind buttons */}
      <div className="pointer-events-auto">
        <LookArea />
      </div>

      {/* Joystick - bottom left */}
      <div className="absolute bottom-8 left-6 pointer-events-auto">
        <Joystick />
      </div>

      {/* Jump button - bottom right */}
      <div className="absolute bottom-8 right-6 pointer-events-auto">
        <ActionButton
          label="Jump"
          icon="^"
          size={72}
          onTouchStart={handleJumpStart}
          onTouchEnd={handleJumpEnd}
        />
      </div>

      {/* Sprint button - above jump */}
      <div className="absolute bottom-28 right-6 pointer-events-auto">
        <ActionButton
          label="Sprint"
          icon="S"
          size={52}
          active={sprintActiveRef.current}
          onClick={handleSprintToggle}
        />
      </div>

      {/* Build controls - only when a build preset is active */}
      {buildActive && (
        <>
          {/* Place button - center right */}
          <div className="absolute bottom-8 right-24 pointer-events-auto">
            <ActionButton
              label="Place"
              icon="+"
              size={72}
              onClick={handleBuildPlace}
              className="bg-green-500/30 border-green-400/60"
            />
          </div>

          {/* Rotate buttons - above place */}
          <div className="absolute bottom-28 right-28 flex gap-2 pointer-events-auto">
            <ActionButton label="Q" icon="<" size={44} onClick={handleRotateLeft} />
            <ActionButton label="E" icon=">" size={44} onClick={handleRotateRight} />
          </div>
        </>
      )}

      {/* Build menu toggle - top right */}
      <div className="absolute top-4 right-4 pointer-events-auto">
        <ActionButton
          label="Build"
          icon="B"
          size={44}
          onClick={handleBuildMenu}
        />
      </div>

      {/* Build preset strip - bottom center */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-auto">
        <MobileBuildStrip />
      </div>
    </div>
  );
}
