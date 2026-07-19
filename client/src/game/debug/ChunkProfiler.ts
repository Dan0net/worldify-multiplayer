/**
 * ChunkProfiler — end-to-end timing of the "request → display" chunk pipeline.
 *
 * Purpose: answer "what is taking time to display chunks?" with a per-stage breakdown, so two
 * builds can be A/B'd on the SAME numbers (e.g. current main vs an old baseline). It records
 * wall-clock milestones for every chunk as it flows through the pipeline and reports percentile
 * stage costs plus the headline "time to first / Nth chunk visible".
 *
 * Pipeline stages (main-thread clock, one row per chunk):
 *   request ─(pool wait + gen + transfer)→ receive/ingest ─→ queued ─(mesh queue wait)→
 *   mesh dispatch ─(mesh compute)→ mesh applied ─(≈1 frame)→ VISIBLE (drawn)
 *
 * Generation is split further using the worker's own `genMs` (elapsed inside the terrain worker):
 *   receiveLatency = receive − request  ≈  poolWait + genMs + transfer
 * so we can tell "worker was busy generating" from "request sat queued behind other work".
 *
 * All hooks are cheap `performance.now()` stamps gated on `enabled`. Recording is capped so a long
 * session can't grow unbounded; the visible-order counters keep running past the cap.
 *
 * Read it from the Load Timing panel (mobile) or `window.__chunkProfile` in the console (desktop):
 *   __chunkProfile.report()   → console tables + returns a text summary
 *   __chunkProfile.reportText() → the same summary as a string (panel "Copy report" uses this)
 *   __chunkProfile.reset()    → clear and re-arm (call before the run you want to measure)
 *
 * Scope note: gen timing (poolWait/genMs) is the LOCAL worker path only (offline / mobile). The
 * ingest→visible stages are path-independent (they also cover the network path).
 */

export type GenKind = 'chunk' | 'tile' | 'column';

interface ChunkRec {
  tRequested?: number;   // per-chunk terrain request was posted (chunk-kind requests only)
  tReceived?: number;    // data arrived on the main thread (ingest began)
  tIngested?: number;    // ingest finished (sunlight + visibility + neighbour relights done)
  tQueued?: number;      // added to the remesh queue
  tMeshDispatch?: number; // handed to a mesh worker
  tMeshApplied?: number;  // mesh result applied to geometry
  tVisible?: number;      // first frame the render gate drew it
  visibleOrder?: number;  // 1-based order in which chunks became visible
}

interface GenSamples { latency: number[]; gen: number[]; wait: number[] }

function pct(arr: number[], p: number): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))));
  return s[idx];
}
function sum(arr: number[]): number { let t = 0; for (const v of arr) t += v; return t; }
const r1 = (n: number) => Math.round(n * 10) / 10;

/** A stage's cost samples across chunks (ms). */
function stage(recs: ChunkRec[], from: keyof ChunkRec, to: keyof ChunkRec): number[] {
  const out: number[] = [];
  for (const r of recs) {
    const a = r[from]; const b = r[to];
    if (typeof a === 'number' && typeof b === 'number' && b >= a) out.push(b - a);
  }
  return out;
}

export interface ProfilerSnapshot {
  startedMs: number;          // ms since session start (0 if not started)
  visibleCount: number;
  firstVisibleMs: number;     // t0 → 1st chunk drawn
  to10Ms: number; to25Ms: number; to50Ms: number; to100Ms: number;
  genCounts: Record<GenKind, number>;
  // Per-kind worker generation (ms): p50/p95 of pure gen and of pool-queue wait.
  genP50: Record<GenKind, number>; genP95: Record<GenKind, number>;
  waitP50: Record<GenKind, number>; waitP95: Record<GenKind, number>;
  genTotalMs: Record<GenKind, number>; // summed worker gen time (throughput/load gauge)
  // Pipeline stages over the chunks that became visible (ms).
  ingestP50: number; ingestP95: number;
  meshWaitP50: number; meshWaitP95: number;   // queued → dispatched (remesh queue + margin defer + throttle)
  meshP50: number; meshP95: number;           // dispatched → applied (worker compute + round-trip)
  appliedToVisibleP50: number;                // applied → drawn (≈1 frame gate)
  ingestToVisibleP50: number; ingestToVisibleP95: number; // receive → drawn (whole client-side tail)
}

