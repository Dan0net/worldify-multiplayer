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
  getMovementFromButtons,
  type MovementVector,
} from '@worldify/shared';
import { useGameStore } from '../../state/store';
import { getBuildIsEnabled } from '../../state/buildAccessors';
import { textureCache } from '../material/TextureCache.js';
import { isTouch } from '../deviceMode';

/** Callback for build place action */
export type BuildPlaceCallback = () => void;

export class Controls {
  private keys = new Set<string>();
  private isPointerLocked = false;
  /** When true, the next pointer lock exit was caused by the build menu opening */
  private buildMenuCausedUnlock = false;

  public yaw = 0;
  public pitch = 0;

  /** Movement/action bits contributed by touch controls (OR-ed into getButtonMask). */
  private touchButtons = 0;

  /**
   * Analog touch move vector (local space, -1..1). Magnitude encodes joystick
   * deflection so movement speed + direction are continuous, unlike the 8-way
   * keyboard bits. (0,0) when the joystick is centred / not in use.
   */
  private touchMoveX = 0;
  private touchMoveZ = 0;

  /**
   * Screen-space cast point in NDC (-1..1) for the build raycast.
   * `null` on desktop → BuildMarker uses the camera-centre ray (pointer-lock).
   * Set by the mobile reticle so aiming can be decoupled from look.
   */
  public castNDC: { x: number; y: number } | null = null;

  /** Callback when user clicks to place a build (left-click while in build mode) */
  public onBuildPlace: BuildPlaceCallback | null = null;

  /** Callback when user "punches" (left-click / tap while not building): material-filtered dig */
  public onPunch: (() => void) | null = null;

  /** Callback to undo the last build (Ctrl/Cmd+Z, or mobile button) */
  public onUndo: (() => void) | null = null;

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

    // Undo last build: Z (Playing only, so typing 'z' in menus/dialogs doesn't undo)
    if (e.code === 'KeyZ') {
      if (useGameStore.getState().gameMode === GameMode.Playing) {
        e.preventDefault();
        this.onUndo?.();
        return;
      }
    }

    // Debug: F6 to clear texture cache
    if (e.code === 'F6') {
      textureCache.clearCache().then(() => {
        console.log('Texture cache cleared - reload page to re-download');
      });
      return;
    }

    // Build-item selection (keys 1..9,0 → hotbar slots 1..9,0). Selecting only shows the item in
    // hand; build mode is entered separately with right-click.
    if (e.code >= 'Digit0' && e.code <= 'Digit9') {
      const digit = parseInt(e.code.charAt(5));
      useGameStore.getState().setBuildPreset(digit);
      return;
    }

    // Build rotation (Q; the mouse wheel rotates both directions). E is the build menu, below.
    if (e.code === 'KeyQ') {
      useGameStore.getState().rotateBuild(-1);
      return;
    }

    // Snap toggles
    if (e.code === 'KeyG') {
      useGameStore.getState().toggleBuildSnapGrid();
      return;
    }
    if (e.code === 'KeyT') {
      useGameStore.getState().toggleBuildSnapPoint();
      return;
    }

    // E (or Tab) toggles the build menu (the assignable preset picker).
    if (e.code === 'KeyE' || e.code === 'Tab') {
      e.preventDefault();
      this.toggleBuildMenu();
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
    if (getBuildIsEnabled()) {
      e.preventDefault();
      useGameStore.getState().rotateBuild(e.deltaY > 0 ? 1 : -1);
    }
  };

