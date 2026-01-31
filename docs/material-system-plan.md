# Material System - Cloudflare R2 Migration

## Overview

Port the PBR material system from worldify-app to worldify-multiplayer, hosting binaries on Cloudflare R2 for free egress.

## Architecture

```
worldify-materials/              # New standalone repo
├── scripts/
│   ├── bundle.ts                # Compile textures → binaries
│   ├── upload.ts                # Push to R2
│   └── download-sources.ts      # Pull sources for local dev
├── sources/                     # Downloaded from R2, git-ignored
├── output/                      # Generated binaries, git-ignored
└── config/materials.json

Cloudflare R2 (worldify-materials bucket)
├── sources/                     # ~700 MB raw PBR textures
└── binaries/
    └── v{N}/                    # Versioned releases
        ├── pallet.json          # Manifest
        ├── low/  (8 MB)         # 128×128 arrays
        └── high/ (540 MB)       # 1024×1024 arrays
```

## Loading Strategy

1. **App start**: Fetch `pallet.json`, load low-res from IndexedDB or R2
2. **Render immediately** with low-res textures
3. **Spectator screen**: Show "Download HD Textures" button if not cached
4. **On click**: Stream high-res, cache in IndexedDB, hot-swap

## Implementation Phases

### Phase 1: R2 Setup
- [ ] Create Cloudflare account + R2 bucket `worldify-materials`
- [ ] Generate API token with R2 read/write
- [ ] Upload existing binaries from worldify-app
- [ ] Test public URL access

### Phase 2: Client Loader (worldify-multiplayer)
- [ ] Port `TerrainMaterial.ts` (tri-planar shader)
- [ ] Port `TextureStore.ts` (IndexedDB cache)
- [ ] Port `MaterialPallet.ts` (manifest loader)
- [ ] Add `VITE_MATERIAL_URL` env var
- [ ] Integrate with ChunkMesh rendering
- [ ] Add HD download button to spectator UI

### Phase 3: Standalone Bundler Repo
- [ ] Create `worldify-materials` repo
- [ ] Port bundler to TypeScript
- [ ] R2 upload/download scripts
- [ ] npm scripts: `build`, `upload`, `download-sources`

### Phase 4: CI/CD (GitHub Actions)

```yaml
# .github/workflows/build-materials.yml
on:
  push:
    paths: ['config/materials.json']
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run download-sources  # From R2
      - run: npm run build             # Generate binaries
      - run: npm run upload            # Push to R2 with new version
    env:
      R2_ACCESS_KEY: ${{ secrets.R2_ACCESS_KEY }}
      R2_SECRET_KEY: ${{ secrets.R2_SECRET_KEY }}
```

**npm scripts in worldify-materials:**
```json
{
  "scripts": {
    "download-sources": "tsx scripts/download-sources.ts",
    "build": "tsx scripts/bundle.ts",
    "build:low": "tsx scripts/bundle.ts --resolution=low",
    "build:high": "tsx scripts/bundle.ts --resolution=high",
    "upload": "tsx scripts/upload.ts"
  }
}
```

### Phase 5: Source Migration
- [ ] Upload source textures from worldify-app to R2
- [ ] Remove from Git LFS in worldify-app
- [ ] Update worldify-app to fetch from R2

## File Sizes

| Resolution | Total | Per-texture |
|------------|-------|-------------|
| Low (128²) | 8 MB | ~160 KB |
| High (1024²) | 540 MB | ~10 MB |

## R2 Cost

**Free tier covers everything:**
- Storage: 10 GB free (we use ~1.5 GB)
- Egress: Always free
- Operations: 1M writes, 10M reads/month free

## Key Files to Port

From worldify-app:
- `src/material/TerrainMaterial.ts` → Complex tri-planar blending shader
- `src/material/MaterialPallet.ts` → Manifest loader
- `src/store/TextureStore.ts` → IndexedDB cache
- `material_bundler/bundle.js` → Texture compiler

## Environment Variables

```env
# worldify-multiplayer client
VITE_MATERIAL_URL=https://pub-xxx.r2.dev/binaries/v1

# worldify-materials scripts
R2_ACCOUNT_ID=xxx
R2_ACCESS_KEY=xxx
R2_SECRET_KEY=xxx
R2_BUCKET=worldify-materials
```
