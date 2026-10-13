import { expect, test } from "@playwright/test";
import {
  createConverter,
  PageForgeError,
  type Converter,
  type DiagnosticsBundle,
} from "../packages/core/dist/index.js";
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

async function expectFailure(attempt: Promise<unknown>): Promise<PageForgeError> {
  const caught = await attempt.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(PageForgeError);
  return caught as PageForgeError;
}

test.describe("failure forensics (diagnostics)", () => {
  test("attaches console, page errors, requests, DOM, and a screenshot to a readiness failure", async () => {
    const error = await expectFailure(
      converter.convert({
        input: { type: "url", url: `${server.origin}/diag-probe.html` },
        security: { allowLoopback: true },
        readiness: { selector: "#never-appears", timeoutMs: 1500 },
        diagnostics: true,
      }),
    );
    expect(error.code).toBe("READINESS_TIMEOUT");

    const bundle = error.details?.["diagnostics"] as DiagnosticsBundle | undefined;
    expect(bundle, "expected details.diagnostics on the failure").toBeDefined();
    expect(bundle?.gatheredAtMs).toBeGreaterThan(0);
    expect(bundle?.url).toContain("diag-probe.html");

    const consoleTexts = (bundle?.console ?? []).map((entry) => entry.text);
    expect(consoleTexts).toContain("pageforge-diag-probe");
    expect(consoleTexts).toContain("pageforge-diag-error");
    expect(bundle?.pageErrors.join(" ")).toContain("pageforge-diag-pageerror");

    const missing = (bundle?.requests ?? []).find((record) => record.url.includes("missing-diag-image.png"));
    expect(missing?.status).toBe(404);

    expect(bundle?.dom).toContain("diagnostics probe page");
    expect(typeof bundle?.screenshotJpegBase64).toBe("string");
  });

  test("omits forensics by default", async () => {
    const error = await expectFailure(
      converter.convert({
        input: { type: "url", url: `${server.origin}/diag-probe.html` },
        security: { allowLoopback: true },
        readiness: { selector: "#never-appears", timeoutMs: 1200 },
      }),
    );
    expect(error.code).toBe("READINESS_TIMEOUT");
    expect(error.details?.["diagnostics"]).toBeUndefined();
  });

  test("attaches forensics to a navigation failure too", async () => {
    const error = await expectFailure(
      converter.convert({
        input: { type: "url", url: "http://127.0.0.1:9/" },
        security: { allowLoopback: true },
        readiness: { timeoutMs: 5000 },
        diagnostics: true,
      }),
    );
    expect(error.code).toBe("NAVIGATION_FAILED");
    const bundle = error.details?.["diagnostics"] as DiagnosticsBundle | undefined;
    expect(bundle).toBeDefined();
    expect(Array.isArray(bundle?.console)).toBe(true);
    expect(Array.isArray(bundle?.requests)).toBe(true);
  });

  test("cancellation stays prompt and attaches no forensics", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 250);
    const error = await expectFailure(
      converter.convert({
        input: { type: "url", url: `${server.origin}/diag-probe.html` },
        security: { allowLoopback: true },
        readiness: { selector: "#never-appears", timeoutMs: 20_000 },
        diagnostics: true,
        signal: controller.signal,
      }),
    );
    clearTimeout(timer);
    expect(error.code).toBe("CANCELLED");
    expect(error.details?.["diagnostics"]).toBeUndefined();
  });
});
