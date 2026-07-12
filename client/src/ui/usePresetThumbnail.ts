/**
 * usePresetThumbnail - React hook that returns a thumbnail URL for a BuildConfig.
 * Returns null until the thumbnail is ready (from cache or GPU render).
 */

import { useState, useEffect } from 'react';
import type { BuildConfig, Quat } from '@worldify/shared';
import { useGameStore } from '../state/store';
import { queueThumbnailRender, THUMB_PRIORITY } from './PresetThumbnailRenderer';

export function usePresetThumbnail(
  config: BuildConfig | undefined,
  rotation?: Quat,
  options?: { priority?: number },
): string | null {
  const priority = options?.priority ?? THUMB_PRIORITY.NORMAL;
  // Re-request when textures finish loading / quality changes — the thumbnail
  // renders untextured before that, and low/high are distinct cache entries.
  const textureState = useGameStore((s) => s.textureState);
  const rotKey = rotation ? `${rotation.x},${rotation.y},${rotation.z},${rotation.w}` : '';
  const depKey = config
    ? `${config.mode}|${config.shape}|${config.size.x},${config.size.y},${config.size.z}|${config.material}|${config.thickness ?? 0}|${config.closed ?? 1}|${config.arcSweep ?? 0}|${rotKey}|${textureState}`
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
    }, priority);

    return () => { cancelled = true; };
  }, [depKey, priority]); // eslint-disable-line react-hooks/exhaustive-deps

  return url;
}
