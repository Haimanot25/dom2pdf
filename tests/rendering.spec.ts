import { expect, test } from "@playwright/test";
import { createConverter, type Converter } from "../packages/core/dist/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";
import { extractPdfText } from "./helpers/pdf-text.js";
import { getPdfPageSize } from "./helpers/pdf-size.js";

const A4 = { width: 595.28, height: 841.89 }; // points, nominal
const A5 = { width: 419.53, height: 595.28 }; // points, nominal

/**
 * Chromium quantizes paper dimensions slightly (its A4 MediaBox reports
 * ≈595.92pt rather than the nominal 595.28pt), so paper-size assertions allow
 * a small tolerance while still distinguishing A4 from A5 or Letter.
 */
const PAPER_TOLERANCE_PT = 2;
function expectPaperSize(
  size: { width: number; height: number },
  expected: { width: number; height: number },
): void {
  expect(Math.abs(size.width - expected.width)).toBeLessThanOrEqual(PAPER_TOLERANCE_PT);
  expect(Math.abs(size.height - expected.height)).toBeLessThanOrEqual(PAPER_TOLERANCE_PT);
}

let server: FixtureServer;
let converter: Converter;

const simpleHtml = "<!doctype html><html><body><p>screen mode baseline</p></body></html>";

test.beforeAll(async () => {
  server = await startFixtureServer();
  converter = await createConverter();
});

test.afterAll(async () => {
  await converter?.close();
  await server?.close();
});

test.describe("screen mode with paper-fit", () => {
  test("scales the viewport onto A4 and reports the measured scale", async () => {
    const result = await converter.convert({
      input: { type: "html", html: simpleHtml },
      mode: "screen",
      security: { allowLoopback: true },
    });

    expect(result.report.status).toBe("succeeded");
    expect(result.report.mode).toBe("screen");

    const check = result.report.checks.find((entry) => entry.id === "screen.output-policy");
    expect(check?.status).toBe("pass");
    // A4 content width (210mm ≈ 793.7px) over a 1280px viewport ≈ 62%.
    expect(check?.detail).toContain("1280px viewport");
    expect(check?.detail).toContain("62%");
    expect(check?.detail).toContain("A4");

    // Same paper as document mode.
    const size = await getPdfPageSize(result.bytes);
    expectPaperSize(size, A4);
  });

  test("keeps text selectable in screen mode", async () => {
    const result = await converter.convert({
      input: { type: "html", html: simpleHtml },
      mode: "screen",
    });
    const [pageText = ""] = await extractPdfText(result.bytes);
    expect(pageText).toContain("screen mode baseline");
  });

  test("fit scale follows the configured viewport", async () => {
    const narrow = await converter.convert({
      input: { type: "html", html: simpleHtml },
      mode: "screen",
      viewport: { width: 800, height: 600 },
    });
    const check = narrow.report.checks.find((entry) => entry.id === "screen.output-policy");
    // 793.7 / 800 ≈ 99% — nearly the full paper width.
    expect(check?.detail).toContain("800px viewport");
    expect(check?.detail).toContain("99%");
  });

  test("fit scale honors paper format and landscape", async () => {
    const letterLandscape = await converter.convert({
      input: { type: "html", html: simpleHtml },
      mode: "screen",
      pdf: { format: "Letter", landscape: true },
    });
    const size = await getPdfPageSize(letterLandscape.bytes);
    expect(size.width).toBeCloseTo(792, 0); // 11in in points
    expect(size.height).toBeCloseTo(612, 0); // 8.5in in points
    const check = letterLandscape.report.checks.find((entry) => entry.id === "screen.output-policy");
    expect(check?.detail).toContain("Letter (landscape)");
    // Landscape Letter content width (11in = 1056px) over a 1280px viewport = 82.5% → 83%.
    expect(check?.detail).toContain("83%");
  });

  test("reports screen-mode layout hazards as heuristic warnings", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/screen-artifacts.html` },
      mode: "screen",
      security: { allowLoopback: true },
    });

    const codes = result.report.warnings.map((warning) => warning.code);
    expect(codes).toContain("layout.horizontal-overflow");
    expect(codes).toContain("screen.fixed-elements");
    expect(codes).toContain("screen.scrollable-containers");

    const overflow = result.report.warnings.find((w) => w.code === "layout.horizontal-overflow");
    expect(overflow?.source).toBe("heuristic");
    // The message carries the measured overflow (scrollWidth − viewport), which
    // exceeds the 3000px table plus container padding.
    expect(overflow?.message).toMatch(/Content is \d{4}px wider than the 1280px viewport/);

    const fixed = result.report.warnings.find((w) => w.code === "screen.fixed-elements");
    expect(fixed?.source).toBe("heuristic");
    // fixed header + sticky note
    expect(fixed?.message).toContain("2 fixed/sticky");
  });

  test("document mode does not emit screen-mode warnings for the same page", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/screen-artifacts.html` },
      mode: "document",
      security: { allowLoopback: true },
    });
    expect(result.report.mode).toBe("document");
    expect(result.report.warnings).toEqual([]);
    expect(result.report.checks.find((entry) => entry.id === "screen.output-policy")).toBeUndefined();
  });
});

