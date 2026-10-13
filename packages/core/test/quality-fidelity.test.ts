import { describe, expect, it } from "vitest";
import { DEFAULTS, normalizeOptions, parseConvertOptions } from "../src/config/normalize.js";
import { computeSliceGeometry, expandPageRanges, fidelityDiagnostics, type FidelityReport } from "../src/quality/fidelity.js";
import { PageForgeError } from "../src/errors/index.js";

const htmlInput = { type: "html" as const, html: "<p>x</p>" };

const A4_PAPER = { paperWidthPt: 595.2756, paperHeightPt: 841.8898 };
const NO_MARGINS = { top: 0, right: 0, bottom: 0, left: 0 };
const VIEWPORT_1280 = { width: 1280, height: 720 };

describe("computeSliceGeometry", () => {
  it("maps A4 document mode with zero margins onto the paper width", () => {
    const geometry = computeSliceGeometry({
      ...A4_PAPER,
      marginsPx: NO_MARGINS,
      scale: 1,
      mode: "document",
      viewport: VIEWPORT_1280,
    });
    // 595.2756pt = 793.7008 CSS px → capture width 794, slice height 1122.52 → 1123 rows.
    expect(geometry.captureWidthCss).toBe(794);
    expect(geometry.sliceHeightCss).toBeCloseTo(841.8898 * (4 / 3), 4);
    expect(geometry.captureHeightCss).toBe(1123);
    expect(geometry.rasterWidth).toBe(794);
    expect(geometry.contentBoxPt.x).toBe(0);
    expect(geometry.contentBoxPt.y).toBe(0);
    expect(geometry.contentBoxPt.width).toBeCloseTo(595.2756, 4);
    expect(geometry.contentBoxPt.height).toBeCloseTo(841.8898, 4);
  });

  it("subtracts margins from the content box and slice height", () => {
    const geometry = computeSliceGeometry({
      ...A4_PAPER,
      marginsPx: { top: 96, right: 96, bottom: 96, left: 96 },
      scale: 1,
      mode: "document",
      viewport: VIEWPORT_1280,
    });
    expect(geometry.captureWidthCss).toBe(602); // 793.7 − 192 = 601.7 → 602
    expect(geometry.sliceHeightCss).toBeCloseTo(841.8898 * (4 / 3) - 192, 4);
    expect(geometry.contentBoxPt.x).toBe(72); // 96px × 0.75
    expect(geometry.contentBoxPt.y).toBe(72);
    expect(geometry.contentBoxPt.width).toBeCloseTo((793.7008 - 192) * 0.75, 4);
  });

  it("divides slice height by the effective scale (paper-fit or pdf.scale)", () => {
    const geometry = computeSliceGeometry({
      ...A4_PAPER,
      marginsPx: NO_MARGINS,
      scale: 0.5,
      mode: "document",
      viewport: VIEWPORT_1280,
    });
    expect(geometry.sliceHeightCss).toBeCloseTo(841.8898 * (4 / 3) * 2, 4);
    expect(geometry.captureWidthCss).toBe(1587); // 793.7008 / 0.5 → 1587.4 → 1587
    expect(geometry.rasterWidth).toBe(1587);
  });

  it("keeps the conversion viewport in screen mode", () => {
    const geometry = computeSliceGeometry({
      ...A4_PAPER,
      marginsPx: NO_MARGINS,
      scale: 0.6424,
      mode: "screen",
      viewport: VIEWPORT_1280,
    });
    expect(geometry.captureWidthCss).toBe(1280);
    expect(geometry.captureHeightCss).toBe(720);
    expect(geometry.sliceHeightCss).toBeCloseTo(841.8898 * (4 / 3) / 0.6424, 3);
  });
});

describe("expandPageRanges", () => {
  it("maps every PDF page to itself when no ranges are set", () => {
    expect(expandPageRanges(undefined, 4)).toEqual([1, 2, 3, 4]);
    expect(expandPageRanges(undefined, 1)).toEqual([1]);
  });

  it("expands contiguous and comma-separated ranges in document order", () => {
    expect(expandPageRanges("2-4", 3)).toEqual([2, 3, 4]);
    expect(expandPageRanges("1,3", 2)).toEqual([1, 3]);
    expect(expandPageRanges(" 1 - 2 , 5 ", 3)).toEqual([1, 2, 5]);
    expect(expandPageRanges("3", 1)).toEqual([3]);
  });

  it("returns an empty mapping when Chromium would drop out-of-range pages", () => {
    // A 6-page request on a 4-page document: Chromium silently prints 4 pages,
    // so PDF page n can no longer be located in the document flow.
    expect(expandPageRanges("3-8", 4)).toEqual([]);
  });

  it("returns an empty mapping for page 0 or unparseable input", () => {
    expect(expandPageRanges("0-2", 3)).toEqual([]);
    expect(expandPageRanges("abc", 3)).toEqual([]);
  });
});