  private onMouseDown = (e: MouseEvent): void => {
    // Right-click toggles build mode (enter shows the live preview; again exits).
    if (e.button === 2 && useGameStore.getState().gameMode === GameMode.Playing) {
      e.preventDefault();
      if (!useGameStore.getState().build.menuOpen) {
        useGameStore.getState().toggleBuildMode();
      }
      return;
    }

    // In Playing mode without pointer lock, re-request it on any left click
    // (handles case where requestPointerLock silently fails after Escape exit)
    // But NOT when the build menu is open — allow UI clicks (debug panel, etc.)
    if (!this.isPointerLocked) {
      if (e.button === 0 && useGameStore.getState().gameMode === GameMode.Playing && !useGameStore.getState().build.menuOpen) {
        this.requestPointerLock();
      }
      return;
    }

    // Left click: place the build while in build mode, otherwise punch (material-filtered dig).
    if (e.button === 0) {
      if (getBuildIsEnabled()) {
        this.onBuildPlace?.();
      } else {
        this.onPunch?.();
      }
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
        if (useGameStore.getState().build.menuOpen) {
          useGameStore.getState().setBuildMenuOpen(false);
        }
        useGameStore.getState().setGameMode(GameMode.Explore);
      }
    } else {
      // Pointer lock regained — ensure build menu is closed
      if (useGameStore.getState().build.menuOpen) {
        useGameStore.getState().setBuildMenuOpen(false);
      }
    }
  };

  /** Prevent browser context menu while playing */
  private onContextMenu = (e: MouseEvent): void => {
    if (useGameStore.getState().gameMode === GameMode.Playing) {
      e.preventDefault();
    }
  };

  /** Open the build menu overlay (releases pointer lock for cursor) */
  private openBuildMenu(): void {
    this.buildMenuCausedUnlock = true;
    useGameStore.getState().setBuildMenuOpen(true);
    document.exitPointerLock();
  }

  /**
   * E / Tab / the bar button: toggle the build menu (assignable preset picker). Opening releases
   * pointer lock for the cursor; closing re-acquires it on desktop.
   */
  public toggleBuildMenu(): void {
    const store = useGameStore.getState();
    if (store.gameMode !== GameMode.Playing) return;
    if (store.build.menuOpen) {
      store.setBuildMenuOpen(false);
      if (!isTouch()) requestAnimationFrame(() => document.body.requestPointerLock());
    } else {
      this.openBuildMenu();
    }
  }

  requestPointerLock(): void {
    // Touch devices have no pointer lock; entering Playing mode is button-driven.
    if (isTouch()) return;
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
    return mask | this.touchButtons;
  }

  // ============== Touch input surface (mobile) ==============

  /** Set or clear a single input bit from touch buttons (Jump, Sprint, …). */
  setTouchButton(bit: number, on: boolean): void {
    this.touchButtons = on ? (this.touchButtons | bit) : (this.touchButtons & ~bit);
  }

  /**
   * Set movement direction from the virtual joystick.
   * @param moveX left/right in -1..1, moveZ forward(-)/back(+) in -1..1.
   * Maps to the existing 8-way direction bits via a deadzone threshold.
   */
  setTouchMove(moveX: number, moveZ: number): void {
    // Keep the discrete bits for the server input model (buttons mask); local
    // movement uses the analog vector below for continuous speed + direction.
    this.touchButtons &= ~(INPUT_FORWARD | INPUT_BACKWARD | INPUT_LEFT | INPUT_RIGHT);
    const t = 0.3;
    if (moveZ < -t) this.touchButtons |= INPUT_FORWARD;
    if (moveZ > t) this.touchButtons |= INPUT_BACKWARD;
    if (moveX < -t) this.touchButtons |= INPUT_LEFT;
    if (moveX > t) this.touchButtons |= INPUT_RIGHT;
    this.touchMoveX = moveX;
    this.touchMoveZ = moveZ;
  }

  /**
   * Current movement vector in local space (length 0..1). Prefers the analog touch
   * joystick (continuous speed + direction) when it's deflected past a small
   * deadzone; otherwise falls back to the normalized 8-way keyboard direction.
   */
  getMoveVector(): MovementVector {
    const mag = Math.hypot(this.touchMoveX, this.touchMoveZ);
    if (mag > 0.15) {
      // Clamp to the unit circle so pushing past the pad edge isn't faster.
      const s = mag > 1 ? 1 / mag : 1;
      return { moveX: this.touchMoveX * s, moveZ: this.touchMoveZ * s };
    }
    return getMovementFromButtons(this.getButtonMask());
  }

  /** Apply a look delta from a touch drag (same sensitivity as mouse). */
  applyLookDelta(dx: number, dy: number): void {
    this.yaw -= dx * 0.002;
    this.pitch -= dy * 0.002;
    this.pitch = clamp(this.pitch, -Math.PI / 2, Math.PI / 2);
  }

  /** Trigger an undo (mobile button). */
  triggerUndo(): void {
    this.onUndo?.();
  }

  /** Trigger a build placement (mobile reticle release). */
  triggerPlace(): void {
    if (getBuildIsEnabled() && this.onBuildPlace) {
      this.onBuildPlace();
    }
  }

  /** Trigger a punch/dig (mobile screen tap). */
  triggerPunch(): void {
    this.onPunch?.();
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
