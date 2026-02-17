/**
 * usePresetThumbnail - React hook that returns a thumbnail URL for a BuildConfig.
 *
 * Renders a SurfaceNet mesh with the game's terrain material into a WebGLRenderTarget,
 * caching results by config hash. Returns null while the renderer isn't ready.
 *
 * Mirrors the pattern of useMaterialThumbnails.ts.
 */

import { useState, useEffect } from 'react';
import type { BuildConfig, Quat } from '@worldify/shared';
import { renderPresetThumbnail } from './PresetThumbnailRenderer';

/**
 * Get a thumbnail data URL for a single build config.
 * Re-renders only when config shape properties or rotation change.
 */
export function usePresetThumbnail(config: BuildConfig | undefined, rotation?: Quat): string | null {
  const [url, setUrl] = useState<string | null>(null);

  // Build a stable dependency key from shape-affecting properties
  const rotKey = rotation ? `${rotation.x},${rotation.y},${rotation.z},${rotation.w}` : '';
  const depKey = config
    ? `${config.mode}|${config.shape}|${config.size.x},${config.size.y},${config.size.z}|${config.material}|${config.thickness ?? 0}|${config.closed ?? 1}|${config.arcSweep ?? 0}|${rotKey}`
    : '';

  useEffect(() => {
    if (!config) {
      setUrl(null);
      return;
    }

    // Use requestAnimationFrame to render between frames
    const rafId = requestAnimationFrame(() => {
      const result = renderPresetThumbnail(config, rotation);
      setUrl(result);
    });

    return () => cancelAnimationFrame(rafId);
  }, [depKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return url;
}
