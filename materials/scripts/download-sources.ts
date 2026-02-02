/**
 * Download source textures from R2
 * 
 * Usage: npm run download-sources
 */

import { downloadFile, listObjects, formatBytes } from './r2-client.js';
import fs from 'fs/promises';
import path from 'path';

const SOURCES_PREFIX = 'sources/';
const LOCAL_SOURCES_DIR = './sources';

async function downloadSources() {
  console.log('📦 Fetching source texture list from R2...\n');

  const objects = await listObjects(SOURCES_PREFIX);
  
  if (objects.length === 0) {
    console.log('❌ No source textures found in R2.');
    console.log('   Run `npm run upload:sources` first to upload textures.');
    return;
  }

  console.log(`Found ${objects.length} files to download\n`);

  let downloaded = 0;
  let totalBytes = 0;

  for (const key of objects) {
    const relativePath = key.replace(SOURCES_PREFIX, '');
    const localPath = path.join(LOCAL_SOURCES_DIR, relativePath);
    
    // Create directory if needed
    await fs.mkdir(path.dirname(localPath), { recursive: true });

    // Check if file already exists
    try {
      await fs.access(localPath);
      console.log(`⏭️  Skipping (exists): ${relativePath}`);
      continue;
    } catch {
      // File doesn't exist, download it
    }

    console.log(`⬇️  Downloading: ${relativePath}`);
    const data = await downloadFile(key);
    await fs.writeFile(localPath, data);
    
    downloaded++;
    totalBytes += data.length;
  }

  console.log(`\n✅ Downloaded ${downloaded} files (${formatBytes(totalBytes)})`);
}

downloadSources().catch(err => {
  console.error('Error downloading sources:', err);
  process.exit(1);
});
