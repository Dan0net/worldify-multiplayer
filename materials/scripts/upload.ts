/**
 * Upload compiled binaries to R2
 * 
 * Usage: npm run upload
 * 
 * Reads the current version from output/version.txt and uploads to binaries/v{N}/
 */

import { uploadFile, formatBytes, fileExists } from './r2-client.js';
import fs from 'fs/promises';
import path from 'path';

const OUTPUT_DIR = './output';
const BINARIES_PREFIX = 'binaries/';

async function getNextVersion(): Promise<number> {
  // Check what versions exist in R2
  let version = 1;
  while (await fileExists(`${BINARIES_PREFIX}v${version}/pallet.json`)) {
    version++;
  }
  return version;
}

async function uploadBinaries() {
  console.log('📦 Uploading binaries to R2...\n');

  // Check output exists
  try {
    await fs.access(OUTPUT_DIR);
  } catch {
    console.log('❌ No output directory found. Run `npm run build` first.');
    return;
  }

  // Check pallet.json exists
  const palletPath = path.join(OUTPUT_DIR, 'pallet.json');
  try {
    await fs.access(palletPath);
  } catch {
    console.log('❌ No pallet.json found. Run `npm run build` first.');
    return;
  }

  // Determine version
  const version = await getNextVersion();
  const versionPrefix = `${BINARIES_PREFIX}v${version}/`;
  
  console.log(`📌 Uploading as version: v${version}\n`);

  let uploaded = 0;
  let totalBytes = 0;

  // Upload pallet.json
  const palletData = await fs.readFile(palletPath);
  await uploadFile(`${versionPrefix}pallet.json`, palletData, 'application/json');
  console.log(`⬆️  pallet.json (${formatBytes(palletData.length)})`);
  uploaded++;
  totalBytes += palletData.length;

  // Upload low resolution
  const lowDir = path.join(OUTPUT_DIR, 'low');
  try {
    const lowFiles = await fs.readdir(lowDir);
    for (const file of lowFiles) {
      if (!file.endsWith('.bin')) continue;
      const data = await fs.readFile(path.join(lowDir, file));
      await uploadFile(`${versionPrefix}low/${file}`, data, 'application/octet-stream');
      console.log(`⬆️  low/${file} (${formatBytes(data.length)})`);
      uploaded++;
      totalBytes += data.length;
    }
  } catch {
    console.log('⚠️  No low/ directory found');
  }

  // Upload high resolution
  const highDir = path.join(OUTPUT_DIR, 'high');
  try {
    const highFiles = await fs.readdir(highDir);
    for (const file of highFiles) {
      if (!file.endsWith('.bin')) continue;
      const data = await fs.readFile(path.join(highDir, file));
      await uploadFile(`${versionPrefix}high/${file}`, data, 'application/octet-stream');
      console.log(`⬆️  high/${file} (${formatBytes(data.length)})`);
      uploaded++;
      totalBytes += data.length;
    }
  } catch {
    console.log('⚠️  No high/ directory found');
  }

  // Update latest pointer
  const latestManifest = JSON.stringify({ version, path: `v${version}` });
  await uploadFile(`${BINARIES_PREFIX}latest.json`, Buffer.from(latestManifest), 'application/json');

  console.log(`\n✅ Uploaded ${uploaded} files (${formatBytes(totalBytes)})`);
  console.log(`\n📍 Binaries available at: binaries/v${version}/`);
  console.log(`   Latest pointer updated: binaries/latest.json`);
}

uploadBinaries().catch(err => {
  console.error('Error uploading binaries:', err);
  process.exit(1);
});
