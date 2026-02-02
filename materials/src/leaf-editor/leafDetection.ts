/**
 * Leaf detection utilities - extract individual leaves from an opacity map
 */

import type { LeafBounds } from './types';

interface Pixel {
  x: number;
  y: number;
}

/**
 * Detect individual leaves from an opacity map using connected component analysis
 * 
 * For separate opacity images (grayscale), uses the red channel as opacity.
 * For RGBA images with transparency, uses the alpha channel.
 * The `useAlphaChannel` parameter controls which to use.
 */
export function detectLeaves(
  opacityData: ImageData,
  threshold: number = 128,
  minArea: number = 100,
  useAlphaChannel: boolean = false
): LeafBounds[] {
  const { width, height, data } = opacityData;
  
  // Create binary mask (1 = leaf, 0 = background)
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    // For separate opacity images, use red channel (grayscale)
    // For embedded alpha, use the alpha channel
    const value = useAlphaChannel 
      ? data[i * 4 + 3]  // Alpha channel
      : data[i * 4];     // Red channel (grayscale opacity)
    mask[i] = value >= threshold ? 1 : 0;
  }
  
  // Connected component labeling (flood-fill based)
  const labels = new Int32Array(width * height);
  let currentLabel = 0;
  const leaves: LeafBounds[] = [];
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      
      if (mask[idx] === 1 && labels[idx] === 0) {
        currentLabel++;
        const pixels = floodFill(mask, labels, width, height, x, y, currentLabel);
        
        if (pixels.length >= minArea) {
          const bounds = computeBounds(pixels, currentLabel);
          leaves.push(bounds);
        }
      }
    }
  }
  
  // Sort by area descending (largest leaves first)
  leaves.sort((a, b) => b.area - a.area);
  
  return leaves;
}

/**
 * Check if an image has meaningful alpha (not all 255)
 */
export function hasAlphaChannel(imageData: ImageData): boolean {
  const { data } = imageData;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 255) return true;
  }
  return false;
}

/**
 * Flood-fill to label connected component
 */
function floodFill(
  mask: Uint8Array,
  labels: Int32Array,
  width: number,
  height: number,
  startX: number,
  startY: number,
  label: number
): Pixel[] {
  const pixels: Pixel[] = [];
  const stack: Pixel[] = [{ x: startX, y: startY }];
  
  while (stack.length > 0) {
    const { x, y } = stack.pop()!;
    const idx = y * width + x;
    
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    if (mask[idx] !== 1 || labels[idx] !== 0) continue;
    
    labels[idx] = label;
    pixels.push({ x, y });
    
    // 8-connected neighbors for better leaf detection
    stack.push({ x: x - 1, y: y - 1 });
    stack.push({ x: x, y: y - 1 });
    stack.push({ x: x + 1, y: y - 1 });
    stack.push({ x: x - 1, y });
    stack.push({ x: x + 1, y });
    stack.push({ x: x - 1, y: y + 1 });
    stack.push({ x: x, y: y + 1 });
    stack.push({ x: x + 1, y: y + 1 });
  }
  
  return pixels;
}

/**
 * Compute bounding box, center, and area from pixels
 */
function computeBounds(pixels: Pixel[], id: number): LeafBounds {
  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;
  let sumX = 0, sumY = 0;
  
  for (const p of pixels) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
    sumX += p.x;
    sumY += p.y;
  }
  
  return {
    id,
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    centerX: sumX / pixels.length,
    centerY: sumY / pixels.length,
    area: pixels.length,
  };
}

/**
 * Generate a mask for a specific leaf (useful for extraction)
 */
export function createLeafMask(
  opacityData: ImageData,
  bounds: LeafBounds,
  threshold: number = 128
): ImageData {
  const { width: srcWidth, data: srcData } = opacityData;
  const { x, y, width, height } = bounds;
  
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const maskData = ctx.createImageData(width, height);
  
  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      const srcIdx = ((y + dy) * srcWidth + (x + dx)) * 4;
      const dstIdx = (dy * width + dx) * 4;
      
      const alpha = srcData[srcIdx + 3];
      const inLeaf = alpha >= threshold ? 255 : 0;
      
      maskData.data[dstIdx] = inLeaf;
      maskData.data[dstIdx + 1] = inLeaf;
      maskData.data[dstIdx + 2] = inLeaf;
      maskData.data[dstIdx + 3] = 255;
    }
  }
  
  return maskData;
}
