/**
 * PreviewScene - Shared 3D scene setup for material previews
 * 
 * Provides consistent lighting and environment matching the game.
 * Used by both MaterialPreview (source textures) and BundledMaterialPreview (bundled textures).
 */

import { useEffect, useRef, useMemo, ReactNode } from 'react';
import { useThree } from '@react-three/fiber';
import { OrbitControls, Environment } from '@react-three/drei';
import * as THREE from 'three';
import {
  ENVIRONMENT_INTENSITY,
  MATERIAL_AO_INTENSITY,
  MATERIAL_NORMAL_STRENGTH,
  DEFAULT_SKYBOX,
  LIGHT_AMBIENT_COLOR,
  LIGHT_AMBIENT_INTENSITY,
  LIGHT_SUN_COLOR,
  LIGHT_SUN_INTENSITY,
} from '@worldify/shared/scene';

export type GeometryType = 'sphere' | 'cube' | 'plane';

// Re-export shared constants for convenience
export { ENVIRONMENT_INTENSITY, MATERIAL_AO_INTENSITY, MATERIAL_NORMAL_STRENGTH };

/**
 * Sets scene.environmentIntensity for IBL control
 */
export function SceneSetup({ envMapEnabled }: { envMapEnabled: boolean }) {
  const { scene } = useThree();
  
  useEffect(() => {
    (scene as unknown as { environmentIntensity: number }).environmentIntensity = 
      envMapEnabled ? ENVIRONMENT_INTENSITY : 0;
  }, [scene, envMapEnabled]);
  
  return null;
}

/**
 * Lighting setup matching game TimeOfDay defaults
 */
export function GameLighting() {
  return (
    <>
      <ambientLight color={LIGHT_AMBIENT_COLOR} intensity={LIGHT_AMBIENT_INTENSITY} />
      <directionalLight 
        position={[5, 5, 5]} 
        color={LIGHT_SUN_COLOR} 
        intensity={LIGHT_SUN_INTENSITY} 
      />
    </>
  );
}

/**
 * Environment map with skybox
 */
export function EnvironmentMap({ enabled }: { enabled: boolean }) {
  if (!enabled) return null;
  return <Environment preset={DEFAULT_SKYBOX as 'forest'} background={true} />;
}

/**
 * Orbit controls for preview
 */
export function PreviewControls() {
  return (
    <OrbitControls
      enablePan={false}
      minDistance={2}
      maxDistance={6}
      autoRotate={false}
    />
  );
}

/**
 * Complete preview scene with lighting, environment, and controls
 */
export function PreviewScene({ 
  children, 
  envMapEnabled 
}: { 
  children: ReactNode; 
  envMapEnabled: boolean;
}) {
  return (
    <>
      <SceneSetup envMapEnabled={envMapEnabled} />
      <GameLighting />
      <EnvironmentMap enabled={envMapEnabled} />
      {children}
      <PreviewControls />
    </>
  );
}

/**
 * Geometry component with UV2 for AO map support
 */
export function PreviewGeometry({ 
  type, 
  geometryRef 
}: { 
  type: GeometryType; 
  geometryRef?: React.RefObject<THREE.BufferGeometry>;
}) {
  const ref = useRef<THREE.BufferGeometry>(null);
  const actualRef = geometryRef || ref;
  
  useEffect(() => {
    if (actualRef.current) {
      const uv = actualRef.current.getAttribute('uv');
      if (uv) {
        actualRef.current.setAttribute('uv2', uv.clone());
      }
    }
  }, [type]);
  
  switch (type) {
    case 'sphere':
      return <sphereGeometry ref={actualRef as any} args={[1, 64, 64]} />;
    case 'cube':
      return <boxGeometry ref={actualRef as any} args={[1.5, 1.5, 1.5]} />;
    case 'plane':
      return <planeGeometry ref={actualRef as any} args={[2.5, 2.5]} />;
    default:
      return <sphereGeometry ref={actualRef as any} args={[1, 64, 64]} />;
  }
}

/**
 * Geometry selector UI buttons
 */
export function GeometrySelector({ 
  geometry, 
  onSelect 
}: { 
  geometry: GeometryType; 
  onSelect: (geo: GeometryType) => void;
}) {
  return (
    <div className="flex gap-1">
      {(['sphere', 'cube', 'plane'] as const).map((geo) => (
        <button
          key={geo}
          onClick={() => onSelect(geo)}
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
  );
}

/**
 * Env map toggle checkbox
 */
export function EnvMapToggle({ 
  enabled, 
  onChange 
}: { 
  enabled: boolean; 
  onChange: (enabled: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onChange(e.target.checked)}
        className="w-3.5 h-3.5 rounded bg-gray-700 border-gray-600"
      />
      Env Map
    </label>
  );
}
