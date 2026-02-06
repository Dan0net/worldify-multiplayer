/**
 * Material Bundler - Compile PBR textures into DataArrayTexture binaries
 * 
 * Usage:
 *   npm run build           # Build both resolutions
 *   npm run build:low       # Build only low-res (128x128)
 *   npm run build:high      # Build only high-res (1024x1024)
 * 
 * Outputs:
 *   - output/{low,high}/*.bin - Binary texture data for R2 upload
 *   - output/pallet.json - Copy for R2 upload
 *   - ../shared/src/materials/pallet.json - Embedded in shared package
 */

import sharp from 'sharp';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, '../config/materials.json');
const SOURCES_DIR = path.join(__dirname, '../sources');
const OUTPUT_DIR = path.join(__dirname, '../output');
const SHARED_PALLET_PATH = path.join(__dirname, '../../shared/src/materials/pallet.json');

// Map types to their channel configurations
const MAP_CHANNELS: Record<string, string> = {
  albedo: 'rgba',
  normal: 'rgba',
  ao: 'r',
  roughness: 'r',
  metalness: 'r',
};

const CHANNEL_INDICES: Record<string, number> = { r: 0, g: 1, b: 2, a: 3 };

interface MapConfig {
  path?: string;
  channel?: string;
  color?: { r: number; g: number; b: number; alpha?: number };
}

interface MaterialConfig {
  type: 'solid' | 'liquid' | 'transparent';
  enabled?: boolean;
  index?: number;
  repeatScale?: number;
  albedo?: MapConfig;
  normal?: MapConfig;
  ao?: MapConfig;
  roughness?: MapConfig;
  metalness?: MapConfig;
}

interface Config {
  textureSize: { low: number; high: number };
  materials: Record<string, MaterialConfig>;
}

interface ProcessedMap {
  data: Buffer;
  width: number;
  height: number;
  channels: string;
}

async function loadConfig(): Promise<Config> {
  const configData = await fs.readFile(CONFIG_PATH, 'utf-8');
  return JSON.parse(configData);
}

