import { describe, expect, it } from "vitest";
import { computeStats } from "../src/stats.js";

describe("computeStats", () => {
  it("computes min/max/median for an odd-sized sample", () => {
    const stats = computeStats([30, 10, 20]);
    expect(stats).toEqual({ minMs: 10, medianMs: 20, maxMs: 30, p95Ms: 30 });
  });

  it("averages the middle pair for an even-sized sample", () => {
    const stats = computeStats([40, 10, 30, 20]);
    expect(stats.medianMs).toBe(25);
    expect(stats.minMs).toBe(10);
    expect(stats.maxMs).toBe(40);
  });

  it("uses nearest-rank p95 (exact value, no interpolation)", () => {
    // n=20 → ceil(0.95*20)=19 → index 18 in the sorted array.
    const samples = Array.from({ length: 20 }, (_, index) => index + 1);
    expect(computeStats(samples).p95Ms).toBe(19);
    // n=1 → the only sample is every percentile.
    expect(computeStats([7]).p95Ms).toBe(7);
    expect(computeStats([7]).medianMs).toBe(7);
  });

  it("rejects an empty sample instead of returning zeros", () => {
    expect(() => computeStats([])).toThrow(RangeError);
  });
});
