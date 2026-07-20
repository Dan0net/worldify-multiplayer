# CLAUDE.md — Worldify Multiplayer

Guidance for AI coding sessions. Read the linked docs before working in the relevant area — the
environment is ephemeral, so anything not in the repo is forgotten between sessions.

## Project

Real-time multiplayer voxel game. TypeScript monorepo: `shared/` (protocol + terrain + voxel logic,
used by both sides), `client/` (React + Three.js + Zustand), `server/` (Node WebSocket). See
`docs/project-instructions.md` for the product concept and deploy stack.

## Build & verify

- `npm run build` — builds shared + client + server (tsc). Run after edits.
- `npm run test:run` — full unit suite (vitest) from repo root.
- No headless WebGL asserts; verify rendering in-app (Chromium/Playwright available) or via the Debug
  panel. Prefer the dedicated file/search tools over shelling out.

## Terrain generation — READ FIRST before touching `shared/src/terrain/**`

`docs/terrain-generation-performance.md` is the durable performance guide: the cost map, the
optimization **invariants**, the **byte-identity guard + re-baseline discipline**, and how to profile
(workers show as separate Chrome lanes; node under-weights noise ~10×). `docs/terrain-generation-system.md`
covers the design/architecture.

Non-negotiables when changing generation:
- **Follow the invariants** in the perf guide (typed arrays over object arrays; packed integer Map keys,
  never `${a},${b}`; per-cell AABB broad-phase; memoize per column/cell; noise is costly on device —
  count calls; preallocate/scratch, don't grow/box).
- **Keep the checksum guards green** (`caveReject`/`columnMemo`/`stampCache` tests). A pure optimization
  must not change the checksum. An intentional visual/output change re-baselines all three *and* says why
  in the guard comment + commit message. Never re-baseline to mask an accident.
- **Every new terrain feature ships with (1) a checksum guard and (2) a visibility assertion** ("produces
  > N voxels in a representative sample"). The cavern spikes were invisible their whole life because
  nothing asserted they existed.
- Measure with `BENCH=1 npx vitest run shared/src/terrain/terrainCost.bench.test.ts` before/after.

## Conventions

- GitHub: use the `mcp__github__*` tools (no `gh` CLI). Don't open a PR unless asked.
- Keep commits scoped; explain *why*, not just *what*. Match surrounding code style.
