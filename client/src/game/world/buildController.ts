/**
 * Build controller - handles placing build pieces
 * - Grid snapping
 * - Raycast to determine placement position
 * - Sends BUILD_INTENT on click
 * - Receives and applies BUILD_COMMIT in order
 */

import * as THREE from 'three';
import { BuildPieceType, BuildCommit, TERRITORY_CELL_SIZE } from '@worldify/shared';
import { getCamera } from '../scene/camera';
import { BuildPreview } from './buildPreview';
import { BuildPieces } from './buildPieces';
import { sendBinary } from '../../net/netClient';
import { encodeBuildIntent } from '../../net/encode';
import { useGameStore } from '../../state/store';

export class BuildController {
  private preview: BuildPreview;
  private pieces: BuildPieces;
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private intersectPoint = new THREE.Vector3();
  
  // Ordered commit queue
  private pendingCommits: BuildCommit[] = [];
  private lastAppliedSeq = 0;
  
  // Current preview state
  private previewGridX = 0;
  private previewGridZ = 0;
  private previewRotation = 0;
  private isBuilding = false;

  constructor() {
    this.preview = new BuildPreview();
    this.pieces = new BuildPieces();
    
    // Listen for clicks
    window.addEventListener('mousedown', this.onMouseDown);
    
    // Listen for rotation keys (Q/E or R)
    window.addEventListener('keydown', this.onKeyDown);
  }

  /**
   * Update build preview based on camera look direction
   */
  update(): void {
    const camera = getCamera();
    if (!camera) return;
    
    // Only show preview when pointer is locked (in game mode)
    if (document.pointerLockElement === null) {
      this.preview.hide();
      return;
    }
    
    // Get currently selected tool
    const selectedTool = useGameStore.getState().selectedTool;
    
    // Raycast from camera center to ground plane
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    
    const intersects = this.raycaster.ray.intersectPlane(this.groundPlane, this.intersectPoint);
    
    if (intersects) {
      // Snap to grid - offset by half grid size to center around origin
      // World (0,0) maps to grid (64,64)
      const GRID_OFFSET = 64;
      this.previewGridX = Math.floor(this.intersectPoint.x / TERRITORY_CELL_SIZE + 0.5) + GRID_OFFSET;
      this.previewGridZ = Math.floor(this.intersectPoint.z / TERRITORY_CELL_SIZE + 0.5) + GRID_OFFSET;
      
      // Clamp to valid range (0-127)
      this.previewGridX = Math.max(0, Math.min(127, this.previewGridX));
      this.previewGridZ = Math.max(0, Math.min(127, this.previewGridZ));
      
      // Show preview
      this.preview.show(selectedTool, this.previewGridX, this.previewGridZ, this.previewRotation);
    } else {
      this.preview.hide();
    }
  }

  /**
   * Handle incoming build commit from server
   * Applies commits in strict sequence order
   */
  handleBuildCommit(commit: BuildCommit): void {
    // If this is the next expected commit, apply immediately
    if (commit.buildSeq === this.lastAppliedSeq + 1) {
      this.applyCommit(commit);
      
      // Check if any pending commits can now be applied
      this.flushPendingCommits();
    } else if (commit.buildSeq > this.lastAppliedSeq + 1) {
      // Out of order, queue it
      this.pendingCommits.push(commit);
      // Sort by buildSeq
      this.pendingCommits.sort((a, b) => a.buildSeq - b.buildSeq);
    }
    // Ignore commits we've already applied
  }

  /**
   * Get current last applied sequence for reconnect sync
   */
  getLastAppliedSeq(): number {
    return this.lastAppliedSeq;
  }

  /**
   * Reset build state (on disconnect)
   */
  reset(): void {
    this.pendingCommits = [];
    this.lastAppliedSeq = 0;
    this.pieces.dispose();
    this.pieces = new BuildPieces();
  }

  private applyCommit(commit: BuildCommit): void {
    this.pieces.addPiece(commit);
    this.lastAppliedSeq = commit.buildSeq;
  }

  private flushPendingCommits(): void {
    while (this.pendingCommits.length > 0) {
      const next = this.pendingCommits[0];
      if (next.buildSeq === this.lastAppliedSeq + 1) {
        this.pendingCommits.shift();
        this.applyCommit(next);
      } else {
        break; // Gap in sequence, wait for missing commits
      }
    }
  }

  private onMouseDown = (e: MouseEvent): void => {
    // Only handle left click
    if (e.button !== 0) return;
    
    // Only when pointer is locked
    if (document.pointerLockElement === null) return;
    
    // Prevent double-sends
    if (this.isBuilding) return;
    
    const selectedTool = useGameStore.getState().selectedTool;
    
    // Send BUILD_INTENT to server
    const intent = {
      pieceType: selectedTool,
      gridX: this.previewGridX,
      gridZ: this.previewGridZ,
      rotation: this.previewRotation,
    };
    
    sendBinary(encodeBuildIntent(intent));
    
    // Brief cooldown to prevent spam
    this.isBuilding = true;
    setTimeout(() => {
      this.isBuilding = false;
    }, 100);
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    // Rotation controls
    if (e.code === 'KeyR' || e.code === 'KeyE') {
      this.previewRotation = (this.previewRotation + 1) % 4;
    } else if (e.code === 'KeyQ') {
      this.previewRotation = (this.previewRotation + 3) % 4;
    }
    
    // Tool selection via number keys (handled here and in store)
    if (e.code === 'Digit1') {
      useGameStore.getState().setSelectedTool(BuildPieceType.FLOOR);
    } else if (e.code === 'Digit2') {
      useGameStore.getState().setSelectedTool(BuildPieceType.WALL);
    } else if (e.code === 'Digit3') {
      useGameStore.getState().setSelectedTool(BuildPieceType.SLOPE);
    }
  };

  dispose(): void {
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('keydown', this.onKeyDown);
    this.preview.hide();
    this.pieces.dispose();
  }
}
