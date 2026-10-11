import { describe, expect, it } from "vitest";
import { computePaperFit, lengthToPx } from "../src/capture/paper.js";
import type { NormalizedPdfOptions, NormalizedViewport } from "../src/config/normalize.js";
import { PageForgeError } from "../src/errors/index.js";

const MM_TO_PX = 96 / 25.4;

function pdfOptions(overrides: Partial<NormalizedPdfOptions> = {}): NormalizedPdfOptions {
  return {
    format: "A4",
    width: undefined,
    height: undefined,
    margin: undefined,
    landscape: false,
    scale: 1,
    printBackground: true,
    preferCSSPageSize: false,
    pageRanges: undefined,
    displayHeaderFooter: false,
    headerTemplate: undefined,
    footerTemplate: undefined,
    outline: false,
    tagged: false,
    ...overrides,
  };
}

const VIEWPORT_1280: NormalizedViewport = { width: 1280, height: 720 };

describe("lengthToPx", () => {
  it("converts supported units to CSS pixels", () => {
    expect(lengthToPx(100)).toBe(100);
    expect(lengthToPx("100px")).toBe(100);
    expect(lengthToPx("100")).toBe(100);
    expect(lengthToPx("1in")).toBe(96);
    expect(lengthToPx("8.5in")).toBe(816);
    expect(lengthToPx("25.4mm")).toBeCloseTo(96, 5);
    expect(lengthToPx("2.54cm")).toBeCloseTo(96, 5);
    expect(lengthToPx(" 10 mm ")).toBeCloseTo(10 * MM_TO_PX, 5);
  });

  it("rejects unsupported length strings with INVALID_INPUT", () => {
    for (const bad of ["abc", "10em", "-5px", "10pt", "10%"]) {
      try {
        lengthToPx(bad);
        throw new Error(`expected lengthToPx("${bad}") to throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(PageForgeError);
        expect((error as PageForgeError).code).toBe("INVALID_INPUT");
      }
    }
  });
});

describe("computePaperFit", () => {
  it("scales a 1280px viewport onto A4 content width", () => {
    const fit = computePaperFit(pdfOptions(), VIEWPORT_1280);
    const a4WidthPx = 210 * MM_TO_PX; // ≈ 793.7px
    expect(fit.paperLabel).toBe("A4");
    expect(fit.paperWidthPx).toBeCloseTo(a4WidthPx, 3);
    expect(fit.contentWidthPx).toBeCloseTo(a4WidthPx, 3);
    expect(fit.scale).toBeCloseTo(a4WidthPx / 1280, 5);
    expect(fit.scale).toBeGreaterThan(0.6);
    expect(fit.scale).toBeLessThan(0.63);
  });

  it("subtracts horizontal margins from the content width", () => {
    const noMargins = computePaperFit(pdfOptions(), VIEWPORT_1280);
    const withMargins = computePaperFit(
      pdfOptions({ margin: { left: "20mm", right: "10mm" } }),
      VIEWPORT_1280,
    );
    expect(withMargins.contentWidthPx).toBeCloseTo(noMargins.contentWidthPx - 30 * MM_TO_PX, 3);
    expect(withMargins.scale).toBeLessThan(noMargins.scale);
  });

  it("never upscales content narrower than the paper", () => {
    const fit = computePaperFit(pdfOptions(), { width: 400, height: 300 });
    expect(fit.scale).toBe(1);
  });

  it("swaps paper dimensions for landscape", () => {
    const portrait = computePaperFit(pdfOptions(), VIEWPORT_1280);
    const landscape = computePaperFit(pdfOptions({ landscape: true }), VIEWPORT_1280);
    expect(landscape.paperLabel).toContain("landscape");
    expect(landscape.paperWidthPx).toBeCloseTo(portrait.paperHeightPx, 3);
    expect(landscape.paperHeightPx).toBeCloseTo(portrait.paperWidthPx, 3);
    // A wider paper means a larger fit scale for the same viewport.
    expect(landscape.scale).toBeGreaterThan(portrait.scale);
  });

  it("uses explicit paper dimensions instead of the format", () => {
    const fit = computePaperFit(pdfOptions({ format: undefined, width: "100mm", height: "150mm" }), {
      width: 800,
      height: 600,
    });
    expect(fit.scale).toBeCloseTo((100 * MM_TO_PX) / 800, 5);
    expect(fit.paperLabel).toContain("px");
    // …and never upscales when the viewport is narrower than that paper.
    const narrow = computePaperFit(pdfOptions({ format: undefined, width: "100mm", height: "150mm" }), {
      width: 200,
      height: 200,
    });
    expect(narrow.scale).toBe(1);
  });

  it("handles pixel and inch paper widths", () => {
    const px = computePaperFit(pdfOptions({ format: undefined, width: 640, height: 800 }), VIEWPORT_1280);
    expect(px.scale).toBeCloseTo(640 / 1280, 5);

    const inches = computePaperFit(pdfOptions({ format: "Letter" }), VIEWPORT_1280);
    expect(inches.scale).toBeCloseTo((8.5 * 96) / 1280, 5);
    expect(inches.paperLabel).toBe("Letter");
  });

  it("falls back to Letter width when only height is provided", () => {
    const fit = computePaperFit(pdfOptions({ format: undefined, height: "100mm" }), VIEWPORT_1280);
    expect(fit.scale).toBeCloseTo((8.5 * 96) / 1280, 5);
  });

  it("clamps degenerate viewports into the supported 0.1–2 range", () => {
    const fit = computePaperFit(pdfOptions(), { width: 1, height: 1 });
    expect(fit.scale).toBe(1); // capped at 1: never upscale
    const huge = computePaperFit(pdfOptions({ format: undefined, width: 10_000, height: 10_000 }), {
      width: 100_000,
      height: 100,
    });
    expect(huge.scale).toBeGreaterThanOrEqual(0.1);
  });
});
