/**
 * usePresetThumbnail - React hook that returns a thumbnail URL for a BuildConfig.
 *
 * Queues a render request to the staggered thumbnail renderer (max 2 per frame).
 * Returns the cached blob URL instantly if available, otherwise null until ready.
 */

import { useState, useEffect } from 'react';
import type { BuildConfig, Quat } from '@worldify/shared';
import { queueThumbnailRender, getCachedThumbnail } from './PresetThumbnailRenderer';

/**
 * Get a thumbnail blob URL for a single build config.
 * Re-renders only when config shape properties or rotation change.
 */
export function usePresetThumbnail(config: BuildConfig | undefined, rotation?: Quat): string | null {
  // Build a stable dependency key from shape-affecting properties
  const rotKey = rotation ? `${rotation.x},${rotation.y},${rotation.z},${rotation.w}` : '';
  const depKey = config
    ? `${config.mode}|${config.shape}|${config.size.x},${config.size.y},${config.size.z}|${config.material}|${config.thickness ?? 0}|${config.closed ?? 1}|${config.arcSweep ?? 0}|${rotKey}`
    : '';

  const [url, setUrl] = useState<string | null>(() => {
    if (!config) return null;
    return getCachedThumbnail(config, rotation) ?? null;
  });

  useEffect(() => {
    if (!config) {
      setUrl(null);
      return;
    }

    // Return cached immediately if available
    const cached = getCachedThumbnail(config, rotation);
    if (cached) {
      setUrl(cached);
      return;
    }

    // Queue the render; callback fires when blob URL is ready
    let cancelled = false;
    queueThumbnailRender(config, rotation, (result) => {
      if (!cancelled) setUrl(result);
    });

    return () => { cancelled = true; };
  }, [depKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return url;
}
