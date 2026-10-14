import { expect, test } from "@playwright/test";
import { createConverter, Dom2PdfError, type Converter } from "../packages/core/dist/index.js";
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

async function expectPolicyRejection(attempt: Promise<unknown>): Promise<Dom2PdfError> {
  const caught = await attempt.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(Dom2PdfError);
  const error = caught as Dom2PdfError;
  expect(error.code).toBe("QUALITY_POLICY_FAILED");
  return error;
}

test.describe("quality policies", () => {
  test("rejects output below minTextChars and attaches the measured report", async () => {
    const error = await expectPolicyRejection(
      converter.convert({
        input: { type: "html", html: "<p>tiny</p>" },
        quality: { minTextChars: 1_000_000 },
      }),
    );

    expect(error.message).toContain("extractable characters");
    const violations = error.details?.["violations"] as Array<{ rule: string }>;
    expect(violations.map((violation) => violation.rule)).toEqual(["minTextChars"]);
    const report = error.details?.["report"] as { status: string; pdf: { pageCount: number }; checks: unknown[] };
    expect(report.status).toBe("succeeded");
    expect(report.pdf.pageCount).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(report.checks)).toBe(true);

    // The converter stays usable after a policy rejection.
    const recovered = await converter.convert({ input: { type: "html", html: "<p>tiny</p>" } });
    expect(recovered.report.status).toBe("succeeded");
  });

  test("rejects output above maxPages", async () => {
    const error = await expectPolicyRejection(
      converter.convert({
        input: { type: "url", url: `${server.origin}/long-document.html` },
        security: { allowLoopback: true },
        quality: { maxPages: 1 },
      }),
    );
    const violations = error.details?.["violations"] as Array<{ rule: string; message: string }>;
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("maxPages");
    expect(violations[0]?.message).toContain("measured");
  });

  test("rejects output below minPages", async () => {
    const error = await expectPolicyRejection(
      converter.convert({
        input: { type: "html", html: "<p>one page only</p>" },
        quality: { minPages: 5 },
      }),
    );
    const violations = error.details?.["violations"] as Array<{ rule: string }>;
    expect(violations[0]?.rule).toBe("minPages");
  });

  test("rejects oversized output with maxBytes", async () => {
    const error = await expectPolicyRejection(
      converter.convert({
        input: { type: "html", html: "<p>size check</p>" },
        quality: { maxBytes: 64 },
      }),
    );
    const violations = error.details?.["violations"] as Array<{ rule: string }>;
    expect(violations[0]?.rule).toBe("maxBytes");
  });

  test("failOnWarnings rejects when the report contains warnings", async () => {
    const error = await expectPolicyRejection(
      converter.convert({
        input: { type: "url", url: `${server.origin}/screen-artifacts.html` },
        mode: "screen",
        security: { allowLoopback: true },
        quality: { failOnWarnings: true },
      }),
    );
    const violations = error.details?.["violations"] as Array<{ rule: string; message: string }>;
    expect(violations[0]?.rule).toBe("failOnWarnings");
    expect(violations[0]?.message).toContain("layout.horizontal-overflow");
  });

  test("a satisfying policy lets the conversion through with its report intact", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/long-document.html` },
      security: { allowLoopback: true },
      quality: { minTextChars: 1_000, minPages: 2, maxPages: 50, maxBytes: 10_000_000 },
    });
    expect(result.report.status).toBe("succeeded");
    expect(result.report.pdf.pageCount).toBeGreaterThanOrEqual(2);
    expect(result.report.checks.find((check) => check.id === "pdf-text")?.status).toBe("pass");
  });
});