class ChunkProfiler {
  enabled = true;
  private t0 = 0;
  private recs = new Map<string, ChunkRec>();
  private visibleN = 0;
  private milestones = new Map<number, number>(); // Nth-visible → ms-since-start
  private gen: Record<GenKind, GenSamples> = {
    chunk: { latency: [], gen: [], wait: [] },
    tile: { latency: [], gen: [], wait: [] },
    column: { latency: [], gen: [], wait: [] },
  };
  /** Stop CREATING new per-chunk records past this (visible counting continues). */
  private cap = 4000;
  private autoReported = new Set<number>();

  private now(): number { return performance.now(); }
  private markStart(): void { if (this.t0 === 0) this.t0 = this.now(); }

  private rec(key: string): ChunkRec | null {
    let r = this.recs.get(key);
    if (!r) {
      if (this.recs.size >= this.cap) return null;
      r = {};
      this.recs.set(key, r);
    }
    return r;
  }

  // ---- Hooks (all no-op when disabled) ----

  /** A terrain request completed on the local worker path. latency = receive − request. */
  onGen(kind: GenKind, latencyMs: number, genMs: number): void {
    if (!this.enabled) return;
    this.markStart();
    const g = this.gen[kind];
    g.latency.push(latencyMs);
    g.gen.push(genMs);
    g.wait.push(Math.max(0, latencyMs - genMs));
  }

  onChunkRequested(key: string): void {
    if (!this.enabled) return;
    this.markStart();
    const r = this.rec(key);
    if (r && r.tRequested === undefined) r.tRequested = this.now();
  }

  onIngestStart(key: string): void {
    if (!this.enabled) return;
    this.markStart();
    const r = this.rec(key);
    if (r && r.tReceived === undefined) r.tReceived = this.now();
  }
  onIngestEnd(key: string): void {
    if (!this.enabled) return;
    const r = this.recs.get(key);
    if (r) r.tIngested = this.now();
  }
  onQueued(key: string): void {
    if (!this.enabled) return;
    const r = this.recs.get(key);
    if (r && r.tQueued === undefined) r.tQueued = this.now();
  }
  onMeshDispatch(key: string): void {
    if (!this.enabled) return;
    const r = this.recs.get(key);
    if (r && r.tMeshDispatch === undefined) r.tMeshDispatch = this.now();
  }
  onMeshApplied(key: string): void {
    if (!this.enabled) return;
    const r = this.recs.get(key);
    if (r) r.tMeshApplied = this.now();
  }
  /** Render gate drew the chunk. First transition only. */
  onVisible(key: string): void {
    if (!this.enabled) return;
    const r = this.recs.get(key);
    if (!r || r.tVisible !== undefined) return;
    r.tVisible = this.now();
    r.visibleOrder = ++this.visibleN;
    const sinceStart = this.t0 ? r.tVisible - this.t0 : 0;
    for (const m of [1, 10, 25, 50, 100]) {
      if (this.visibleN === m) this.milestones.set(m, sinceStart);
    }
    // Auto-log at milestones so a desktop console captures the run without manual poking.
    for (const m of [25, 100]) {
      if (this.visibleN === m && !this.autoReported.has(m)) {
        this.autoReported.add(m);
        // eslint-disable-next-line no-console
        console.log(`[ChunkProfiler] ${m} chunks visible — auto report:`);
        this.report();
      }
    }
  }

  // ---- Reporting ----

  private visibleRecs(): ChunkRec[] {
    const out: ChunkRec[] = [];
    for (const r of this.recs.values()) if (r.tVisible !== undefined) out.push(r);
    return out;
  }

  snapshot(): ProfilerSnapshot {
    const vis = this.visibleRecs();
    const mk = <T,>(f: (k: GenKind) => T) =>
      ({ chunk: f('chunk'), tile: f('tile'), column: f('column') } as Record<GenKind, T>);
    const ingest = stage(vis, 'tReceived', 'tIngested');
    const meshWait = stage(vis, 'tQueued', 'tMeshDispatch');
    const mesh = stage(vis, 'tMeshDispatch', 'tMeshApplied');
    const applied = stage(vis, 'tMeshApplied', 'tVisible');
    const tail = stage(vis, 'tReceived', 'tVisible');
    return {
      startedMs: this.t0 ? r1(this.now() - this.t0) : 0,
      visibleCount: this.visibleN,
      firstVisibleMs: r1(this.milestones.get(1) ?? 0),
      to10Ms: r1(this.milestones.get(10) ?? 0),
      to25Ms: r1(this.milestones.get(25) ?? 0),
      to50Ms: r1(this.milestones.get(50) ?? 0),
      to100Ms: r1(this.milestones.get(100) ?? 0),
      genCounts: mk((k) => this.gen[k].gen.length),
      genP50: mk((k) => r1(pct(this.gen[k].gen, 50))),
      genP95: mk((k) => r1(pct(this.gen[k].gen, 95))),
      waitP50: mk((k) => r1(pct(this.gen[k].wait, 50))),
      waitP95: mk((k) => r1(pct(this.gen[k].wait, 95))),
      genTotalMs: mk((k) => r1(sum(this.gen[k].gen))),
      ingestP50: r1(pct(ingest, 50)), ingestP95: r1(pct(ingest, 95)),
      meshWaitP50: r1(pct(meshWait, 50)), meshWaitP95: r1(pct(meshWait, 95)),
      meshP50: r1(pct(mesh, 50)), meshP95: r1(pct(mesh, 95)),
      appliedToVisibleP50: r1(pct(applied, 50)),
      ingestToVisibleP50: r1(pct(tail, 50)), ingestToVisibleP95: r1(pct(tail, 95)),
    };
  }

