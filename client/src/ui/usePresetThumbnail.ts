/**
 * usePresetThumbnail - React hook that returns a thumbnail URL for a BuildConfig.
 * Returns null until the thumbnail is ready (from cache or GPU render).
 */

import { useState, useEffect } from 'react';
import type { BuildPart, Quat } from '@worldify/shared';
import { useGameStore } from '../state/store';
import { queueThumbnailRender, THUMB_PRIORITY } from './PresetThumbnailRenderer';

export function usePresetThumbnail(
  parts: BuildPart[] | undefined,
  rotation?: Quat,
  options?: { priority?: number },
): string | null {
  const priority = options?.priority ?? THUMB_PRIORITY.NORMAL;
  // Re-request when textures finish loading / quality changes — the thumbnail
  // renders untextured before that, and low/high are distinct cache entries.
  const textureState = useGameStore((s) => s.textureState);
  const rotKey = rotation ? `${rotation.x},${rotation.y},${rotation.z},${rotation.w}` : '';
  const partsKey = (parts ?? [])
    .map((p) => `${p.config.shape},${p.config.mode},${p.config.material},${p.config.size.x},${p.config.size.y},${p.config.size.z},${p.config.thickness ?? 0},${p.config.closed ?? 1},${p.config.arcSweep ?? 0}@${p.offset.x},${p.offset.y},${p.offset.z}`)
    .join(';');
  const depKey = parts && parts.length ? `${partsKey}|${rotKey}|${textureState}` : '';

  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!parts || !parts.length) {
      setUrl(null);
      return;
    }

    let cancelled = false;
    queueThumbnailRender(parts, rotation, (result) => {
      if (!cancelled) setUrl(result);
    }, priority);

    return () => { cancelled = true; };
  }, [depKey, priority]); // eslint-disable-line react-hooks/exhaustive-deps

  return url;
}
