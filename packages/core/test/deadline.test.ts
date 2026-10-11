import { describe, expect, it } from "vitest";
import { PageForgeError } from "../src/errors/index.js";
import { Deadline } from "../src/utils/deadline.js";

describe("Deadline", () => {
  it("does not expire immediately for positive durations", () => {
    const deadline = Deadline.in(5_000);
    expect(deadline.expired).toBe(false);
    expect(deadline.remainingMs()).toBeGreaterThan(4_000);
    expect(deadline.remainingMs()).toBeLessThanOrEqual(5_000);
  });

  it("clamps requested timeouts to remaining time", () => {
    const deadline = Deadline.in(1_000);
    expect(deadline.clamp(5_000)).toBeLessThanOrEqual(1_000);
    expect(deadline.clamp(10)).toBe(10);
  });

  it("expires at zero and throws with the provided code", () => {
    const deadline = Deadline.at(Date.now() - 1);
    expect(deadline.expired).toBe(true);
    expect(deadline.remainingMs()).toBe(0);
    expect(() => deadline.throwIfExpired("READINESS_TIMEOUT", "gone")).toThrowError(PageForgeError);
    try {
      deadline.throwIfExpired("RENDER_TIMEOUT", "gone too");
    } catch (error) {
      expect((error as PageForgeError).code).toBe("RENDER_TIMEOUT");
    }
  });

  it("rejects invalid durations", () => {
    expect(() => Deadline.in(-1)).toThrowError(PageForgeError);
    expect(() => Deadline.in(Number.NaN)).toThrowError(PageForgeError);
    expect(() => Deadline.at(Number.POSITIVE_INFINITY)).toThrowError(PageForgeError);
  });

  it("does not throw when not expired", () => {
    expect(() => Deadline.in(1_000).throwIfExpired("CANCELLED", "nope")).not.toThrow();
  });
});
