import { describe, expect, it } from "vitest";
import {
  describeReadiness,
  type ImageState,
  type LazySweepState,
  type ReadinessResult,
} from "../src/readiness/wait.js";

const noImages: ImageState = {
  total: 0,
  loaded: 0,
  pending: 0,
  pendingUrls: [],
  brokenUrls: [],
  slowUrls: [],
};

function result(lazy: LazySweepState): ReadinessResult {
  return {
    durationMs: 4321,
    fontsAwaited: true,
    images: noImages,
    lazy,
    unavailableFonts: [],
    networkIdleMs: 300,
    selector: undefined,
    settledMs: 0,
    stalledUrls: [],
  };
}

describe("describeReadiness", () => {
  const idleLazy: LazySweepState = {
    performed: false,
    steps: 0,
    truncated: false,
    hiddenBeforeSweep: 0,
    hiddenAfterSweep: 0,
  };

  it("describes only what ran: no sweep part on pages that paid no sweep", () => {
    const detail = describeReadiness(result(idleLazy));
    expect(detail).toBe("ready in 4321ms: fonts settled, network idle 300ms");
    expect(detail).not.toContain("lazy sweep");
  });

  it("reports the revealed and still-hidden large-block counts around the sweep", () => {
    const detail = describeReadiness(
      result({
        performed: true,
        steps: 7,
        truncated: false,
        hiddenBeforeSweep: 16,
        hiddenAfterSweep: 1,
      }),
    );
    expect(detail).toContain(
      "lazy sweep 7 steps, 15 large block(s) became visible, 1 large element(s) still hidden",
    );
  });

  it("marks a truncated sweep and keeps the residual count", () => {
    const detail = describeReadiness(
      result({
        performed: true,
        steps: 30,
        truncated: true,
        hiddenBeforeSweep: 4,
        hiddenAfterSweep: 4,
      }),
    );
    expect(detail).toContain(
      "lazy sweep 30 steps (truncated), 4 large element(s) still hidden",
    );
    expect(detail).not.toContain("became visible");
  });

  it("stays plain when the sweep revealed nothing and left nothing hidden", () => {
    const detail = describeReadiness(
      result({
        performed: true,
        steps: 5,
        truncated: false,
        hiddenBeforeSweep: 0,
        hiddenAfterSweep: 0,
      }),
    );
    expect(detail).toContain("lazy sweep 5 steps, fonts settled, network idle 300ms");
  });
});