async function processImage(
  mapPath: string | undefined,
  mapConfig: MapConfig | undefined,
  mapType: string,
  textureSize: number
): Promise<{ data: Buffer; info: sharp.OutputInfo }> {
  if (mapConfig?.path) {
    const fullPath = path.join(SOURCES_DIR, mapConfig.path);
    
    // Normal maps must NOT be normalized — they encode tangent-space directions
    // where (128, 128, 255) = flat surface. Stretching the range destroys this
    // meaning and produces resolution-dependent results (low-res images have a
    // narrower value range after downsampling, causing more aggressive distortion).
    return sharp(fullPath)
      .resize(textureSize, textureSize)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
  }

  // Default colors for each map type when no texture is provided
  // Most maps default to white (1.0), but metalness defaults to black (0.0 = non-metallic)
  const defaultColors: Record<string, { r: number; g: number; b: number }> = {
    albedo: { r: 128, g: 128, b: 128 },   // Mid-gray
    normal: { r: 128, g: 128, b: 255 },   // Flat normal (pointing up)
    ao: { r: 255, g: 255, b: 255 },       // No occlusion
    roughness: { r: 200, g: 200, b: 200 }, // Fairly rough
    metalness: { r: 0, g: 0, b: 0 },      // Non-metallic (critical!)
  };

  const defaults = defaultColors[mapType] || { r: 255, g: 255, b: 255 };
  
  // Generate solid color texture
  const background = {
    r: mapConfig?.color?.r ?? defaults.r,
    g: mapConfig?.color?.g ?? defaults.g,
    b: mapConfig?.color?.b ?? defaults.b,
    alpha: mapConfig?.color?.alpha ?? 1.0,
  };

  return sharp({
    create: {
      width: textureSize,
      height: textureSize,
      channels: 4,
      background,
    },
  })
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function extractChannels(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
  channelMapping: string
): Buffer {
  const channelSize = width * height;
  const extractedData = Buffer.alloc(channelSize * channelMapping.length);

  let channelWriteIndex = 0;
  for (const channelLetter of channelMapping) {
    const channelReadIndex = CHANNEL_INDICES[channelLetter.toLowerCase()];
    for (let i = 0; i < channelSize; i++) {
      extractedData[i * channelMapping.length + channelWriteIndex] =
        data[i * channels + channelReadIndex];
    }
    channelWriteIndex++;
  }

  return extractedData;
}

function combineImages(images: ProcessedMap[]): {
  combinedData: Buffer;
  width: number;
  height: number;
  channels: string;
  layers: number;
} {
  const width = images[0].width;
  const height = images[0].height;
  const channels = images[0].channels;
  const layers = images.length;
  const layerSize = width * height * channels.length;
  const totalSize = layerSize * layers;
  const combinedData = Buffer.alloc(totalSize);

  images.forEach((image, index) => {
    image.data.copy(combinedData, index * layerSize);
  });

  return { combinedData, width, height, channels, layers };
}

async function buildTextures(resolution: 'low' | 'high') {
  const config = await loadConfig();
  const textureSize = config.textureSize[resolution];
  const outputPath = path.join(OUTPUT_DIR, resolution);

  console.log(`\n🔧 Building ${resolution} resolution (${textureSize}×${textureSize})...\n`);

  // Ensure output directory exists
  await fs.mkdir(outputPath, { recursive: true });

  const maps: Record<string, ProcessedMap[]> = {
    albedo: [],
    normal: [],
    ao: [],
    roughness: [],
    metalness: [],
  };

  const materialIndices: Record<string, number> = {};
  const materialTypes: Record<string, number[]> = {
    solid: [],
    liquid: [],
    transparent: [],
  };
  const materialColors: string[] = [];
  const repeatScales: number[] = [];
  let materialIndex = 0;

  // Get enabled materials sorted by index
  const materialNames = Object.entries(config.materials)
    .filter(([_, mat]) => mat.enabled !== false)
    .sort((a, b) => (a[1].index ?? 9999) - (b[1].index ?? 9999))
    .map(([name]) => name);

  console.log(`Processing ${materialNames.length} enabled materials...\n`);

  for (const materialName of materialNames) {
    const material = config.materials[materialName];
    const idx = materialIndex++;
    materialIndices[materialName] = idx;
    materialTypes[material.type].push(idx);
    repeatScales.push(material.repeatScale ?? 2);

    for (const mapType of Object.keys(MAP_CHANNELS)) {
      const mapConfig = material[mapType as keyof MaterialConfig] as MapConfig | undefined;

      const { data, info } = await processImage(
        mapConfig?.path,
        mapConfig,
        mapType,
        textureSize
      );

      const { width, height, channels } = info;

      // Determine which channel(s) to extract
      // Use config channel if specified, otherwise use default for map type
      const extractChannel = mapConfig?.channel || MAP_CHANNELS[mapType];

      // Calculate average color for albedo
      if (mapType === 'albedo') {
        const stats = await sharp(data, { raw: { width, height, channels } }).stats();
        const toHex = (val: number) => Math.round(val).toString(16).padStart(2, '0');
        const avgColorHex = `#${toHex(stats.channels[0].mean)}${toHex(stats.channels[1].mean)}${toHex(stats.channels[2].mean)}`;
        materialColors.push(avgColorHex);
      }

      const dataExtracted = extractChannels(data, width, height, channels, extractChannel);

      maps[mapType].push({
        data: dataExtracted,
        width,
        height,
        channels: MAP_CHANNELS[mapType],
      });
    }

    process.stdout.write(`  ✓ ${materialName}\n`);
  }

  // Build pallet.json - always regenerate material data from config
  const outputPalletPath = path.join(OUTPUT_DIR, 'pallet.json');
  let pallet: any;
  
  try {
    const existingPallet = await fs.readFile(outputPalletPath, 'utf-8');
    pallet = JSON.parse(existingPallet);
    // Update all material data from current config
    pallet.materials = materialNames;
    pallet.indicies = materialIndices;
    pallet.types = materialTypes;
    pallet.colors = materialColors;
    pallet.repeatScales = repeatScales;
  } catch {
    pallet = {
      materials: materialNames,
      maps: { low: {}, high: {} },
      indicies: materialIndices,
      types: materialTypes,
      colors: materialColors,
      repeatScales: repeatScales,
    };
  }

  // Write binary files for each map type
  console.log(`\nWriting binary files...`);

  for (const mapType of Object.keys(maps)) {
    if (maps[mapType].length === 0) continue;

    const { combinedData, width, height, layers } = combineImages(maps[mapType]);
    const outputFile = path.join(outputPath, `${mapType}.bin`);
    
    await fs.writeFile(outputFile, combinedData);

    const sizeMB = (combinedData.length / (1024 * 1024)).toFixed(2);
    console.log(`  ✓ ${mapType}.bin (${sizeMB} MB)`);

    pallet.maps[resolution][mapType] = {
      width: textureSize,
      height: textureSize,
      channels: maps[mapType][0].channels,
      layers,
    };
  }

  // Write pallet.json to output directory (for R2 upload)
  await fs.writeFile(outputPalletPath, JSON.stringify(pallet));
  console.log(`  ✓ pallet.json (output)`);

  // Also write pallet.json to shared package (for embedded use)
  await fs.mkdir(path.dirname(SHARED_PALLET_PATH), { recursive: true });
  await fs.writeFile(SHARED_PALLET_PATH, JSON.stringify(pallet, null, 2));
  console.log(`  ✓ pallet.json (shared)`);

  console.log(`\n✅ ${resolution} build complete!`);
}

async function main() {
  const args = process.argv.slice(2);
  
  // Parse --resolution flag
  const resolutionArg = args.find(arg => arg.startsWith('--resolution='));
  const resolution = resolutionArg?.split('=')[1] as 'low' | 'high' | undefined;

  // Check sources exist
  try {
    await fs.access(SOURCES_DIR);
  } catch {
    console.log('❌ No sources directory found.');
    console.log('   Copy your source textures into ./sources/{material_name}/');
    console.log('   Or run `npm run download-sources` to fetch from R2.');
    process.exit(1);
  }

  // Ensure output directory exists
  await fs.mkdir(OUTPUT_DIR, { recursive: true });

  if (resolution === 'low') {
    await buildTextures('low');
  } else if (resolution === 'high') {
    await buildTextures('high');
  } else {
    // Build both
    await buildTextures('low');
    await buildTextures('high');
  }

  console.log('\n🎉 All builds complete!');
  console.log('   pallet.json has been updated in shared/src/materials/');
}

main().catch(err => {
  console.error('Build error:', err);
  process.exit(1);
});
