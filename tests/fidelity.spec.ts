import { expect, test } from "@playwright/test";
import { createConverter, type Converter, type FidelityReport, type QualityReport } from "../packages/core/dist/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

let server: FixtureServer;
let converter: Converter;

test.beforeAll(async () => {
  server = await startFixtureServer();
  converter = await createConverter();
});

test.afterAll(async () => {
  await converter?.close();
  await server?.close();
});

function fidelityOf(report: QualityReport): FidelityReport {
  const fidelity = report.fidelity;
  expect(fidelity, "expected the report to carry a fidelity outcome").toBeDefined();
  return fidelity as FidelityReport;
}

test.describe("render-fidelity verification", () => {
  test("measures a healthy multi-page document above the default threshold", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/fidelity-healthy.html` },
      security: { allowLoopback: true },
    });

    const fidelity = fidelityOf(result.report);
    expect(fidelity.status).toBe("measured");
    expect(fidelity.score).toBeGreaterThanOrEqual(fidelity.threshold);
    expect(fidelity.threshold).toBe(0.8); // documented default
    expect(fidelity.sampledPages.length).toBeGreaterThanOrEqual(2);
    expect(fidelity.pages).toHaveLength(fidelity.sampledPages.length);
    expect(fidelity.durationMs ?? 0).toBeGreaterThan(0);
    expect(fidelity.reason).toBeUndefined();

    for (const page of fidelity.pages ?? []) {
      expect(page.ssim).toBeGreaterThanOrEqual(0);
      expect(page.ssim).toBeLessThanOrEqual(1);
      expect(page.phashDistance).toBeGreaterThanOrEqual(0);
      expect(page.phashDistance).toBeLessThanOrEqual(64);
      // Alignment searches within the 128px margin around the nominal boundary.
      expect(Math.abs(page.alignmentOffsetPx)).toBeLessThanOrEqual(128);
      expect(page.alignCorrelation).toBeGreaterThan(0);
    }

    const check = result.report.checks.find((entry) => entry.id === "render.fidelity");
    expect(check?.status).toBe("pass");
    expect(result.report.warnings.some((warning) => warning.code === "fidelity.low-score")).toBe(false);
  });

  test("flags a print-vs-screen divergence with a lower score than the healthy page", async () => {
    // Both conversions verify only the first page — the page the sabotage
    // variant breaks — so the comparison targets the known divergence.
    const healthy = fidelityOf(
      (
        await converter.convert({
          input: { type: "url", url: `${server.origin}/fidelity-healthy.html` },
          security: { allowLoopback: true },
          fidelity: { samplePages: 1 },
        })
      ).report,
    );
    const sabotage = fidelityOf(
      (
        await converter.convert({
          input: { type: "url", url: `${server.origin}/fidelity-sabotage.html` },
          security: { allowLoopback: true },
          fidelity: { samplePages: 1 },
        })
      ).report,
    );

    expect(sabotage.status).toBe("measured");
    // Relative assertions only: the sabotage page moves a whole block in print,
    // so its first page must score clearly below the healthy first page.
    const healthyFirst = healthy.pages?.[0]?.ssim ?? 1;
    const sabotageFirst = sabotage.pages?.[0]?.ssim ?? 1;
    expect(sabotageFirst).toBeLessThan(healthyFirst - 0.1);
    expect(sabotage.score ?? 1).toBeLessThan((healthy.score ?? 1) - 0.1);
    // The default threshold is meant to catch exactly this divergence.
    expect(sabotage.score ?? 1).toBeLessThan(sabotage.threshold);
  });

  test("omits the fidelity field entirely when disabled", async () => {
    const result = await converter.convert({
      input: { type: "html", html: "<p>disabled fidelity</p>" },
      fidelity: { enabled: false },
    });
    expect(result.report.fidelity).toBeUndefined();
    expect(result.report.checks.some((check) => check.id === "render.fidelity")).toBe(false);
  });

  test("skips with a reason when header/footer templates are displayed", async () => {
    const result = await converter.convert({
      input: { type: "html", html: "<p>header footer page</p>" },
      pdf: { displayHeaderFooter: true, headerTemplate: "<span>hdr</span>", footerTemplate: "<span>ftr</span>" },
    });

    const fidelity = fidelityOf(result.report);
    expect(fidelity.status).toBe("skipped");
    expect(fidelity.reason).toContain("displayHeaderFooter");
    expect(fidelity.score).toBeUndefined();
    expect(fidelity.sampledPages).toEqual([]);
    const check = result.report.checks.find((entry) => entry.id === "render.fidelity");
    expect(check?.status).toBe("skipped");
    expect(result.report.warnings.some((warning) => warning.code === "fidelity.skipped")).toBe(true);
  });

  test("skips with a reason when pageRanges cannot be mapped onto the document flow", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/fidelity-healthy.html` },
      security: { allowLoopback: true },
      pdf: { pageRanges: "2-99" }, // Chromium silently drops the out-of-range tail
      fidelity: { samplePages: "all" },
    });

    const fidelity = fidelityOf(result.report);
    expect(fidelity.status).toBe("skipped");
    expect(fidelity.reason).toContain("pageRanges");
  });

  test("verifies the document page behind a pageRanges window", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/fidelity-healthy.html` },
      security: { allowLoopback: true },
      pdf: { pageRanges: "2" },
    });

    const fidelity = fidelityOf(result.report);
    expect(fidelity.status).toBe("measured");
    expect(fidelity.sampledPages).toEqual([1]); // PDF page 1 = document page 2
  });

  test("measures screen-mode output against the screen layout", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/fidelity-healthy.html` },
      security: { allowLoopback: true },
      mode: "screen",
    });

    const fidelity = fidelityOf(result.report);
    expect(fidelity.status).toBe("measured");
    expect(fidelity.score).toBeGreaterThanOrEqual(fidelity.threshold);
  });

  test("honors samplePages: first N pages only", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/fidelity-healthy.html` },
      security: { allowLoopback: true },
      fidelity: { samplePages: 1 },
    });

    const fidelity = fidelityOf(result.report);
    expect(fidelity.status).toBe("measured");
    expect(fidelity.sampledPages).toEqual([1]);
    expect(fidelity.pages).toHaveLength(1);
  });

  test("warns below an intentionally impossible threshold", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/fidelity-sabotage.html` },
      security: { allowLoopback: true },
      fidelity: { threshold: 0.99 },
    });

    const fidelity = fidelityOf(result.report);
    expect(fidelity.status).toBe("measured");
    const check = result.report.checks.find((entry) => entry.id === "render.fidelity");
    expect(check?.status).toBe("warn");
    expect(check?.recommendation).toBeTruthy();
    const warning = result.report.warnings.find((entry) => entry.code === "fidelity.low-score");
    expect(warning).toBeDefined();
    expect(warning?.source).toBe("heuristic");
    expect(warning?.message).toContain("not a pixel-perfectness claim");
  });
});
