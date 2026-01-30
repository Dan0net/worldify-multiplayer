/**
 * Input controls handler
 * Captures keyboard/mouse input for player movement and building
 */

import {
  INPUT_FORWARD,
  INPUT_BACKWARD,
  INPUT_LEFT,
  INPUT_RIGHT,
  INPUT_JUMP,
  INPUT_SPRINT,
} from '@worldify/shared';
import { storeBridge } from '../../state/bridge';

/** Callback for build place action */
export type BuildPlaceCallback = () => void;

export class Controls {
  private keys = new Set<string>();
  private isPointerLocked = false;

  public yaw = 0;
  public pitch = 0;

  /** Callback when user clicks to place a build */
  public onBuildPlace: BuildPlaceCallback | null = null;

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('mousedown', this.onMouseDown);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);

    // Build preset selection (0-9)
    if (e.code >= 'Digit0' && e.code <= 'Digit9') {
      const digit = parseInt(e.code.charAt(5));
      storeBridge.selectBuildPreset(digit);
      return;
    }

    // Build rotation
    if (e.code === 'KeyQ') {
      storeBridge.rotateBuild(-1);
      return;
    }
    if (e.code === 'KeyE') {
      storeBridge.rotateBuild(1);
      return;
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onMouseMove = (e: MouseEvent): void => {
    if (!this.isPointerLocked) return;
    this.yaw -= e.movementX * 0.002;
    this.pitch -= e.movementY * 0.002;
    this.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.pitch));
  };

  private onWheel = (e: WheelEvent): void => {
    if (!this.isPointerLocked) return;
    
    // Only handle wheel when build mode is active
    if (storeBridge.buildIsEnabled) {
      e.preventDefault();
      storeBridge.rotateBuild(e.deltaY > 0 ? 1 : -1);
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    if (!this.isPointerLocked) return;
    
    // Left click to place build
    if (e.button === 0 && storeBridge.buildIsEnabled && this.onBuildPlace) {
      this.onBuildPlace();
    }
  };

  private onPointerLockChange = (): void => {
    this.isPointerLocked = document.pointerLockElement !== null;
    if (!this.isPointerLocked) {
      // Exit to spectator mode (show start screen)
      storeBridge.updateIsSpectating(true);
    }
  };

  requestPointerLock(): void {
    document.body.requestPointerLock();
  }

  getButtonMask(): number {
    let mask = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) mask |= INPUT_FORWARD;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) mask |= INPUT_BACKWARD;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mask |= INPUT_LEFT;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mask |= INPUT_RIGHT;
    if (this.keys.has('Space')) mask |= INPUT_JUMP;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) mask |= INPUT_SPRINT;
    return mask;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('mousedown', this.onMouseDown);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }
}

export const controls = new Controls();
