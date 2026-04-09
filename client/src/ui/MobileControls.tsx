/**
 * MobileControls - On-screen touch controls for mobile browsers
 *
 * Layout philosophy: RIGHT SIDE is the look area (clear touch zone).
 * Buttons live at the edges/corners so they don't block camera look.
 *
 * ┌─────────────────────────────────┐
 * │ [Menu]            [map] │
 * │                                 │
 * │                                 │
 * │            LOOK AREA            │
 * │                                 │
 * │                  [Rot] [Sprint] │
 * │  [Joystick]  [Place]    [Jump] │
 * │       [====Build Strip====]     │
 * └─────────────────────────────────┘
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { controls } from '../game/player/controls';
import { useGameStore } from '../state/store';
import { storeBridge } from '../state/bridge';
import { NONE_PRESET_ID } from '@worldify/shared';
import {
  ChevronUp,
  Zap,
  Hammer,
  Plus,
  RotateCcw,
  RotateCw,
} from 'lucide-react';

// --- Joystick constants ---
const JOYSTICK_SIZE = 130;
const JOYSTICK_KNOB = 52;
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
    if (touchIdRef.current !== null) return;
    const touch = e.changedTouches[0];
    touchIdRef.current = touch.identifier;
    const rect = containerRef.current!.getBoundingClientRect();
    originRef.current = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
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

/** Camera look area — fills the right portion of the screen (behind all buttons) */
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
      className="absolute inset-0 touch-none"
    />
  );
}

/** Round action button with Lucide icon */
function ActionButton({
  children,
  size = 60,
  active = false,
  onTouchStart,
  onTouchEnd,
  onClick,
  className = '',
}: {
  children: React.ReactNode;
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
      {children}
    </div>
  );
}

/** Build preset quick-select strip for mobile */
function MobileBuildStrip() {
  const build = useGameStore((s) => s.build);

  return (
    <div className="flex gap-1 items-center overflow-x-auto max-w-[85vw] px-1">
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
            className={`flex-shrink-0 flex items-center justify-center rounded-lg touch-none
              w-9 h-9 text-xs font-bold transition-colors
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
  const [sprintActive, setSprintActive] = useState(false);

  const handleJumpStart = useCallback(() => {
    controls.setTouchJump(true);
  }, []);

  const handleJumpEnd = useCallback(() => {
    controls.setTouchJump(false);
  }, []);

  const handleSprintToggle = useCallback(() => {
    setSprintActive((prev) => {
      const next = !prev;
      controls.setTouchSprint(next);
      return next;
    });
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
      {/* Look area — full screen, lowest z-order so buttons sit on top */}
      <div className="pointer-events-auto">
        <LookArea />
      </div>

      {/* ===== LEFT SIDE ===== */}

      {/* Build menu toggle — top left (away from minimap) */}
      <div className="absolute top-4 left-4 pointer-events-auto">
        <ActionButton size={44} onClick={handleBuildMenu}>
          <Hammer size={22} className="text-white" strokeWidth={2.5} />
        </ActionButton>
      </div>

      {/* Joystick — bottom left */}
      <div className="absolute bottom-14 left-4 pointer-events-auto">
        <Joystick />
      </div>

      {/* ===== RIGHT SIDE — buttons around the edges ===== */}

      {/* Jump — bottom right corner (primary action, large) */}
      <div className="absolute bottom-14 right-4 pointer-events-auto">
        <ActionButton
          size={68}
          onTouchStart={handleJumpStart}
          onTouchEnd={handleJumpEnd}
        >
          <ChevronUp size={32} className="text-white" strokeWidth={3} />
        </ActionButton>
      </div>

      {/* Sprint — above jump */}
      <div className="absolute bottom-36 right-4 pointer-events-auto">
        <ActionButton
          size={48}
          active={sprintActive}
          onClick={handleSprintToggle}
        >
          <Zap
            size={22}
            className={sprintActive ? 'text-yellow-300' : 'text-white'}
            strokeWidth={2.5}
            fill={sprintActive ? 'currentColor' : 'none'}
          />
        </ActionButton>
      </div>

      {/* Build controls — only when a build preset is active */}
      {buildActive && (
        <>
          {/* Place — to the left of jump */}
          <div className="absolute bottom-14 right-20 pointer-events-auto">
            <ActionButton
              size={60}
              onClick={handleBuildPlace}
              className="bg-green-500/25 border-green-400/50"
            >
              <Plus size={28} className="text-green-300" strokeWidth={3} />
            </ActionButton>
          </div>

          {/* Rotate — above the place button */}
          <div className="absolute bottom-36 right-16 flex gap-2 pointer-events-auto">
            <ActionButton size={40} onClick={handleRotateLeft}>
              <RotateCcw size={18} className="text-white" strokeWidth={2.5} />
            </ActionButton>
            <ActionButton size={40} onClick={handleRotateRight}>
              <RotateCw size={18} className="text-white" strokeWidth={2.5} />
            </ActionButton>
          </div>
        </>
      )}

      {/* ===== BOTTOM CENTER ===== */}

      {/* Build preset strip */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 pointer-events-auto">
        <MobileBuildStrip />
      </div>
    </div>
  );
}
