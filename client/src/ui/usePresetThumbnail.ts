/**
 * usePresetThumbnail - React hook that returns a thumbnail URL for a BuildConfig.
 * Returns null until the thumbnail is ready (from cache or GPU render).
 */

import { useState, useEffect } from 'react';
import type { BuildConfig, Quat } from '@worldify/shared';
import { queueThumbnailRender } from './PresetThumbnailRenderer';

export function usePresetThumbnail(config: BuildConfig | undefined, rotation?: Quat): string | null {
  const rotKey = rotation ? `${rotation.x},${rotation.y},${rotation.z},${rotation.w}` : '';
  const depKey = config
    ? `${config.mode}|${config.shape}|${config.size.x},${config.size.y},${config.size.z}|${config.material}|${config.thickness ?? 0}|${config.closed ?? 1}|${config.arcSweep ?? 0}|${rotKey}`
    : '';

  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!config) {
      setUrl(null);
      return;
    }

    let cancelled = false;
    queueThumbnailRender(config, rotation, (result) => {
      if (!cancelled) setUrl(result);
    });

    return () => { cancelled = true; };
  }, [depKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return url;
}
