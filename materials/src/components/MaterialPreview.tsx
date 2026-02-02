import { useRef, useState, useMemo, useEffect, Suspense } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Environment, useTexture } from '@react-three/drei';
import * as THREE from 'three';

type GeometryType = 'sphere' | 'cube' | 'plane';

interface MapConfig {
  path?: string;
  channel?: string;
}

interface MaterialPreviewProps {
  /** Folder name for the material */
  materialName: string;
  /** Material config with paths to textures */
  config: {
    albedo?: MapConfig;
    normal?: MapConfig;
    ao?: MapConfig;
    roughness?: MapConfig;
    metalness?: MapConfig;
  };
  /** Height of the preview canvas */
  height?: number;
}

interface TextureInfo {
  path: string;
  channel?: string;
}

interface TexturePaths {
  albedo?: TextureInfo;
  normal?: TextureInfo;
  ao?: TextureInfo;
  roughness?: TextureInfo;
  metalness?: TextureInfo;
}

// Extract a single channel from a texture and create a new texture
function extractChannel(texture: THREE.Texture, channel: string): THREE.Texture {
  // Create a canvas to read pixels
  const canvas = document.createElement('canvas');
  const img = texture.image as HTMLImageElement;
  if (!img || !img.complete || !img.naturalWidth) return texture;
  
  const size = Math.min(img.naturalWidth, 1024);
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  
  // Draw the texture to canvas
  ctx.drawImage(img, 0, 0, size, size);
  const imageData = ctx.getImageData(0, 0, size, size);
  const data = imageData.data;
  
  // Channel index: r=0, g=1, b=2, a=3
  const channelIndex = { r: 0, g: 1, b: 2, a: 3 }[channel] ?? 0;
  
  // Extract channel to grayscale
  for (let i = 0; i < data.length; i += 4) {
    const value = data[i + channelIndex];
    data[i] = value;     // R
    data[i + 1] = value; // G
    data[i + 2] = value; // B
    data[i + 3] = 255;   // A
  }
  
  ctx.putImageData(imageData, 0, 0);
  
  const newTexture = new THREE.CanvasTexture(canvas);
  newTexture.wrapS = newTexture.wrapT = THREE.RepeatWrapping;
  newTexture.colorSpace = THREE.LinearSRGBColorSpace;
  newTexture.needsUpdate = true;
  
  return newTexture;
}

// Geometry with UV2 for AO map
function GeometryWithUV2({ type }: { type: GeometryType }) {
  const geometryRef = useRef<THREE.SphereGeometry | THREE.BoxGeometry | THREE.PlaneGeometry>(null);
  
  useEffect(() => {
    if (geometryRef.current) {
      // Copy UV to UV2 for AO map support
      const uv = geometryRef.current.getAttribute('uv');
      if (uv) {
        geometryRef.current.setAttribute('uv2', uv.clone());
      }
    }
  }, [type]);
  
  switch (type) {
    case 'sphere':
      return <sphereGeometry ref={geometryRef as React.RefObject<THREE.SphereGeometry>} args={[1, 64, 64]} />;
    case 'cube':
      return <boxGeometry ref={geometryRef as React.RefObject<THREE.BoxGeometry>} args={[1.5, 1.5, 1.5]} />;
    case 'plane':
      return <planeGeometry ref={geometryRef as React.RefObject<THREE.PlaneGeometry>} args={[2.5, 2.5]} />;
    default:
      return <sphereGeometry ref={geometryRef as React.RefObject<THREE.SphereGeometry>} args={[1, 64, 64]} />;
  }
}

