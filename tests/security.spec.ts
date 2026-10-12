import { expect, test } from "@playwright/test";
import { createConverter, PageForgeError, type Converter } from "../packages/core/dist/index.js";
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

async function expectPolicyError(attempt: Promise<unknown>, code: string): Promise<PageForgeError> {
  let caught: unknown;
  try {
    await attempt;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(PageForgeError);
  const error = caught as PageForgeError;
  expect(error.code).toBe(code);
  return error;
}

test.describe("Phase 5: request policy enforcement", () => {
  test("blocks an HTTP redirect onto a private destination with BLOCKED_REDIRECT", async () => {
    const startedAt = Date.now();
    const error = await expectPolicyError(
      converter.convert({
        input: { type: "url", url: `${server.origin}/redirect-to?url=http://10.0.0.1/steal` },
        security: { allowLoopback: true },
        // Chromium follows redirect hops itself and hangs connecting to the
        // blackholed private address; the bounded navigation deadline plus the
        // Location-based verdict turn that into a fast typed failure.
        readiness: { timeoutMs: 5000 },
      }),
      "BLOCKED_REDIRECT",
    );
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(JSON.stringify(error.details)).toContain("10.0.0.1");
  });

  test("a redirect onto a disallowed protocol is refused by Chromium itself", async () => {
    // Chromium rejects unsafe redirect schemes (http→file) at the network
    // layer before a response is ever delivered, so no Location target
    // surfaces for classification: the native net error IS the defense, and
    // PageForge reports it honestly as NAVIGATION_FAILED rather than
    // pretending a policy layer saw the hop.
    const error = await expectPolicyError(
      converter.convert({
        input: {
          type: "url",
          url: `${server.origin}/redirect-to?url=${encodeURIComponent("file:///C:/Windows/win.ini")}`,
        },
        security: { allowLoopback: true },
      }),
      "NAVIGATION_FAILED",
    );
    expect(error.message).toContain("ERR_UNSAFE_REDIRECT");
  });

  test("allows a same-origin redirect and reports the request policy check", async () => {
    const result = await converter.convert({
      input: {
        type: "url",
        url: `${server.origin}/redirect-to?url=${encodeURIComponent(`${server.origin}/basic-text.html`)}`,
      },
      security: { allowLoopback: true },
    });
    expect(result.report.status).toBe("succeeded");
    expect(result.report.pdf.pageCount).toBeGreaterThanOrEqual(1);
    const securityCheck = result.report.checks.find((check) => check.id === "security.requests");
    expect(securityCheck?.status).toBe("pass");
    expect(securityCheck?.detail).toContain("destination policy");
  });

  test("blocks subresources destined for private or link-local addresses with BLOCKED_RESOURCE", async () => {
    const error = await expectPolicyError(
      converter.convert({
        input: { type: "url", url: `${server.origin}/blocked-subresource.html` },
        security: { allowLoopback: true },
      }),
      "BLOCKED_RESOURCE",
    );
    const details = JSON.stringify(error.details);
    expect(details).toMatch(/10\.0\.0\.1|169\.254\.169\.254/);
  });

  test("aborts page-scripted navigation to a blocked destination", async () => {
    const error = await expectPolicyError(
      converter.convert({
        input: { type: "url", url: `${server.origin}/blocked-nav.html` },
        security: { allowLoopback: true },
        // The scripted navigation fires at ~300ms; a generous settle window
        // guarantees readiness (and its verdict) comes after it.
        readiness: { networkIdleMs: 0, settleMs: 800 },
      }),
      "BLOCKED_URL",
    );
    expect(JSON.stringify(error.details)).toContain("169.254.169.254");
  });

  test("redacts credentials from blocked URL errors", async () => {
    const error = await expectPolicyError(
      converter.convert({ input: { type: "url", url: "http://user:secret@10.0.0.1/" } }),
      "BLOCKED_URL",
    );
    expect(error.message).not.toContain("secret");
    expect(error.message).not.toContain("user:secret");
    expect(JSON.stringify(error.toJSON())).not.toContain("secret");
  });
});

test.describe("Phase 5: resource limits", () => {
  test("enforces limits.maxRequests with RESOURCE_LIMIT_EXCEEDED", async () => {
    const error = await expectPolicyError(
      converter.convert({
        input: { type: "url", url: `${server.origin}/many-requests.html` },
        security: { allowLoopback: true },
        limits: { maxRequests: 10 },
      }),
      "RESOURCE_LIMIT_EXCEEDED",
    );
    expect(error.details?.["limit"]).toBe("maxRequests");
    expect(error.details?.["maxRequests"]).toBe(10);
  });

  test("enforces limits.maxOutputBytes with RESOURCE_LIMIT_EXCEEDED", async () => {
    const error = await expectPolicyError(
      converter.convert({
        input: { type: "html", html: "<p>plenty of prose for a small cap</p>" },
        limits: { maxOutputBytes: 100 },
      }),
      "RESOURCE_LIMIT_EXCEEDED",
    );
    expect(error.details?.["limit"]).toBe("maxOutputBytes");
    expect(Number(error.details?.["byteLength"])).toBeGreaterThan(100);
  });

  test("enforces the converter-level concurrency cap fail-fast and releases it", async () => {
    const local = await createConverter({ limits: { maxConcurrentConversions: 1 } });
    try {
      const first = local.convert({
        input: { type: "url", url: `${server.origin}/readiness-late.html` },
        security: { allowLoopback: true },
      });
      // The first conversion is in flight; the second must be rejected
      // immediately rather than queued.
      const error = await expectPolicyError(
        local.convert({ input: { type: "html", html: "<p>rejected while busy</p>" } }),
        "RESOURCE_LIMIT_EXCEEDED",
      );
      expect(error.details?.["limit"]).toBe("maxConcurrentConversions");

      const firstResult = await first;
      expect(firstResult.report.status).toBe("succeeded");

      // The cap is released once the conversion finishes.
      const after = await local.convert({ input: { type: "html", html: "<p>works again</p>" } });
      expect(after.report.status).toBe("succeeded");
    } finally {
      await local.close();
    }
  });
});
