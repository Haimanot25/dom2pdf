import { expect, test } from "@playwright/test";
import { createConverter, type Converter } from "../packages/core/dist/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";
import { extractPdfText } from "./helpers/pdf-text.js";

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

test.describe("readiness: network idle and settle", () => {
  test("default readiness waits for in-flight resources and reports its phases", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/readiness-late.html` },
      security: { allowLoopback: true },
    });

    const check = result.report.checks.find((entry) => entry.id === "readiness");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("ready in");
    expect(check?.detail).toContain("network idle 300ms");
    expect(check?.detail).toContain("fonts settled");

    // Timings are measured, not invented.
    expect(result.report.timings.readinessMs).toBeGreaterThanOrEqual(300);
    expect(result.report.timings.renderMs).toBeGreaterThan(0);
    expect(result.report.timings.readinessMs).toBeLessThanOrEqual(result.report.durationMs);

    // The fetch started before `load`; only the idle window makes its result
    // visible at capture time.
    const [pageText = ""] = await extractPdfText(result.bytes);
    expect(pageText).toContain("late resource arrived");
    expect(pageText).toContain("timer text rendered");
  });

  test("networkIdleMs: 0 skips the idle wait and says so in the report", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/readiness-late.html` },
      security: { allowLoopback: true },
      readiness: { networkIdleMs: 0 },
    });

    const check = result.report.checks.find((entry) => entry.id === "readiness");
    expect(check?.detail).not.toContain("network idle");
    expect(result.report.timings.readinessMs).toBeLessThan(300);
  });

  test("settleMs provides a quiet period without network-idle", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/readiness-late.html` },
      security: { allowLoopback: true },
      readiness: { networkIdleMs: 0, settleMs: 900 },
    });

    const check = result.report.checks.find((entry) => entry.id === "readiness");
    expect(check?.detail).toContain("settled 900ms");
    expect(check?.detail).not.toContain("network idle");

    const [pageText = ""] = await extractPdfText(result.bytes);
    // 900ms of settle exceeds the fixture's 600ms delayed fetch, so the late
    // content is guaranteed to exist before capture.
    expect(pageText).toContain("late resource arrived");
  });

  test("a chatty network fails with READINESS_TIMEOUT instead of hanging", async () => {
    const started = Date.now();
    await expect(
      converter.convert({
        input: { type: "url", url: `${server.origin}/readiness-polling.html` },
        security: { allowLoopback: true },
        readiness: { timeoutMs: 1_500 },
      }),
    ).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("chatty traffic with nothing in flight degrades to a warning, not a failure", async () => {
    // Live news homepages keep the activity clock fresh forever with fast
    // analytics beacons while transferring almost nothing — a quiet window
    // never arrives, but the page IS settled. Waiting until the deadline and
    // failing (the old behavior, found on a 14-site matrix) threw away a
    // perfectly capturable page under advice that did not apply. The network
    // stage now stops at its own stage budget, readiness reports the fact,
    // and the conversion succeeds with an honest warning.
    const started = Date.now();
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/network-chatty.html` },
      security: { allowLoopback: true },
    });

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.report.status).toBe("succeeded");

    const readiness = result.report.checks.find((entry) => entry.id === "readiness");
    expect(readiness?.status).toBe("warn");
    expect(readiness?.detail).toContain("network unsettled (no 300ms quiet)");
    expect(readiness?.recommendation).toContain("readiness.timeoutMs");

    const warning = result.report.warnings.find(
      (entry) => entry.code === "readiness.network-unsettled",
    );
    expect(warning, "the unsettled wait must be reported, never silent").toBeDefined();
    expect(warning?.message).toContain("network quiet");

    // The capture itself is complete — degrading costs a warning, not content.
    const [pageText = ""] = await extractPdfText(result.bytes);
    expect(pageText).toContain("CHATTY-CONTENT-READY");
  });
});

test.describe("readiness: selector", () => {
  test("waits for a selector to become visible before rendering", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/readiness-selector.html` },
      security: { allowLoopback: true },
      readiness: { selector: "#ready" },
    });

    const check = result.report.checks.find((entry) => entry.id === "readiness");
    expect(check?.detail).toContain('selector "#ready" visible');

    const [pageText = ""] = await extractPdfText(result.bytes);
    // The element starts display:none; printing before it appears would drop it.
    expect(pageText).toContain("selector ready content");
  });

  test("a selector that never appears fails with READINESS_TIMEOUT", async () => {
    const started = Date.now();
    const attempt = converter.convert({
      input: { type: "url", url: `${server.origin}/readiness-selector.html` },
      security: { allowLoopback: true },
      readiness: { selector: "#never", timeoutMs: 1_200 },
    });

    const caught = await attempt.then(() => null, (error: unknown) => error);
    expect(caught).toMatchObject({ code: "READINESS_TIMEOUT" });
    expect((caught as { details?: Record<string, unknown> }).details?.["stage"]).toBe("selector");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});

test.describe("readiness: resource diagnostics", () => {
  test("failed requests, HTTP errors, and broken images surface as observed warnings", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/broken-resources.html` },
      security: { allowLoopback: true },
    });

    const codes = result.report.warnings.map((warning) => warning.code);
    expect(codes).toContain("resources.http-error");
    expect(codes).toContain("resources.request-failed");
    expect(codes).toContain("resources.broken-images");
    for (const warning of result.report.warnings) expect(warning.source).toBe("observed");

    const httpWarning = result.report.warnings.find((w) => w.code === "resources.http-error");
    expect(httpWarning?.message).toContain("definitely-missing.png");
    expect(httpWarning?.message).toContain("404");

    const resources = result.report.checks.find((entry) => entry.id === "resources");
    expect(resources?.status).toBe("warn");
    expect(resources?.detail).toContain("HTTP error");

    const readiness = result.report.checks.find((entry) => entry.id === "readiness");
    expect(readiness?.detail).toContain("images 0/2");
    expect(readiness?.detail).toContain("2 broken");
  });

  test("a clean page reports a passing resources check", async () => {
    const result = await converter.convert({
      input: { type: "html", html: "<p>nothing external here</p>" },
    });
    const resources = result.report.checks.find((entry) => entry.id === "resources");
    expect(resources?.status).toBe("pass");
    expect(result.report.warnings).toEqual([]);
  });

  test("waitForFonts surfaces @font-face declarations that failed to load", async () => {
    const withoutFonts = await converter.convert({ input: { type: "html", html: "<p>font check</p>" } });
    expect(withoutFonts.report.warnings.map((warning) => warning.code)).not.toContain(
      "resources.font-unavailable",
    );

    // The fixture declares a @font-face whose URL dies mid-response; the
    // browser reports the face as errored after waitForFonts waits on it.
    const withFonts = await converter.convert({
      input: { type: "url", url: `${server.origin}/broken-font.html` },
      security: { allowLoopback: true },
      readiness: { waitForFonts: ["dom2pdf Missing"] },
    });
    const warning = withFonts.report.warnings.find((w) => w.code === "resources.font-unavailable");
    expect(warning?.source).toBe("observed");
    expect(warning?.message).toContain("dom2pdf Missing");

    const check = withFonts.report.checks.find((entry) => entry.id === "readiness");
    expect(check?.status).toBe("pass");
  });

  test("the pdf-text check reports measured extractable characters", async () => {
    const result = await converter.convert({
      input: { type: "html", html: "<p>measurable text content</p>" },
    });
    const check = result.report.checks.find((entry) => entry.id === "pdf-text");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toMatch(/\d+ extractable character\(s\) across 1 page\(s\)/);
  });
});
