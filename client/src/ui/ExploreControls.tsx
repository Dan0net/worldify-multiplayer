/**
 * ExploreControls — full-screen pointer surface for explore mode.
 *
 * Camera:  desktop left-drag = pan, right-drag = rotate, wheel = zoom;
 *          touch one finger = pan, two fingers = rotate + pinch-zoom.
 * Marker:  tap the ground places/moves the spawn marker; dragging a finger that
 *          started ON the marker moves it along the terrain. (The floating Play
 *          button — not a tap — starts the game.)
 *
 * Sits below the home overlay (whose buttons capture their own taps) and above the
 * canvas.
 */

import { useRef, useState } from 'react';
import {
  exploreCameraPan,
  exploreCameraRotate,
  exploreCameraZoom,
  exploreCameraPinch,
  setExploreMarkerInteracting,
  beginExploreTargetGlide,
} from '../game/scene/ExploreCamera';
import {
  isMarkerPlaced, getMarkerBase, placeMarkerFromNDC, placeMarkerAt, raycastMarkerNDC,
} from '../game/spawn/SpawnMarker';
import { getCamera } from '../game/scene/camera';

interface Pt { x: number; y: number; }

const TAP_PX = 6;      // movement under this = a tap, not a drag
const GRAB_PX = 55;    // tap/drag within this of the marker grabs it

function toNDC(x: number, y: number): { x: number; y: number } {
  return { x: (x / window.innerWidth) * 2 - 1, y: -(y / window.innerHeight) * 2 + 1 };
}

/** True if screen point (x,y) is within grab range of the placed marker. */
function nearMarker(x: number, y: number): boolean {
  const camera = getCamera();
  if (!camera || !isMarkerPlaced()) return false;
  const v = getMarkerBase().clone().project(camera);
  const sx = (v.x * 0.5 + 0.5) * window.innerWidth;
  const sy = (-v.y * 0.5 + 0.5) * window.innerHeight;
  return Math.hypot(x - sx, y - sy) <= GRAB_PX;
}

export function ExploreControls() {
  const pointers = useRef(new Map<number, Pt>());
  const button = useRef(0);
  const pinch = useRef<{ dist: number; cx: number; cy: number } | null>(null);
  // Single-pointer gesture state
  const mode = useRef<'camera' | 'marker'>('camera');
  const moved = useRef(0); // accumulated movement (px) to distinguish tap vs drag
  // Desktop cursor: hand (grab) over the world, closed hand (grabbing) while dragging.
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (e.pointerType === 'mouse') { button.current = e.button; setDragging(true); }
    if (pointers.current.size === 1) {
      moved.current = 0;
      mode.current = (e.pointerType !== 'mouse' || e.button === 0) && nearMarker(e.clientX, e.clientY)
        ? 'marker' : 'camera';
      // Grabbing the marker suspends center-follow so the drag isn't overridden.
      setExploreMarkerInteracting(mode.current === 'marker');
    } else {
      pinch.current = null;   // two fingers → camera rotate/zoom
      mode.current = 'camera';
      setExploreMarkerInteracting(false);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const map = pointers.current;
    const prev = map.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x;
    const dy = e.clientY - prev.y;
    map.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved.current += Math.hypot(dx, dy);

    if (map.size >= 2) {
      const [a, b] = [...map.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const cx = (a.x + b.x) / 2;
      const cy = (a.y + b.y) / 2;
      if (pinch.current) {
        exploreCameraRotate(cx - pinch.current.cx, cy - pinch.current.cy);
        exploreCameraPinch(dist - pinch.current.dist);
      }
      pinch.current = { dist, cx, cy };
    } else if (mode.current === 'marker') {
      // Drag the marker along the terrain under the finger.
      const camera = getCamera();
      if (camera) {
        const hit = raycastMarkerNDC(toNDC(e.clientX, e.clientY), camera);
        if (hit) placeMarkerAt(hit);
      }
    } else if (e.pointerType === 'mouse' && button.current === 2) {
      exploreCameraRotate(dx, dy);
    } else {
      exploreCameraPan(dx, dy);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const wasSingle = pointers.current.size === 1;
    const wasMarker = mode.current === 'marker';
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) { setDragging(false); setExploreMarkerInteracting(false); }

    if (wasSingle && wasMarker) {
      // Finished moving the marker → glide the camera so the spawn returns to screen center.
      beginExploreTargetGlide(getMarkerBase());
    } else if (wasSingle && mode.current === 'camera' && moved.current < TAP_PX) {
      // A tap on empty ground places/moves the marker there, then recenters the camera on it.
      const camera = getCamera();
      if (camera && placeMarkerFromNDC(toNDC(e.clientX, e.clientY), camera)) {
        beginExploreTargetGlide(getMarkerBase());
      }
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    exploreCameraZoom(e.deltaY);
  };

  return (
    <div
      className="fixed inset-0 z-30"
      style={{ touchAction: 'none', cursor: dragging ? 'grabbing' : 'grab' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onContextMenu={(e) => e.preventDefault()}
    />
  );
}
