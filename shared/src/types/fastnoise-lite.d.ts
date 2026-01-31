declare module 'fastnoise-lite' {
  export default class FastNoiseLite {
    constructor(seed?: number);
    SetSeed(seed: number): void;
    SetNoiseType(noiseType: number): void;
    SetFractalType(fractalType: number): void;
    SetFractalOctaves(octaves: number): void;
    SetFrequency(frequency: number): void;
    GetNoise(x: number, y: number, z?: number): number;

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
  }
}
