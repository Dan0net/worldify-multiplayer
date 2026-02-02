/**
 * MaterialPallet - Material manifest types
 */

export interface MapMetadata {
  width: number;
  height: number;
  channels: string;
  layers: number;
}

export interface MaterialPallet {
  materials: string[];
  maps: {
    low: Record<string, MapMetadata>;
    high: Record<string, MapMetadata>;
  };
  indicies: Record<string, number>;
  types: {
    solid: number[];
    liquid: number[];
    transparent: number[];
  };
  colors: string[];
}
