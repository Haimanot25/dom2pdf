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
    networkUnsettled: false,
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
    truncationReason: null,
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
        truncationReason: null,
        hiddenBeforeSweep: 16,
        hiddenAfterSweep: 1,
      }),
    );
    expect(detail).toContain(
      "lazy sweep 7 steps, 15 large block(s) became visible, 1 large element(s) still hidden",
    );
  });

  it("marks a step-limit truncation and keeps the residual count", () => {
    const detail = describeReadiness(
      result({
        performed: true,
        steps: 30,
        truncated: true,
        truncationReason: "step-limit",
        hiddenBeforeSweep: 4,
        hiddenAfterSweep: 4,
      }),
    );
    expect(detail).toContain(
      "lazy sweep 30 steps (truncated: step limit), 4 large element(s) still hidden",
    );
    expect(detail).not.toContain("became visible");
  });

  it("names a time-budget truncation so the reservation is visible", () => {
    const detail = describeReadiness(
      result({
        performed: true,
        steps: 4,
        truncated: true,
        truncationReason: "time-budget",
        hiddenBeforeSweep: 9,
        hiddenAfterSweep: 3,
      }),
    );
    expect(detail).toContain(
      "lazy sweep 4 steps (truncated: time budget), 6 large block(s) became visible",
    );
  });

  it("stays plain when the sweep revealed nothing and left nothing hidden", () => {
    const detail = describeReadiness(
      result({
        performed: true,
        steps: 5,
        truncated: false,
        truncationReason: null,
        hiddenBeforeSweep: 0,
        hiddenAfterSweep: 0,
      }),
    );
    expect(detail).toContain("lazy sweep 5 steps, fonts settled, network idle 300ms");
  });

  it("names the quiet window that never arrived when the network is unsettled", () => {
    const detail = describeReadiness({ ...result(idleLazy), networkUnsettled: true });
    expect(detail).toBe("ready in 4321ms: fonts settled, network unsettled (no 300ms quiet)");
    // Deliberate degradation, not a pass — the check status is decided by
    // the converter; the detail must state the fact either way.
    expect(detail).not.toContain("network idle");
  });
});