// Material with loaded textures
function LoadedMaterial({
  texturePaths,
  envMapEnabled,
}: {
  texturePaths: TexturePaths;
  envMapEnabled: boolean;
}) {
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  
  // Collect all unique texture paths
  const uniquePaths = useMemo(() => {
    const paths = new Set<string>();
    Object.values(texturePaths).forEach((info) => {
      if (info?.path) paths.add(`/sources/${info.path}`);
    });
    return Array.from(paths);
  }, [texturePaths]);
  
  // Load all textures
  const loadedTextures = useTexture(uniquePaths.length > 0 ? uniquePaths : ['/sources/placeholder.png']);
  
  // Create texture map
  const textureMap = useMemo(() => {
    const map: Record<string, THREE.Texture> = {};
    uniquePaths.forEach((path, i) => {
      const tex = Array.isArray(loadedTextures) ? loadedTextures[i] : loadedTextures;
      if (tex) {
        map[path] = tex;
      }
    });
    return map;
  }, [uniquePaths, loadedTextures]);
  
  // Process textures with channel extraction
  const processedTextures = useMemo(() => {
    const result: {
      albedo?: THREE.Texture;
      normal?: THREE.Texture;
      ao?: THREE.Texture;
      roughness?: THREE.Texture;
      metalness?: THREE.Texture;
    } = {};
    
    const getTexture = (info: TextureInfo | undefined, isColor: boolean = false): THREE.Texture | undefined => {
      if (!info?.path) return undefined;
      const tex = textureMap[`/sources/${info.path}`];
      if (!tex) return undefined;
      
      // Clone texture to avoid mutating the cached version
      const cloned = tex.clone();
      cloned.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
      cloned.wrapS = cloned.wrapT = THREE.RepeatWrapping;
      cloned.needsUpdate = true;
      
      // Extract channel if specified
      if (info.channel && info.channel !== 'rgba') {
        return extractChannel(tex, info.channel);
      }
      
      return cloned;
    };
    
    result.albedo = getTexture(texturePaths.albedo, true);
    result.normal = getTexture(texturePaths.normal);
    result.ao = getTexture(texturePaths.ao);
    result.roughness = getTexture(texturePaths.roughness);
    result.metalness = getTexture(texturePaths.metalness);
    
    return result;
  }, [texturePaths, textureMap]);
  
  // Determine base values based on whether maps exist
  const hasRoughnessMap = !!processedTextures.roughness;
  const hasMetalnessMap = !!processedTextures.metalness;
  
  return (
    <meshStandardMaterial
      ref={materialRef}
      map={processedTextures.albedo ?? null}
      normalMap={processedTextures.normal ?? null}
      aoMap={processedTextures.ao ?? null}
      aoMapIntensity={1}
      roughnessMap={processedTextures.roughness ?? null}
      roughness={hasRoughnessMap ? 1 : 0.5}
      metalnessMap={processedTextures.metalness ?? null}
      metalness={hasMetalnessMap ? 1 : 0}
      envMapIntensity={envMapEnabled ? 1 : 0}
    />
  );
}

// Material mesh with loaded textures
function MaterialMesh({
  texturePaths,
  geometry,
  envMapEnabled,
}: {
  texturePaths: TexturePaths;
  geometry: GeometryType;
  envMapEnabled: boolean;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  
  // Check if we have any textures to load
  const hasTextures = Object.values(texturePaths).some((t) => t?.path);

  // Slow rotation
  useFrame((_, delta) => {
    if (meshRef.current && geometry !== 'plane') {
      meshRef.current.rotation.y += delta * 0.3;
    }
  });

  return (
    <mesh ref={meshRef} rotation={geometry === 'plane' ? [-Math.PI / 4, 0, 0] : [0, 0, 0]}>
      <GeometryWithUV2 type={geometry} />
      {hasTextures ? (
        <Suspense fallback={<meshStandardMaterial color="#666" />}>
          <LoadedMaterial texturePaths={texturePaths} envMapEnabled={envMapEnabled} />
        </Suspense>
      ) : (
        <meshStandardMaterial color="#666" roughness={0.5} metalness={0} />
      )}
    </mesh>
  );
}

// Scene with lighting
function Scene({
  texturePaths,
  geometry,
  envMapEnabled,
}: {
  texturePaths: TexturePaths;
  geometry: GeometryType;
  envMapEnabled: boolean;
}) {
  return (
    <>
      {/* Lighting */}
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 5, 5]} intensity={1.5} />
      <directionalLight position={[-3, 2, -3]} intensity={0.5} />
      <pointLight position={[0, 3, 2]} intensity={0.8} />

      {/* Environment map */}
      {envMapEnabled && (
        <Environment preset="forest" background={true} />
      )}

      {/* Material mesh */}
      <MaterialMesh
        texturePaths={texturePaths}
        geometry={geometry}
        envMapEnabled={envMapEnabled}
      />

      {/* Controls */}
      <OrbitControls
        enablePan={false}
        minDistance={2}
        maxDistance={6}
        autoRotate={false}
      />
    </>
  );
}

