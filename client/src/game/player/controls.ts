/**
 * Input controls handler
 * Captures keyboard/mouse input for player movement
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

export class Controls {
  private keys = new Set<string>();
  private isPointerLocked = false;

  public yaw = 0;
  public pitch = 0;

  constructor() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
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
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }
}

export const controls = new Controls();
