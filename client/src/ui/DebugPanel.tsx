import { useEffect } from 'react';
import { useGameStore } from '../state/store';

export function DebugPanel() {
  const { 
    ping, 
    fps, 
    tickMs, 
    connectionStatus, 
    serverTick, 
    playerCount,
    voxelDebug,
    voxelStats,
    toggleVoxelDebug,
  } = useGameStore();

  // Keyboard shortcuts for voxel debug toggles
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if not typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return;
      }
      
      switch (e.key) {
        case 'F1':
          e.preventDefault();
          toggleVoxelDebug('showChunkBounds');
          break;
        case 'F2':
          e.preventDefault();
          toggleVoxelDebug('showEmptyChunks');
          break;
        case 'F3':
          e.preventDefault();
          toggleVoxelDebug('showCollisionMesh');
          break;
        case 'F4':
          e.preventDefault();
          toggleVoxelDebug('showChunkCoords');
          break;
        case 'F5':
          e.preventDefault();
          toggleVoxelDebug('showWireframe');
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleVoxelDebug]);

  return (
    <div className="fixed top-5 left-5 py-2.5 px-4 bg-black/60 text-green-500 font-mono text-xs rounded-lg z-50">
      {/* Connection & Performance Stats */}
      <div>Status: {connectionStatus}</div>
      <div>Players: {playerCount}</div>
      <div>Ping: {ping}ms</div>
      <div>FPS: {fps}</div>
      <div>Tick: {tickMs.toFixed(1)}ms</div>
      <div>Server: {serverTick}</div>
      
      {/* Voxel Stats */}
      <div className="mt-2 pt-2 border-t border-green-500/30">
        <div>Chunks: {voxelStats.chunksLoaded}</div>
        <div>Meshes: {voxelStats.meshesVisible}</div>
        <div>Debug: {voxelStats.debugObjects}</div>
      </div>
      
      {/* Voxel Debug Toggles */}
      <div className="mt-2 pt-2 border-t border-green-500/30 text-yellow-400">
        <div className="mb-1 text-green-500">Debug (F1-F5):</div>
        <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
          <input
            type="checkbox"
            checked={voxelDebug.showChunkBounds}
            onChange={() => toggleVoxelDebug('showChunkBounds')}
            className="accent-yellow-400"
          />
          <span>F1 Bounds</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
          <input
            type="checkbox"
            checked={voxelDebug.showEmptyChunks}
            onChange={() => toggleVoxelDebug('showEmptyChunks')}
            className="accent-yellow-400"
          />
          <span>F2 Empty</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
          <input
            type="checkbox"
            checked={voxelDebug.showCollisionMesh}
            onChange={() => toggleVoxelDebug('showCollisionMesh')}
            className="accent-yellow-400"
          />
          <span>F3 Collision</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
          <input
            type="checkbox"
            checked={voxelDebug.showChunkCoords}
            onChange={() => toggleVoxelDebug('showChunkCoords')}
            className="accent-yellow-400"
          />
          <span>F4 Coords</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
          <input
            type="checkbox"
            checked={voxelDebug.showWireframe}
            onChange={() => toggleVoxelDebug('showWireframe')}
            className="accent-yellow-400"
          />
          <span>F5 Wireframe</span>
        </label>
      </div>
    </div>
  );
}