// Error boundary for texture loading
function TextureErrorBoundary({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={null}>{children}</Suspense>;
}

export function MaterialPreview({ materialName, config, height = 300 }: MaterialPreviewProps) {
  const [geometry, setGeometry] = useState<GeometryType>('sphere');
  const [envMapEnabled, setEnvMapEnabled] = useState(true);

  // Build texture paths from config with channel info
  const texturePaths = useMemo<TexturePaths>(() => ({
    albedo: config.albedo?.path ? { path: config.albedo.path, channel: config.albedo.channel } : undefined,
    normal: config.normal?.path ? { path: config.normal.path, channel: config.normal.channel } : undefined,
    ao: config.ao?.path ? { path: config.ao.path, channel: config.ao.channel } : undefined,
    roughness: config.roughness?.path ? { path: config.roughness.path, channel: config.roughness.channel } : undefined,
    metalness: config.metalness?.path ? { path: config.metalness.path, channel: config.metalness.channel } : undefined,
  }), [config]);

  // Check if we have any textures
  const hasTextures = Object.values(texturePaths).some((t) => t?.path);

  if (!hasTextures) {
    return (
      <div
        className="flex items-center justify-center bg-gray-800 rounded text-gray-500 text-sm"
        style={{ height }}
      >
        No textures assigned
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {/* Controls */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Geometry selector */}
        <div className="flex gap-1">
          {(['sphere', 'cube', 'plane'] as const).map((geo) => (
            <button
              key={geo}
              onClick={() => setGeometry(geo)}
              className={`px-2 py-1 text-xs rounded capitalize ${
                geometry === geo
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              }`}
            >
              {geo}
            </button>
          ))}
        </div>

        {/* Env map toggle */}
        <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer ml-auto">
          <input
            type="checkbox"
            checked={envMapEnabled}
            onChange={(e) => setEnvMapEnabled(e.target.checked)}
            className="w-3.5 h-3.5 rounded bg-gray-700 border-gray-600"
          />
          Env Map
        </label>
      </div>

      {/* 3D Canvas */}
      <div
        className="rounded overflow-hidden bg-gray-900"
        style={{ height }}
      >
        <Canvas
          camera={{ position: [0, 0, 3], fov: 45 }}
          gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
        >
          <TextureErrorBoundary>
            <Scene
              texturePaths={texturePaths}
              geometry={geometry}
              envMapEnabled={envMapEnabled}
            />
          </TextureErrorBoundary>
        </Canvas>
      </div>

      {/* Texture info */}
      <div className="text-[10px] text-gray-500 flex flex-wrap gap-x-3">
        {texturePaths.albedo?.path && <span>✓ Albedo</span>}
        {texturePaths.normal?.path && <span>✓ Normal</span>}
        {texturePaths.ao?.path && <span>✓ AO{texturePaths.ao.channel ? ` (${texturePaths.ao.channel})` : ''}</span>}
        {texturePaths.roughness?.path && <span>✓ Rough{texturePaths.roughness.channel ? ` (${texturePaths.roughness.channel})` : ''}</span>}
        {texturePaths.metalness?.path && <span>✓ Metal{texturePaths.metalness.channel ? ` (${texturePaths.metalness.channel})` : ''}</span>}
      </div>
    </div>
  );
}
