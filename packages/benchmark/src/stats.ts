/**
 * Timing statistics for benchmark samples.
 *
 * `p95` uses the nearest-rank method (the value at `ceil(0.95 · n)` in the
 * sorted sample), which is exact for the small sample sizes benchmarks run
 * with — no interpolation pretending to more precision than was measured.
 */
export interface TimingStats {
  minMs: number;
  medianMs: number;
  maxMs: number;
  p95Ms: number;
}

export function computeStats(samples: readonly number[]): TimingStats {
  if (samples.length === 0) {
    throw new RangeError("computeStats requires at least one sample");
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    minMs: sorted[0] as number,
    medianMs,
    maxMs: sorted[sorted.length - 1] as number,
    p95Ms: sorted[p95Index] as number,
  };
}