function fidelityReport(overrides: Partial<FidelityReport> = {}): FidelityReport {
  return {
    status: "measured",
    score: 0.95,
    threshold: 0.8,
    sampledPages: [1, 2],
    pages: [
      { page: 1, ssim: 0.96, phashDistance: 2, alignmentOffsetPx: 0, alignCorrelation: 0.98 },
      { page: 2, ssim: 0.94, phashDistance: 3, alignmentOffsetPx: -8, alignCorrelation: 0.95 },
    ],
    ...overrides,
  };
}

describe("fidelityDiagnostics", () => {
  it("passes with no warnings when the mean score clears the threshold", () => {
    const { check, warnings } = fidelityDiagnostics(fidelityReport());
    expect(check.id).toBe("render.fidelity");
    expect(check.status).toBe("pass");
    expect(check.detail).toContain("mean SSIM 0.950");
    expect(warnings).toEqual([]);
  });

  it("warns with the low-score code when the mean drops below the threshold", () => {
    const { check, warnings } = fidelityDiagnostics(
      fidelityReport({
        score: 0.7,
        pages: [
          { page: 1, ssim: 0.95, phashDistance: 1, alignmentOffsetPx: 0, alignCorrelation: 0.99 },
          { page: 2, ssim: 0.45, phashDistance: 20, alignmentOffsetPx: 3, alignCorrelation: 0.2 },
        ],
      }),
    );
    expect(check.status).toBe("warn");
    expect(check.recommendation).toBeTruthy();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("fidelity.low-score");
    expect(warnings[0]?.source).toBe("heuristic");
    expect(warnings[0]?.message).toContain("page(s) 2");
    expect(warnings[0]?.message).toContain("not a pixel-perfectness claim");
  });

  it("reports a skipped outcome as a skipped check plus a skip warning", () => {
    const { check, warnings } = fidelityDiagnostics({
      status: "skipped",
      reason: "pdf.displayHeaderFooter adds per-page chrome (header/footer) that screen captures cannot reproduce",
      threshold: 0.8,
      sampledPages: [],
    });
    expect(check.status).toBe("skipped");
    expect(check.detail).toContain("visual comparison did not run");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.code).toBe("fidelity.skipped");
    expect(warnings[0]?.message).toContain("displayHeaderFooter");
  });

  it("lists at most three offending pages in the low-score warning", () => {
    const { warnings } = fidelityDiagnostics(
      fidelityReport({
        score: 0.5,
        pages: [1, 2, 3, 4, 5].map((page) => ({
          page,
          ssim: 0.5,
          phashDistance: 10,
          alignmentOffsetPx: 0,
          alignCorrelation: 0.5,
        })),
      }),
    );
    expect(warnings[0]?.message).toContain("1, 2, 3, … (5 total)");
  });
});

describe("fidelity convert options", () => {
  it("defaults to enabled with 3 sampled pages and threshold 0.8", () => {
    const normalized = normalizeOptions(parseConvertOptions({ input: htmlInput }));
    expect(normalized.fidelity).toEqual({
      enabled: DEFAULTS.fidelityEnabled,
      samplePages: DEFAULTS.fidelitySamplePages,
      threshold: DEFAULTS.fidelityThreshold,
    });
    expect(normalized.fidelity.enabled).toBe(true);
    expect(normalized.fidelity.samplePages).toBe(3);
    expect(normalized.fidelity.threshold).toBe(0.8);
  });

  it("passes explicit fidelity options through normalization", () => {
    const normalized = normalizeOptions(
      parseConvertOptions({
        input: htmlInput,
        fidelity: { enabled: false, samplePages: "all", threshold: 0.9 },
      }),
    );
    expect(normalized.fidelity).toEqual({ enabled: false, samplePages: "all", threshold: 0.9 });
  });

  it("accepts the full documented samplePages range", () => {
    for (const samplePages of [1, 50, "all"] as const) {
      const normalized = normalizeOptions(
        parseConvertOptions({ input: htmlInput, fidelity: { samplePages } }),
      );
      expect(normalized.fidelity.samplePages).toBe(samplePages);
    }
  });

  it("rejects out-of-range values with a typed error", () => {
    for (const fidelity of [
      { samplePages: 0 },
      { samplePages: 51 },
      { samplePages: 2.5 },
      { threshold: -0.1 },
      { threshold: 1.5 },
      { enabled: "yes" },
    ]) {
      let caught: unknown;
      try {
        parseConvertOptions({ input: htmlInput, fidelity });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(PageForgeError);
    }
  });

  it("rejects unknown keys inside fidelity with UNSUPPORTED_OPTION", () => {
    let caught: unknown;
    try {
      parseConvertOptions({ input: htmlInput, fidelity: { pages: 3 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PageForgeError);
    expect((caught as PageForgeError).code).toBe("UNSUPPORTED_OPTION");
    expect((caught as PageForgeError).message).toContain("pages");
  });
});
