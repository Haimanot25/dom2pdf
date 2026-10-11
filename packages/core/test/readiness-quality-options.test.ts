import { describe, expect, it } from "vitest";
import { normalizeOptions, parseConvertOptions } from "../src/config/normalize.js";
import { PageForgeError } from "../src/errors/index.js";

const htmlInput = { type: "html" as const, html: "<p>x</p>" };

function expectCode(fn: () => unknown, code: string): PageForgeError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PageForgeError);
  const error = caught as PageForgeError;
  expect(error.code).toBe(code);
  return error;
}

describe("readiness options", () => {
  it("applies documented defaults", () => {
    const { readiness } = normalizeOptions({ input: htmlInput });
    expect(readiness).toEqual({
      timeoutMs: 30_000,
      fonts: true,
      waitForFonts: [],
      images: true,
      networkIdleMs: 300,
      selector: undefined,
      settleMs: 0,
    });
  });

  it("passes explicit readiness checks through", () => {
    const { readiness } = normalizeOptions({
      input: htmlInput,
      readiness: {
        timeoutMs: 5_000,
        fonts: false,
        waitForFonts: ["Inter", "JetBrains Mono"],
        images: false,
        networkIdleMs: 0,
        selector: "#app",
        settleMs: 1_000,
      },
    });
    expect(readiness).toEqual({
      timeoutMs: 5_000,
      fonts: false,
      waitForFonts: ["Inter", "JetBrains Mono"],
      images: false,
      networkIdleMs: 0,
      selector: "#app",
      settleMs: 1_000,
    });
  });

  it("rejects unknown readiness keys with UNSUPPORTED_OPTION", () => {
    const error = expectCode(
      () => parseConvertOptions({ input: htmlInput, readiness: { waitUntil: "networkidle" } }),
      "UNSUPPORTED_OPTION",
    );
    expect(error.message).toContain("waitUntil");
  });

  it("rejects out-of-range values with INVALID_INPUT", () => {
    expectCode(
      () => parseConvertOptions({ input: htmlInput, readiness: { networkIdleMs: -1 } }),
      "INVALID_INPUT",
    );
    expectCode(
      () => parseConvertOptions({ input: htmlInput, readiness: { settleMs: 60_001 } }),
      "INVALID_INPUT",
    );
    expectCode(() => parseConvertOptions({ input: htmlInput, readiness: { selector: "" } }), "INVALID_INPUT");
    expectCode(() => parseConvertOptions({ input: htmlInput, readiness: { timeoutMs: 0 } }), "INVALID_INPUT");
    expectCode(
      () => parseConvertOptions({ input: htmlInput, readiness: { waitForFonts: [""] } }),
      "INVALID_INPUT",
    );
  });
});

describe("quality policy options", () => {
  it("defaults to no constraints (report is still produced)", () => {
    const { quality } = normalizeOptions({ input: htmlInput });
    expect(quality).toEqual({
      minTextChars: undefined,
      minPages: undefined,
      maxPages: undefined,
      maxBytes: undefined,
      failOnWarnings: false,
    });
  });

  it("passes explicit policy rules through", () => {
    const { quality } = normalizeOptions({
      input: htmlInput,
      quality: { minTextChars: 100, minPages: 1, maxPages: 5, maxBytes: 1_000_000, failOnWarnings: true },
    });
    expect(quality).toEqual({
      minTextChars: 100,
      minPages: 1,
      maxPages: 5,
      maxBytes: 1_000_000,
      failOnWarnings: true,
    });
  });

  it("rejects an inverted page range with INVALID_INPUT", () => {
    const error = expectCode(
      () => parseConvertOptions({ input: htmlInput, quality: { minPages: 10, maxPages: 5 } }),
      "INVALID_INPUT",
    );
    expect(error.message).toContain("minPages");
    expect(error.message).toContain("maxPages");
  });

  it("rejects unknown quality keys and bad types", () => {
    expectCode(
      () => parseConvertOptions({ input: htmlInput, quality: { minPages: 0 } }),
      "INVALID_INPUT",
    );
    expectCode(
      () => parseConvertOptions({ input: htmlInput, quality: { requireText: true } }),
      "UNSUPPORTED_OPTION",
    );
  });
});