test.describe("output policy enforcement", () => {
  test("rejects reserved policies with UNSUPPORTED_OPTION", async () => {
    for (const type of ["viewport-pages", "full-content"] as const) {
      await expect(
        converter.convert({
          input: { type: "html", html: simpleHtml },
          mode: "screen",
          outputPolicy: { type },
        } as never),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_OPTION" });
    }
  });

  test("rejects outputPolicy in document mode", async () => {
    await expect(
      converter.convert({
        input: { type: "html", html: simpleHtml },
        outputPolicy: { type: "paper-fit" },
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  test("rejects explicit scale in screen mode", async () => {
    await expect(
      converter.convert({
        input: { type: "html", html: simpleHtml },
        mode: "screen",
        pdf: { scale: 1.5 },
      } as never),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

test.describe("document mode pagination and print CSS", () => {
  test("paginates the long fixture across multiple pages", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/long-document.html` },
      security: { allowLoopback: true },
    });
    expect(result.report.pdf.pageCount).toBeGreaterThanOrEqual(5);
    expect(result.report.checks.find((check) => check.id === "pdf-structure")?.status).toBe("pass");
  });

  test("honors pageRanges by emitting only the requested pages", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/long-document.html` },
      security: { allowLoopback: true },
      pdf: { pageRanges: "1-2" },
    });
    expect(result.report.pdf.pageCount).toBe(2);
  });

  test("landscape swaps the paper orientation", async () => {
    const portrait = await converter.convert({
      input: { type: "html", html: simpleHtml },
      pdf: { format: "A4" },
    });
    const portraitSize = await getPdfPageSize(portrait.bytes);
    expectPaperSize(portraitSize, A4);

    const landscape = await converter.convert({
      input: { type: "html", html: simpleHtml },
      pdf: { format: "A4", landscape: true },
    });
    const landscapeSize = await getPdfPageSize(landscape.bytes);
    // Landscape is an exact swap of the measured portrait dimensions.
    expect(Math.abs(landscapeSize.width - portraitSize.height)).toBeLessThanOrEqual(1);
    expect(Math.abs(landscapeSize.height - portraitSize.width)).toBeLessThanOrEqual(1);
    expect(landscapeSize.width).toBeGreaterThan(landscapeSize.height);
  });

  test("preferCSSPageSize lets an author's @page rule win", async () => {
    const defaultPaper = await converter.convert({
      input: { type: "url", url: `${server.origin}/print-rules.html` },
      security: { allowLoopback: true },
    });
    const defaultSize = await getPdfPageSize(defaultPaper.bytes);
    expectPaperSize(defaultSize, A4);

    const cssPaper = await converter.convert({
      input: { type: "url", url: `${server.origin}/print-rules.html` },
      security: { allowLoopback: true },
      pdf: { preferCSSPageSize: true },
    });
    const cssSize = await getPdfPageSize(cssPaper.bytes);
    // @page { size: 148mm 210mm } = A5.
    expectPaperSize(cssSize, A5);

    // Print-only decoration from the fixture proves print media was active.
    const [pageText = ""] = await extractPdfText(cssPaper.bytes);
    expect(pageText).toContain("(print styles applied)");
  });

  test("author print styles apply in document mode (screen-only CSS is media-scoped)", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/print-rules.html` },
      security: { allowLoopback: true },
    });
    const [pageText = ""] = await extractPdfText(result.bytes);
    expect(pageText).toContain("CSS paged media fixture");
    expect(pageText).toContain("(print styles applied)");
  });
});

test.describe("cancellation", () => {
  test("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    await expect(
      converter.convert({
        input: { type: "html", html: simpleHtml },
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("aborts mid-navigation quickly and leaves the converter usable", async () => {
    const controller = new AbortController();
    const slowHtml = `<!doctype html><html><body><img src="${server.origin}/__delay/6000/slow.png" /></body></html>`;

    const started = Date.now();
    const attempt = converter.convert({
      input: { type: "html", html: slowHtml },
      security: { allowLoopback: true },
      readiness: { timeoutMs: 30_000 },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);

    await expect(attempt).rejects.toMatchObject({ code: "CANCELLED" });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3_000);

    // The shared converter still works after the cancellation.
    const recovered = await converter.convert({ input: { type: "html", html: simpleHtml } });
    expect(recovered.report.status).toBe("succeeded");
  });
});
