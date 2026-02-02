/**
 * MaterialViewer - Lightweight texture inspector for all materials
 * 
 * Displays all materials with their texture layers (albedo, normal, ao, roughness, metalness)
 * at both low and high resolutions.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { MATERIAL_BASE_URL } from '../constants';
import type { MaterialPallet } from '../types';

type MapType = 'albedo' | 'normal' | 'ao' | 'roughness' | 'metalness';
type Resolution = 'low' | 'high';

interface TextureData {
  data: Uint8Array;
  width: number;
  height: number;
  channels: string;
  layers: number;
}

const MAP_TYPES: MapType[] = ['albedo', 'normal', 'ao', 'roughness', 'metalness'];

export function MaterialViewer() {
  const [pallet, setPallet] = useState<MaterialPallet | null>(null);
  const [resolution, setResolution] = useState<Resolution>('low');
  const [selectedMap, setSelectedMap] = useState<MapType>('albedo');
  const [selectedMaterial, setSelectedMaterial] = useState<number>(0);
  const [textureData, setTextureData] = useState<TextureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingTexture, setLoadingTexture] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Load pallet on mount
  useEffect(() => {
    async function loadPallet() {
      try {
        const response = await fetch(`${MATERIAL_BASE_URL}/pallet.json`);
        if (!response.ok) throw new Error(`Failed to fetch pallet: ${response.status}`);
        const data = await response.json();
        setPallet(data);
        setLoading(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load pallet');
        setLoading(false);
      }
    }
    loadPallet();
  }, []);

  // Load texture data when selection changes
  useEffect(() => {
    if (!pallet) return;

    const currentPallet = pallet;
    async function loadTexture() {
      setLoadingTexture(true);
      try {
        const meta = currentPallet.maps[resolution][selectedMap];
        if (!meta) {
          throw new Error(`No metadata for ${resolution}/${selectedMap}`);
        }

        const response = await fetch(`${MATERIAL_BASE_URL}/${resolution}/${selectedMap}.bin`);
        if (!response.ok) throw new Error(`Failed to fetch texture: ${response.status}`);
        
        const arrayBuffer = await response.arrayBuffer();
        setTextureData({
          data: new Uint8Array(arrayBuffer),
          width: meta.width,
          height: meta.height,
          channels: meta.channels,
          layers: meta.layers,
        });
        setLoadingTexture(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load texture');
        setLoadingTexture(false);
      }
    }
    loadTexture();
  }, [pallet, resolution, selectedMap]);

  // Render selected material layer to canvas
  useEffect(() => {
    if (!textureData || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { data, width, height, channels } = textureData;
    const channelCount = channels.length;
    const layerSize = width * height * channelCount;
    const layerOffset = selectedMaterial * layerSize;

    canvas.width = width;
    canvas.height = height;

    const imageData = ctx.createImageData(width, height);

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const srcIdx = layerOffset + (y * width + x) * channelCount;
        const dstIdx = (y * width + x) * 4;

        if (channelCount === 4) {
          // RGBA
          imageData.data[dstIdx] = data[srcIdx];
          imageData.data[dstIdx + 1] = data[srcIdx + 1];
          imageData.data[dstIdx + 2] = data[srcIdx + 2];
          imageData.data[dstIdx + 3] = data[srcIdx + 3];
        } else if (channelCount === 1) {
          // Grayscale (R channel only)
          const val = data[srcIdx];
          imageData.data[dstIdx] = val;
          imageData.data[dstIdx + 1] = val;
          imageData.data[dstIdx + 2] = val;
          imageData.data[dstIdx + 3] = 255;
        }
      }
    }

    ctx.putImageData(imageData, 0, 0);
  }, [textureData, selectedMaterial]);

  const handleZoomIn = useCallback(() => setZoom(z => Math.min(z * 1.5, 8)), []);
  const handleZoomOut = useCallback(() => setZoom(z => Math.max(z / 1.5, 0.25)), []);
  const handleResetZoom = useCallback(() => setZoom(1), []);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-xl">Loading material pallet...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-900 text-white flex items-center justify-center">
        <div className="text-red-500 text-xl">Error: {error}</div>
      </div>
    );
  }

  if (!pallet) return null;

  const materialColor = pallet.colors[selectedMaterial] || '#ffffff';

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Header */}
      <header className="bg-gray-800 border-b border-gray-700 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/" className="text-gray-400 hover:text-white transition-colors">
              ← Back
            </Link>
            <h1 className="text-2xl font-bold">Material Viewer</h1>
          </div>
          <div className="text-gray-400">
            {pallet.materials.length} materials · {MAP_TYPES.length} layers
          </div>
        </div>
      </header>

      <div className="flex h-[calc(100vh-73px)]">
        {/* Sidebar - Material List */}
        <aside className="w-64 bg-gray-800 border-r border-gray-700 overflow-y-auto">
          <div className="p-4">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wider mb-3">
              Materials
            </h2>
            <div className="space-y-1">
              {pallet.materials.map((name, index) => (
                <button
                  key={name}
                  onClick={() => setSelectedMaterial(index)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                    selectedMaterial === index
                      ? 'bg-blue-600 text-white'
                      : 'hover:bg-gray-700 text-gray-300'
                  }`}
                >
                  <div
                    className="w-6 h-6 rounded border border-gray-600 shrink-0"
                    style={{ backgroundColor: pallet.colors[index] }}
                  />
                  <span className="truncate text-sm">{name}</span>
                  <span className="text-xs text-gray-500 ml-auto">{index}</span>
                </button>
              ))}
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Controls Bar */}
          <div className="bg-gray-800 border-b border-gray-700 px-6 py-3 flex items-center gap-6">
            {/* Resolution Toggle */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400">Resolution:</span>
              <div className="flex rounded-lg overflow-hidden border border-gray-600">
                <button
                  onClick={() => setResolution('low')}
                  className={`px-3 py-1 text-sm transition-colors ${
                    resolution === 'low'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  Low (128)
                </button>
                <button
                  onClick={() => setResolution('high')}
                  className={`px-3 py-1 text-sm transition-colors ${
                    resolution === 'high'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                  }`}
                >
                  High (1024)
                </button>
              </div>
            </div>

            {/* Map Type Tabs */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-400">Layer:</span>
              <div className="flex rounded-lg overflow-hidden border border-gray-600">
                {MAP_TYPES.map((mapType) => (
                  <button
                    key={mapType}
                    onClick={() => setSelectedMap(mapType)}
                    className={`px-3 py-1 text-sm capitalize transition-colors ${
                      selectedMap === mapType
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                    }`}
                  >
                    {mapType}
                  </button>
                ))}
              </div>
            </div>

            {/* Zoom Controls */}
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-sm text-gray-400">Zoom:</span>
              <button
                onClick={handleZoomOut}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm"
              >
                −
              </button>
              <button
                onClick={handleResetZoom}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm min-w-[60px]"
              >
                {Math.round(zoom * 100)}%
              </button>
              <button
                onClick={handleZoomIn}
                className="px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded text-sm"
              >
                +
              </button>
            </div>
          </div>

          {/* Texture Preview */}
          <div className="flex-1 overflow-hidden bg-gray-950 flex items-center justify-center p-4">
            {loadingTexture ? (
              <div className="text-gray-400">Loading texture...</div>
            ) : (
              <canvas
                ref={canvasRef}
                className="w-full h-full border border-gray-700 shadow-2xl object-contain"
                style={{
                  imageRendering: zoom >= 2 ? 'pixelated' : 'auto',
                }}
              />
            )}
          </div>

          {/* Info Bar */}
          <div className="bg-gray-800 border-t border-gray-700 px-6 py-3 flex items-center gap-6 text-sm">
            <div className="flex items-center gap-2">
              <div
                className="w-5 h-5 rounded border border-gray-600"
                style={{ backgroundColor: materialColor }}
              />
              <span className="font-medium">{pallet.materials[selectedMaterial]}</span>
              <span className="text-gray-500">#{selectedMaterial}</span>
            </div>
            
            {textureData && (
              <>
                <div className="text-gray-400">
                  {textureData.width}×{textureData.height}px
                </div>
                <div className="text-gray-400">
                  Channels: {textureData.channels.toUpperCase()}
                </div>
                <div className="text-gray-400">
                  Layers: {textureData.layers}
                </div>
                <div className="text-gray-400">
                  Size: {((textureData.data.byteLength) / 1024 / 1024).toFixed(2)} MB
                </div>
              </>
            )}

            {/* Material Type Badge */}
            <div className="ml-auto flex gap-2">
              {pallet.types.solid.includes(selectedMaterial + 1) && (
                <span className="px-2 py-0.5 bg-green-600/30 text-green-400 rounded text-xs">
                  Solid
                </span>
              )}
              {pallet.types.liquid.includes(selectedMaterial + 1) && (
                <span className="px-2 py-0.5 bg-blue-600/30 text-blue-400 rounded text-xs">
                  Liquid
                </span>
              )}
              {pallet.types.transparent.includes(selectedMaterial + 1) && (
                <span className="px-2 py-0.5 bg-purple-600/30 text-purple-400 rounded text-xs">
                  Transparent
                </span>
              )}
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
