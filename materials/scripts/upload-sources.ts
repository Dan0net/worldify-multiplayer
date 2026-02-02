/**
 * Upload source textures to R2
 * 
 * Usage: npm run upload:sources
 */

import { uploadFile, formatBytes } from './r2-client.js';
import fs from 'fs/promises';
import path from 'path';
import { glob } from 'glob';

const LOCAL_SOURCES_DIR = './sources';
const SOURCES_PREFIX = 'sources/';

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

async function uploadSources() {
  console.log('📦 Scanning source textures...\n');

  const files = await glob(`${LOCAL_SOURCES_DIR}/**/*.{png,jpg,jpeg}`, {
    nodir: true,
  });

  if (files.length === 0) {
    console.log('❌ No source textures found in ./sources');
    console.log('   Copy your PBR textures into ./sources/{material_name}/');
    return;
  }

  console.log(`Found ${files.length} files to upload\n`);

  let uploaded = 0;
  let totalBytes = 0;

  for (const filePath of files) {
    const relativePath = path.relative(LOCAL_SOURCES_DIR, filePath);
    const r2Key = SOURCES_PREFIX + relativePath;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    console.log(`⬆️  Uploading: ${relativePath}`);
    
    const data = await fs.readFile(filePath);
    await uploadFile(r2Key, data, contentType);
    
    uploaded++;
    totalBytes += data.length;
  }

  console.log(`\n✅ Uploaded ${uploaded} files (${formatBytes(totalBytes)})`);
}

uploadSources().catch(err => {
  console.error('Error uploading sources:', err);
  process.exit(1);
});
