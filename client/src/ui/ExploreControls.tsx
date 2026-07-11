/**
 * ExploreControls — full-screen pointer surface for the free explore camera.
 *
 * Desktop:  left-drag = pan, right-drag = rotate, wheel = zoom.
 * Touch:    one finger = pan, two fingers = rotate + pinch-zoom.
 *
 * Sits below the home overlay (whose buttons/panels capture their own taps) and
 * above the canvas. Taps (no drag) are reserved for the spawn-marker flow (added in
 * the next PR); this component only drives the camera.
 */

import { useRef } from 'react';
import {
  exploreCameraPan,
  exploreCameraRotate,
  exploreCameraZoom,
  exploreCameraPinch,
} from '../game/scene/ExploreCamera';

interface Pt { x: number; y: number; }

export function ExploreControls() {
  const pointers = useRef(new Map<number, Pt>());
  const button = useRef(0); // mouse button that started the drag (2 = right)
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'mouse') button.current = e.button;
    if (pointers.current.size === 2) pinch.current = null; // reset on second finger
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const map = pointers.current;
    const prev = map.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    map.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (map.size >= 2) {
      // Two-finger: rotate by centroid translation + pinch-zoom by distance change.
      const [a, b] = [...map.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (pinch.current) {
        exploreCameraRotate(cx - pinch.current.cx, cy - pinch.current.cy);
        exploreCameraPinch(dist - pinch.current.dist);
      }
      pinch.current = { dist, cx, cy };
    } else if (e.pointerType === 'mouse' && button.current === 2) {
      exploreCameraRotate(dx, dy);
    } else {
      exploreCameraPan(dx, dy);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    exploreCameraZoom(e.deltaY);
  };

  return (
    <div
      className="fixed inset-0 z-30"
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
