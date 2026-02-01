declare module 'fastnoise-lite' {
  export default class FastNoiseLite {
    constructor(seed?: number);
    SetSeed(seed: number): void;
    SetNoiseType(noiseType: number): void;
    SetFractalType(fractalType: number): void;
    SetFractalOctaves(octaves: number): void;
    SetFrequency(frequency: number): void;
    GetNoise(x: number, y: number, z?: number): number;
    
    // Cellular noise settings
    SetCellularDistanceFunction(distanceFunction: string): void;
    SetCellularReturnType(returnType: string): void;
    SetCellularJitter(jitter: number): void;

    // Noise types
    static readonly NoiseType: {
      OpenSimplex2: number;
      OpenSimplex2S: number;
      Cellular: number;
      Perlin: number;
      ValueCubic: number;
      Value: number;
    };

    // Fractal types
    static readonly FractalType: {
      None: number;
      FBm: number;
      Ridged: number;
      PingPong: number;
      DomainWarpProgressive: number;
      DomainWarpIndependent: number;
    };
    
    // Cellular distance functions
    static readonly CellularDistanceFunction: {
      Euclidean: string;
      EuclideanSq: string;
      Manhattan: string;
      Hybrid: string;
    };
    
    // Cellular return types
    static readonly CellularReturnType: {
      CellValue: string;
      Distance: string;
      Distance2: string;
      Distance2Add: string;
      Distance2Sub: string;
      Distance2Mul: string;
      Distance2Div: string;
    };
  }
}
