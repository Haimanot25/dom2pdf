import { describe, expect, it } from "vitest";
import { createConverter } from "../src/api/converter.js";
import { DEFAULTS, normalizeOptions, parseConvertOptions } from "../src/config/normalize.js";
import { PageForgeError } from "../src/errors/index.js";

const htmlInput = { type: "html" as const, html: "<p>x</p>" };

function expectThrows(fn: () => unknown): PageForgeError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PageForgeError);
  return caught as PageForgeError;
}

describe("limits convert options", () => {
  it("defaults maxRequests to the documented 500 and leaves maxOutputBytes unset", () => {
    const normalized = normalizeOptions(parseConvertOptions({ input: htmlInput }));
    expect(normalized.limits.maxRequests).toBe(500);
    expect(normalized.limits.maxRequests).toBe(DEFAULTS.limitsMaxRequests);
    expect(normalized.limits.maxOutputBytes).toBeUndefined();
  });

  it("passes explicit limits through normalization", () => {
    const normalized = normalizeOptions(
      parseConvertOptions({ input: htmlInput, limits: { maxRequests: 5, maxOutputBytes: 1024 } }),
    );
    expect(normalized.limits).toEqual({ maxRequests: 5, maxOutputBytes: 1024 });
  });

  it("rejects out-of-range and non-integer limits with a typed error", () => {
    for (const limits of [
      { maxRequests: 0 },
      { maxRequests: 1.5 },
      { maxRequests: 1_000_001 },
      { maxOutputBytes: 0 },
      { maxOutputBytes: -5 },
    ]) {
      expectThrows(() => parseConvertOptions({ input: htmlInput, limits }));
    }
  });

  it("rejects unknown keys inside limits with UNSUPPORTED_OPTION", () => {
    const error = expectThrows(() =>
      parseConvertOptions({ input: htmlInput, limits: { maxConcurrentConversions: 2 } }),
    );
    expect(error.code).toBe("UNSUPPORTED_OPTION");
    expect(error.message).toContain("maxConcurrentConversions");
  });
});

describe("createConverter concurrency validation", () => {
  it("rejects maxConcurrentConversions below 1 or non-integer with INVALID_INPUT", async () => {
    for (const value of [0, -3, 1.5]) {
      const caught = await createConverter({ limits: { maxConcurrentConversions: value } }).catch(
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(PageForgeError);
      expect((caught as PageForgeError).code).toBe("INVALID_INPUT");
    }
  });

  it("creates a converter for a valid value (Chromium launches lazily, so close is immediate)", async () => {
    const converter = await createConverter({ limits: { maxConcurrentConversions: 2 } });
    await converter.close();
  });
});
