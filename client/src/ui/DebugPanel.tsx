import { useEffect, useState } from 'react';
import { useGameStore, TERRAIN_DEBUG_MODE_NAMES } from '../state/store';
import { textureCache } from '../game/material/TextureCache';
import { setTerrainDebugMode as setShaderDebugMode } from '../game/material/TerrainMaterial';
import { togglePostProcessing as togglePostProcessingEffect } from '../game/scene/postprocessing';
import { storeBridge } from '../state/bridge';

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
    textureState,
    terrainDebugMode,
    cycleTerrainDebugMode,
    postProcessingEnabled,
    togglePostProcessing,
    forceRegenerateChunks,
  } = useGameStore();

  const [cacheClearing, setCacheClearing] = useState(false);
  const [chunksClearing, setChunksClearing] = useState(false);

  const handleClearTextureCache = async () => {
    setCacheClearing(true);
    await textureCache.clearCache();
    setCacheClearing(false);
    console.log('Texture cache cleared - reload page to re-download');
  };

  const handleClearChunks = () => {
    setChunksClearing(true);
    storeBridge.clearAndReloadChunks();
    // Reset after a short delay (chunks will reload async)
    setTimeout(() => setChunksClearing(false), 500);
  };

  const handleToggleForceRegenerate = () => {
    storeBridge.toggleForceRegenerate();
    // Also clear chunks so they reload with new setting
    handleClearChunks();
  };

  const handleTogglePostProcessing = () => {
    togglePostProcessingEffect();
    togglePostProcessing();
  };

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
        case 'F7':
          e.preventDefault();
          cycleTerrainDebugMode();
          break;
        case 'F8':
          e.preventDefault();
          handleTogglePostProcessing();
          break;
        case 'F9':
          e.preventDefault();
          handleToggleForceRegenerate();
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggleVoxelDebug, cycleTerrainDebugMode]);
  
  // Sync terrain debug mode to shader when it changes
  useEffect(() => {
    setShaderDebugMode(terrainDebugMode);
  }, [terrainDebugMode]);

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
      
      {/* Terrain Shader Debug */}
      <div className="mt-2 pt-2 border-t border-green-500/30 text-yellow-400">
        <div className="mb-1 text-green-500">Shader (F7-F8):</div>
        <label 
          className="flex items-center gap-2 cursor-pointer hover:text-yellow-300"
          onClick={cycleTerrainDebugMode}
        >
          <span className="w-4 h-4 flex items-center justify-center">
            {terrainDebugMode > 0 ? '🔍' : '○'}
          </span>
          <span>F7 {TERRAIN_DEBUG_MODE_NAMES[terrainDebugMode]}</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer hover:text-yellow-300">
          <input
            type="checkbox"
            checked={postProcessingEnabled}
            onChange={handleTogglePostProcessing}
            className="accent-yellow-400"
          />
          <span>F8 Post-FX</span>
        </label>
      </div>
      
      {/* Texture Cache */}
      <div className="mt-2 pt-2 border-t border-green-500/30 text-yellow-400">
        <a href="/materials" className="mb-1 text-green-500 hover:text-green-300 underline block">
          Textures: {textureState}
        </a>
        <label 
          className="flex items-center gap-2 cursor-pointer hover:text-yellow-300"
          onClick={handleClearTextureCache}
        >
          <span className="w-4 h-4 flex items-center justify-center text-red-400">
            {cacheClearing ? '⏳' : '✕'}
          </span>
          <span>F6 Clear Cache</span>
        </label>
        <label 
          className="flex items-center gap-2 cursor-pointer hover:text-yellow-300"
          onClick={handleToggleForceRegenerate}
        >
          <input
            type="checkbox"
            checked={forceRegenerateChunks}
            onChange={handleToggleForceRegenerate}
            className="accent-red-400"
          />
          <span className={forceRegenerateChunks ? 'text-red-400' : ''}>F9 Force Regen</span>
        </label>
      </div>
    </div>
  );
}
