/**
 * Monotone cubic (Fritsch–Carlson) spline over control points, evaluated on a normalized input.
 *
 * Used by the landform LandLayer to map the continental noise value (0..1) to an absolute terrain
 * height. It replaces the old hand-tuned `elevationCurve` step function: control points are data
 * (editable in the world-config panel), and the monotone construction guarantees no overshoot
 * wiggles between points — so a soft shelf→beach transition no longer needs a hardcoded ramp.
 *
 * Points are (x, y) with x strictly increasing in [0,1]. Tangents are precomputed once on
 * construction; `eval(x)` is a cheap segment lookup + Hermite evaluation (no noise, no allocation).
 */
export interface CurvePoint {
  /** Input position, 0..1 (must be strictly increasing across the point list). */
  x: number;
  /** Output value (here: terrain height in voxels, pre vertical-scale). */
  y: number;
}

export class Curve {
  private readonly xs: Float64Array;
  private readonly ys: Float64Array;
  private readonly ms: Float64Array;   // tangent (slope) at each point

  constructor(points: ReadonlyArray<CurvePoint>) {
    // Defensive: sort + dedupe so a malformed config can't produce a non-monotone x axis.
    const pts = [...points].sort((a, b) => a.x - b.x).filter((p, i, a) => i === 0 || p.x !== a[i - 1].x);
    const n = Math.max(2, pts.length);
    this.xs = new Float64Array(n);
    this.ys = new Float64Array(n);
    this.ms = new Float64Array(n);
    if (pts.length < 2) {
      // Degenerate: flat line at the single (or default) value.
      const y = pts.length === 1 ? pts[0].y : 0;
      this.xs[0] = 0; this.ys[0] = y; this.xs[1] = 1; this.ys[1] = y;
    } else {
      for (let i = 0; i < pts.length; i++) { this.xs[i] = pts[i].x; this.ys[i] = pts[i].y; }
    }
    this.computeTangents();
  }

  /** Fritsch–Carlson monotone tangents: prevents overshoot between control points. */
  private computeTangents(): void {
    const { xs, ys, ms } = this;
    const n = xs.length;
    const d = new Float64Array(n - 1);          // secant slopes
    for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
    ms[0] = d[0];
    ms[n - 1] = d[n - 2];
    for (let i = 1; i < n - 1; i++) {
      if (d[i - 1] * d[i] <= 0) ms[i] = 0;      // local extremum → flat tangent (no overshoot)
      else ms[i] = (d[i - 1] + d[i]) / 2;
    }
    // Clamp tangents to keep the interpolant monotone (Fritsch–Carlson).
    for (let i = 0; i < n - 1; i++) {
      if (d[i] === 0) { ms[i] = 0; ms[i + 1] = 0; continue; }
      const a = ms[i] / d[i], b = ms[i + 1] / d[i];
      const s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        ms[i] = tau * a * d[i];
        ms[i + 1] = tau * b * d[i];
      }
    }
  }

  /** Evaluate the curve at x (clamped to the control-point domain). */
  eval(x: number): number {
    const { xs, ys, ms } = this;
    const n = xs.length;
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    // Binary search for the segment [xs[i], xs[i+1]] containing x.
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= x) lo = mid; else hi = mid;
    }
    const h = xs[lo + 1] - xs[lo];
    const t = (x - xs[lo]) / h;
    const t2 = t * t, t3 = t2 * t;
    // Cubic Hermite basis.
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    return h00 * ys[lo] + h10 * h * ms[lo] + h01 * ys[lo + 1] + h11 * h * ms[lo + 1];
  }
}
