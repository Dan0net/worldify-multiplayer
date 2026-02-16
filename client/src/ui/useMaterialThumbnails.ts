/**
 * useMaterialThumbnails - Hook that provides blob URLs for material texture thumbnails.
 *
 * Loads the low-resolution albedo binary (128×128 per material, ~3.4 MB total),
 * extracts each material's layer into a small canvas, converts to blob URLs, and
 * caches them for the lifetime of the page.
 *
 * Returns `null` while loading, then a `string[]` of blob URLs indexed by material ID.
 */

import { useState, useEffect } from 'react';
import { MATERIAL_PALLET } from '@worldify/shared';
import { textureCache } from '../game/material/TextureCache';

// Module-level cache so we only generate thumbnails once across all mounts
let cachedThumbnails: string[] | null = null;
let loadPromise: Promise<string[]> | null = null;

const THUMB_SIZE = 48; // Render each thumbnail at 48×48

async function generateThumbnails(): Promise<string[]> {
  const pallet = MATERIAL_PALLET as { maps: { low: { albedo: { width: number; height: number; channels: string; layers: number } } } };
  const meta = pallet.maps.low.albedo;
  const { width, height, channels } = meta;
  const channelCount = channels.length; // 4 for RGBA

  // Try loading from IndexedDB cache first, then fetch from CDN
  let data: Uint8Array;
  const cached = await textureCache.getTexture('low', 'albedo');
  if (cached) {
    data = new Uint8Array(cached);
  } else {
    const baseUrl = await textureCache.getLatestMaterialUrl();
    const response = await fetch(`${baseUrl}/low/albedo.bin`);
    if (!response.ok) throw new Error(`Failed to fetch albedo.bin: ${response.status}`);
    const buffer = await response.arrayBuffer();
    data = new Uint8Array(buffer);
  }

  const layerSize = width * height * channelCount;
  const materialCount = data.byteLength / layerSize;

  // Create an offscreen canvas for rendering each layer
  const canvas = document.createElement('canvas');
  canvas.width = THUMB_SIZE;
  canvas.height = THUMB_SIZE;
  const ctx = canvas.getContext('2d')!;

  // Source canvas at full resolution for a single layer
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = width;
  srcCanvas.height = height;
  const srcCtx = srcCanvas.getContext('2d')!;

  const urls: string[] = [];

  for (let i = 0; i < materialCount; i++) {
    const offset = i * layerSize;
    const imageData = srcCtx.createImageData(width, height);

    for (let p = 0; p < width * height; p++) {
      const srcIdx = offset + p * channelCount;
      const dstIdx = p * 4;
      imageData.data[dstIdx] = data[srcIdx];
      imageData.data[dstIdx + 1] = data[srcIdx + 1];
      imageData.data[dstIdx + 2] = data[srcIdx + 2];
      imageData.data[dstIdx + 3] = channelCount === 4 ? data[srcIdx + 3] : 255;
    }

    srcCtx.putImageData(imageData, 0, 0);

    // Draw scaled down to thumbnail size
    ctx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
    ctx.drawImage(srcCanvas, 0, 0, THUMB_SIZE, THUMB_SIZE);

    // Convert to blob URL
    const blob = await new Promise<Blob>((resolve) => {
      canvas.toBlob((b) => resolve(b!), 'image/png');
    });
    urls.push(URL.createObjectURL(blob));
  }

  return urls;
}

export function useMaterialThumbnails(): string[] | null {
  const [thumbnails, setThumbnails] = useState<string[] | null>(cachedThumbnails);

  useEffect(() => {
    if (cachedThumbnails) {
      setThumbnails(cachedThumbnails);
      return;
    }

    if (!loadPromise) {
      loadPromise = generateThumbnails().then((urls) => {
        cachedThumbnails = urls;
        return urls;
      });
    }

    loadPromise.then(setThumbnails).catch((err) => {
      console.warn('[MaterialThumbnails] Failed to generate thumbnails:', err);
    });
  }, []);

  return thumbnails;
}
