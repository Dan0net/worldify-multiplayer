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
  GameMode,
  clamp,
} from '@worldify/shared';
import { storeBridge } from '../../state/bridge';
import { textureCache } from '../material/TextureCache.js';

/** Callback for build place action */
export type BuildPlaceCallback = () => void;

export class Controls {
  private keys = new Set<string>();
  private isPointerLocked = false;
  /** When true, the next pointer lock exit was caused by the build menu opening */
  private buildMenuCausedUnlock = false;

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
    window.addEventListener('contextmenu', this.onContextMenu);
    document.addEventListener('pointerlockchange', this.onPointerLockChange);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);

    // Debug: F6 to clear texture cache
    if (e.code === 'F6') {
      textureCache.clearCache().then(() => {
        console.log('Texture cache cleared - reload page to re-download');
      });
      return;
    }

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

    // Snap toggles
    if (e.code === 'KeyG') {
      storeBridge.toggleBuildSnapGrid();
      return;
    }
    if (e.code === 'KeyT') {
      storeBridge.toggleBuildSnapPoint();
      return;
    }

    // Tab key: toggle build menu
    if (e.code === 'Tab') {
      e.preventDefault();
      if (storeBridge.gameMode === GameMode.Playing) {
        if (storeBridge.buildMenuOpen) {
          this.closeBuildMenu();
        } else {
          this.openBuildMenu();
        }
      }
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
    this.pitch = clamp(this.pitch, -Math.PI / 2, Math.PI / 2);
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
    // Right-click: toggle build menu (works both locked and unlocked while Playing)
    if (e.button === 2 && storeBridge.gameMode === GameMode.Playing) {
      e.preventDefault();
      if (storeBridge.buildMenuOpen) {
        this.closeBuildMenu();
      } else if (this.isPointerLocked) {
        this.openBuildMenu();
      }
      return;
    }

    // In Playing mode without pointer lock, re-request it on any left click
    // (handles case where requestPointerLock silently fails after Escape exit)
    if (!this.isPointerLocked) {
      if (e.button === 0 && storeBridge.gameMode === GameMode.Playing) {
        this.requestPointerLock();
      }
      return;
    }
    
    // Left click to place build
    if (e.button === 0 && storeBridge.buildIsEnabled && this.onBuildPlace) {
      this.onBuildPlace();
    }
  };

  private onPointerLockChange = (): void => {
    this.isPointerLocked = document.pointerLockElement !== null;
    if (!this.isPointerLocked) {
      if (this.buildMenuCausedUnlock) {
        // Build menu opened — stay in Playing mode
        this.buildMenuCausedUnlock = false;
      } else {
        // Normal pointer lock exit — close build menu if open, go to main menu
        if (storeBridge.buildMenuOpen) {
          storeBridge.setBuildMenuOpen(false);
        }
        storeBridge.setGameMode(GameMode.MainMenu);
      }
    } else {
      // Pointer lock regained — ensure build menu is closed
      if (storeBridge.buildMenuOpen) {
        storeBridge.setBuildMenuOpen(false);
      }
    }
  };

  /** Prevent browser context menu while playing */
  private onContextMenu = (e: MouseEvent): void => {
    if (storeBridge.gameMode === GameMode.Playing) {
      e.preventDefault();
    }
  };

  /** Open the build menu overlay (releases pointer lock for cursor) */
  private openBuildMenu(): void {
    this.buildMenuCausedUnlock = true;
    storeBridge.setBuildMenuOpen(true);
    document.exitPointerLock();
  }

  /** Close the build menu overlay (re-locks pointer) */
  private closeBuildMenu(): void {
    storeBridge.setBuildMenuOpen(false);
    requestAnimationFrame(() => {
      document.body.requestPointerLock();
    });
  }

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
    window.removeEventListener('contextmenu', this.onContextMenu);
    document.removeEventListener('pointerlockchange', this.onPointerLockChange);
  }
}

export const controls = new Controls();