  /** Multi-line text summary (panel "Copy report" uses this; report() also prints it). */
  reportText(): string {
    const s = this.snapshot();
    const L: string[] = [];
    L.push(`=== ChunkProfiler — ${s.visibleCount} chunks visible in ${s.startedMs}ms ===`);
    L.push(`time to visible: 1st ${s.firstVisibleMs}  10th ${s.to10Ms}  25th ${s.to25Ms}  50th ${s.to50Ms}  100th ${s.to100Ms} (ms)`);
    L.push('generation (local worker), ms:');
    for (const k of ['column', 'tile', 'chunk'] as GenKind[]) {
      if (s.genCounts[k] === 0) continue;
      L.push(`  ${k.padEnd(6)} n=${String(s.genCounts[k]).padStart(4)}  gen p50 ${s.genP50[k]} p95 ${s.genP95[k]}  poolWait p50 ${s.waitP50[k]} p95 ${s.waitP95[k]}  totalGen ${s.genTotalMs[k]}`);
    }
    L.push('pipeline over visible chunks, ms (p50 / p95):');
    L.push(`  ingest        ${s.ingestP50} / ${s.ingestP95}`);
    L.push(`  mesh-queue wait ${s.meshWaitP50} / ${s.meshWaitP95}`);
    L.push(`  mesh compute  ${s.meshP50} / ${s.meshP95}`);
    L.push(`  applied→visible ${s.appliedToVisibleP50} (p50)`);
    L.push(`  receive→visible ${s.ingestToVisibleP50} / ${s.ingestToVisibleP95}`);
    return L.join('\n');
  }

  /** Print console tables + the text summary. Returns the text (so callers can grab it). */
  report(): string {
    const text = this.reportText();
    const s = this.snapshot();
    // eslint-disable-next-line no-console
    console.log(text);
    const genRows: Record<string, unknown> = {};
    for (const k of ['column', 'tile', 'chunk'] as GenKind[]) {
      if (s.genCounts[k] === 0) continue;
      genRows[k] = { n: s.genCounts[k], genP50: s.genP50[k], genP95: s.genP95[k], waitP50: s.waitP50[k], waitP95: s.waitP95[k], totalGen: s.genTotalMs[k] };
    }
    // eslint-disable-next-line no-console
    if (console.table) console.table(genRows);
    // eslint-disable-next-line no-console
    if (console.table) console.table({
      ingest: { p50: s.ingestP50, p95: s.ingestP95 },
      meshQueueWait: { p50: s.meshWaitP50, p95: s.meshWaitP95 },
      meshCompute: { p50: s.meshP50, p95: s.meshP95 },
      appliedToVisible: { p50: s.appliedToVisibleP50, p95: 0 },
      receiveToVisible: { p50: s.ingestToVisibleP50, p95: s.ingestToVisibleP95 },
    });
    return text;
  }

  reset(): void {
    this.t0 = 0;
    this.recs.clear();
    this.visibleN = 0;
    this.milestones.clear();
    this.autoReported.clear();
    for (const k of ['chunk', 'tile', 'column'] as GenKind[]) {
      this.gen[k] = { latency: [], gen: [], wait: [] };
    }
    // eslint-disable-next-line no-console
    console.log('[ChunkProfiler] reset — timing the next load from now.');
  }
}

/** Singleton — imported by the pipeline hooks and the Load Timing panel. */
export const chunkProfiler = new ChunkProfiler();

// Expose for desktop console use.
if (typeof window !== 'undefined') {
  (window as unknown as { __chunkProfile: ChunkProfiler }).__chunkProfile = chunkProfiler;
}
