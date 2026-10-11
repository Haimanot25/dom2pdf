import { describe, expect, it } from "vitest";
import { normalizeOptions, parseConvertOptions, DEFAULTS } from "../src/config/normalize.js";
import { PageForgeError } from "../src/errors/index.js";

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

const htmlInput = { type: "html" as const, html: "<p>x</p>" };

describe("parseConvertOptions", () => {
  it("accepts a minimal valid request", () => {
    const parsed = parseConvertOptions({ input: htmlInput });
    expect(parsed.input).toEqual(htmlInput);
  });

  it("rejects unknown top-level options with UNSUPPORTED_OPTION", () => {
    const error = expectCode(() => parseConvertOptions({ input: htmlInput, mode2: "x" }), "UNSUPPORTED_OPTION");
    expect(error.message).toContain("mode2");
  });

  it("rejects unknown nested options with UNSUPPORTED_OPTION", () => {
    const error = expectCode(
      () => parseConvertOptions({ input: htmlInput, pdf: { papersize: "A4" } }),
      "UNSUPPORTED_OPTION",
    );
    expect(error.message).toContain("papersize");
  });

  it("rejects a missing input with INVALID_INPUT", () => {
    expectCode(() => parseConvertOptions({}), "INVALID_INPUT");
  });

  it("rejects unknown input types with INVALID_INPUT", () => {
    expectCode(() => parseConvertOptions({ input: { type: "stdin" } }), "INVALID_INPUT");
  });

  it("accepts mode 'screen' (screen behavior is covered in config-screen-options.test.ts)", () => {
    const parsed = parseConvertOptions({ input: htmlInput, mode: "screen" });
    expect(parsed.mode).toBe("screen");
  });

  it("rejects pdf.format combined with explicit width/height", () => {
    expectCode(
      () => parseConvertOptions({ input: htmlInput, pdf: { format: "A4", width: "200mm" } }),
      "INVALID_INPUT",
    );
  });

  it("allows explicit width/height without format", () => {
    const parsed = parseConvertOptions({ input: htmlInput, pdf: { width: "200mm", height: "100mm" } });
    expect(parsed.pdf?.format).toBeUndefined();
    expect(parsed.pdf?.width).toBe("200mm");
  });

  it("rejects out-of-range scale", () => {
    expectCode(() => parseConvertOptions({ input: htmlInput, pdf: { scale: 3 } }), "INVALID_INPUT");
    expectCode(() => parseConvertOptions({ input: htmlInput, pdf: { scale: 0.05 } }), "INVALID_INPUT");
  });

  it("rejects malformed pageRanges", () => {
    expectCode(() => parseConvertOptions({ input: htmlInput, pdf: { pageRanges: "1-5, x" } }), "INVALID_INPUT");
    expect(() => parseConvertOptions({ input: htmlInput, pdf: { pageRanges: "1-5, 8, 11-13" } })).not.toThrow();
  });

  it("requires displayHeaderFooter for header/footer templates", () => {
    expectCode(
      () => parseConvertOptions({ input: htmlInput, pdf: { headerTemplate: "<div>x</div>" } }),
      "INVALID_INPUT",
    );
    expect(
      parseConvertOptions({ input: htmlInput, pdf: { displayHeaderFooter: true, headerTemplate: "<div>x</div>" } })
        .pdf?.headerTemplate,
    ).toBe("<div>x</div>");
  });

  it("rejects absurd readiness timeouts", () => {
    expectCode(
      () => parseConvertOptions({ input: htmlInput, readiness: { timeoutMs: 60 * 60_000 } }),
      "INVALID_INPUT",
    );
  });
});

describe("normalizeOptions", () => {
  it("applies documented defaults", () => {
    const normalized = normalizeOptions({ input: htmlInput });
    expect(normalized.mode).toBe("document");
    expect(normalized.viewport).toEqual(DEFAULTS.viewport);
    expect(normalized.pdf.format).toBe("A4");
    expect(normalized.pdf.scale).toBe(1);
    expect(normalized.pdf.printBackground).toBe(true);
    expect(normalized.pdf.landscape).toBe(false);
    expect(normalized.pdf.preferCSSPageSize).toBe(false);
    expect(normalized.readiness.timeoutMs).toBe(30_000);
    expect(normalized.render.timeoutMs).toBe(30_000);
    expect(normalized.security).toEqual({
      allowLocalFiles: false,
      allowedLocalDirectories: [],
      allowLoopback: false,
      allowPrivateNetwork: false,
    });
  });

  it("keeps format undefined when explicit paper dimensions are provided", () => {
    const normalized = normalizeOptions({ input: htmlInput, pdf: { width: 500, height: 700 } });
    expect(normalized.pdf.format).toBeUndefined();
    expect(normalized.pdf.width).toBe(500);
    expect(normalized.pdf.height).toBe(700);
  });

  it("applies explicit values over defaults", () => {
    const normalized = normalizeOptions({
      input: { type: "url", url: "https://example.com" },
      viewport: { width: 800, height: 600 },
      pdf: { format: "Letter", landscape: true, printBackground: false },
      readiness: { timeoutMs: 5_000 },
      render: { timeoutMs: 7_000 },
      security: { allowLoopback: true },
    });
    expect(normalized.viewport).toEqual({ width: 800, height: 600 });
    expect(normalized.pdf.format).toBe("Letter");
    expect(normalized.pdf.landscape).toBe(true);
    expect(normalized.pdf.printBackground).toBe(false);
    expect(normalized.readiness.timeoutMs).toBe(5_000);
    expect(normalized.render.timeoutMs).toBe(7_000);
    expect(normalized.security.allowLoopback).toBe(true);
    expect(normalized.security.allowPrivateNetwork).toBe(false);
  });

  it("does not mutate caller-provided objects across runs", () => {
    const options = { input: htmlInput, pdf: { format: "A5" as const } };
    const first = normalizeOptions(options);
    const second = normalizeOptions(options);
    expect(first.pdf).toEqual(second.pdf);
    expect(options.pdf.format).toBe("A5");
  });
});
