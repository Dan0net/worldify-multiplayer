/**
 * BundledMaterialPreview - 3D material preview using bundled .bin textures
 * 
 * Loads textures from the processed output files (same as the game)
 * to ensure visual parity between the pallet viewer and in-game rendering.
 */

import { useRef, useState, useEffect, Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { MATERIAL_BASE_URL } from '../constants';
import type { MaterialPallet, MapMetadata } from '../types';
import {
  GeometryType,
  PreviewScene,
  PreviewGeometry,
  GeometrySelector,
  EnvMapToggle,
  ENVIRONMENT_INTENSITY,
  MATERIAL_AO_INTENSITY,
  MATERIAL_NORMAL_STRENGTH,
} from './PreviewScene';

export type Resolution = 'low' | 'high';
type MapType = 'albedo' | 'normal' | 'ao' | 'roughness' | 'metalness';

export interface BundledMaterialPreviewProps {
  /** Material index in the pallet */
  materialIndex: number;
  /** Material name for display */
  materialName: string;
  /** Loaded pallet data */
  pallet: MaterialPallet;
  /** Resolution to use */
  resolution?: Resolution;
  /** Height of the preview canvas */
  height?: number;
  /** Show controls (geometry selector, env toggle) */
  showControls?: boolean;
}

interface LoadedTextures {
  albedo: THREE.DataTexture | null;
  normal: THREE.DataTexture | null;
  ao: THREE.DataTexture | null;
  roughness: THREE.DataTexture | null;
  metalness: THREE.DataTexture | null;
}

// Extract a single layer from a .bin file and create a DataTexture
async function loadLayerTexture(
  resolution: Resolution,
  mapType: MapType,
  layerIndex: number,
  meta: MapMetadata
): Promise<THREE.DataTexture | null> {
  try {
    const response = await fetch(`${MATERIAL_BASE_URL}/${resolution}/${mapType}.bin`);
    if (!response.ok) return null;
    
    const arrayBuffer = await response.arrayBuffer();
    const data = new Uint8Array(arrayBuffer);
    
    const { width, height, channels } = meta;
    const channelCount = channels.length;
    const layerSize = width * height * channelCount;
    const layerOffset = layerIndex * layerSize;
    
    // Extract layer data
    const layerData = data.slice(layerOffset, layerOffset + layerSize);
    
    // Convert to RGBA for Three.js
    let textureData: Uint8Array;
    let format: THREE.PixelFormat;
    
    if (channelCount === 4) {
      textureData = layerData;
      format = THREE.RGBAFormat;
    } else if (channelCount === 1) {
      // Expand grayscale to RGBA
      textureData = new Uint8Array(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const val = layerData[i];
        textureData[i * 4] = val;
        textureData[i * 4 + 1] = val;
        textureData[i * 4 + 2] = val;
        textureData[i * 4 + 3] = 255;
      }
      format = THREE.RGBAFormat;
    } else {
      return null;
    }
    
    const texture = new THREE.DataTexture(textureData, width, height, format);
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.flipY = false; // Raw binary data is already in correct orientation
    texture.needsUpdate = true;
    
    // Set color space based on map type
    if (mapType === 'albedo') {
      texture.colorSpace = THREE.SRGBColorSpace;
    } else {
      texture.colorSpace = THREE.LinearSRGBColorSpace;
    }
    
    return texture;
  } catch (err) {
    console.error(`Failed to load ${mapType} layer ${layerIndex}:`, err);
    return null;
  }
}

// Material mesh with bundled textures
function BundledMaterialMesh({
  textures,
  geometry,
  envMapEnabled,
  hasAlpha,
}: {
  textures: LoadedTextures;
  geometry: GeometryType;
  envMapEnabled: boolean;
  hasAlpha: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  
  const hasRoughnessMap = !!textures.roughness;
  const hasMetalnessMap = !!textures.metalness;

  return (
    <mesh ref={meshRef as any} rotation={geometry === 'plane' ? [-Math.PI / 4, 0, 0] : [0, 0, 0]}>
      <PreviewGeometry type={geometry} />
      <meshStandardMaterial
        map={textures.albedo as any}
        normalMap={textures.normal as any}
        normalScale={[-MATERIAL_NORMAL_STRENGTH, -MATERIAL_NORMAL_STRENGTH] as any}
        aoMap={textures.ao as any}
        aoMapIntensity={MATERIAL_AO_INTENSITY}
        roughnessMap={textures.roughness as any}
        roughness={hasRoughnessMap ? 1 : 0.5}
        metalnessMap={textures.metalness as any}
        metalness={hasMetalnessMap ? 1 : 0}
        envMapIntensity={envMapEnabled ? ENVIRONMENT_INTENSITY : 0}
        transparent={hasAlpha}
        alphaTest={hasAlpha ? 0.5 : 0}
        side={hasAlpha ? THREE.DoubleSide : THREE.FrontSide}
      />
    </mesh>
  );
}

export function BundledMaterialPreview({ 
  materialIndex, 
  materialName,
  pallet,
  resolution = 'low',
  height = 300,
  showControls = true,
}: BundledMaterialPreviewProps) {
  const [geometry, setGeometry] = useState<GeometryType>('sphere');
  const [envMapEnabled, setEnvMapEnabled] = useState(true);
  const [textures, setTextures] = useState<LoadedTextures>({
    albedo: null,
    normal: null,
    ao: null,
    roughness: null,
    metalness: null,
  });
  const [hasAlpha, setHasAlpha] = useState(false);
  const [loading, setLoading] = useState(true);

  // Load textures when material or resolution changes
  useEffect(() => {
    let cancelled = false;
    
    async function loadTextures() {
      setLoading(true);
      
      const maps = pallet.maps[resolution];
      const loaded: LoadedTextures = {
        albedo: null,
        normal: null,
        ao: null,
        roughness: null,
        metalness: null,
      };
      
      const mapTypes: MapType[] = ['albedo', 'normal', 'ao', 'roughness', 'metalness'];
      
      await Promise.all(
        mapTypes.map(async (mapType) => {
          const meta = maps[mapType];
          if (meta && materialIndex < meta.layers) {
            loaded[mapType] = await loadLayerTexture(resolution, mapType, materialIndex, meta);
          }
        })
      );
      
      if (!cancelled) {
        setTextures(loaded);
        // Check if material needs transparency (not in solid types)
        // Material indices in pallet.types are 1-indexed
        const materialId = materialIndex + 1;
        const isSolid = pallet.types.solid.includes(materialId);
        setHasAlpha(!isSolid);
        setLoading(false);
      }
    }
    
    loadTextures();
    
    return () => {
      cancelled = true;
    };
  }, [materialIndex, resolution, pallet]);

  return (
    <div className="flex flex-col gap-2 h-full">
      {/* Controls */}
      {showControls && (
        <div className="flex items-center gap-2 flex-wrap">
          <GeometrySelector geometry={geometry} onSelect={setGeometry} />
          <div className="ml-auto">
            <EnvMapToggle enabled={envMapEnabled} onChange={setEnvMapEnabled} />
          </div>
        </div>
      )}

      {/* 3D Canvas */}
      <div
        className="rounded overflow-hidden bg-gray-900 flex-1"
        style={{ height: showControls ? undefined : height, minHeight: height }}
      >
        {loading ? (
          <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm">
            Loading textures...
          </div>
        ) : (
          <Canvas
            camera={{ position: [0, 0, 3], fov: 45 }}
            gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
          >
            <Suspense fallback={null}>
              <PreviewScene envMapEnabled={envMapEnabled}>
                <BundledMaterialMesh
                  textures={textures}
                  geometry={geometry}
                  envMapEnabled={envMapEnabled}
                  hasAlpha={hasAlpha}
                />
              </PreviewScene>
            </Suspense>
          </Canvas>
        )}
      </div>

      {/* Material info */}
      {showControls && (
        <div className="text-[10px] text-gray-500 flex flex-wrap gap-x-3">
          <span>{materialName}</span>
          <span>#{materialIndex}</span>
          <span>{resolution}</span>
          {textures.albedo && <span>✓ Albedo</span>}
          {textures.normal && <span>✓ Normal</span>}
          {textures.ao && <span>✓ AO</span>}
          {textures.roughness && <span>✓ Rough</span>}
          {textures.metalness && <span>✓ Metal</span>}
        </div>
      )}
    </div>
  );
}
