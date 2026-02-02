/**
 * Types for the Leaf Texture Editor
 */

export interface LeafBounds {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  area: number;
}

export interface PlacedLeaf {
  id: string;
  sourceId: number;  // Reference to detected leaf bounds
  x: number;         // Position in output canvas
  y: number;
  rotation: number;  // Degrees
  scale: number;
  flipX: boolean;
  flipY: boolean;
  zIndex: number;    // Layer order (higher = on top)
}

export interface TextureLayer {
  name: LayerType;
  image: HTMLImageElement | null;
  imageData: ImageData | null;
}

export interface LoadedAtlas {
  baseName: string;
  layers: Map<LayerType, TextureLayer>;
  width: number;
  height: number;
}

export type LayerType = 'Color' | 'Opacity' | 'NormalGL' | 'NormalDX' | 'Roughness' | 'Displacement';

// Common suffixes used in texture naming
export const LAYER_PATTERNS: Record<LayerType, string[]> = {
  Color: ['Color', 'Albedo', 'Diffuse', 'BaseColor', 'Base_Color'],
  Opacity: ['Opacity', 'Alpha', 'Transparency'],
  NormalGL: ['NormalGL', 'Normal_GL'],
  NormalDX: ['NormalDX', 'Normal_DX', 'Normal'],
  Roughness: ['Roughness', 'Rough'],
  Displacement: ['Displacement', 'Height', 'Disp'],
};

// Layer types to look for when loading
export const REQUIRED_LAYERS: LayerType[] = ['Color', 'Opacity'];
export const OPTIONAL_LAYERS: LayerType[] = ['NormalGL', 'NormalDX', 'Roughness', 'Displacement'];

// Scatter settings per source leaf
export interface ScatterSettings {
  sourceId: number;
  probability: number;  // Weight for random selection (0-1)
  enabled: boolean;     // Include in scatter
}

export interface SourceFolder {
  name: string;
  files: string[];
}
