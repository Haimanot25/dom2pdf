import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createConverter, inspectPdf, type Converter, type DeterminismReport } from "../packages/core/dist/index.js";
import { runCli } from "./helpers/cli.js";

let converter: Converter;

test.beforeAll(async () => {
  converter = await createConverter();
});

test.afterAll(async () => {
  await converter?.close();
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const DETERMINISM_HTML =
  "<h1>Deterministic report</h1>" +
  "<p>Repeated conversions of this input must be byte-identical when the date stamps are normalized.</p>".repeat(6);

function deterministicReportOf(report: unknown): DeterminismReport {
  const deterministic = (report as { deterministic?: DeterminismReport }).deterministic;
  expect(deterministic, "expected report.deterministic to be present").toBeDefined();
  return deterministic as DeterminismReport;
}

test.describe("deterministic output", () => {
  test("two conversions of the same input are byte-identical", async () => {
    const first = await converter.convert({ input: { type: "html", html: DETERMINISM_HTML }, deterministic: true });
    const second = await converter.convert({ input: { type: "html", html: DETERMINISM_HTML }, deterministic: true });

    expect(sha256(first.bytes)).toBe(sha256(second.bytes));
    // The report digest agrees with the byte-level digest of the content.
    const deterministic = deterministicReportOf(second.report);
    expect(deterministic.contentDigest).toBe(deterministicReportOf(first.report).contentDigest);
    expect(deterministic.normalizedSpans).toBeGreaterThanOrEqual(1);
    expect(deterministic.residual).toBe(0);
  });

  test("reports the content digest and a passing determinism check", async () => {
    const result = await converter.convert({ input: { type: "html", html: DETERMINISM_HTML }, deterministic: true });
    const deterministic = deterministicReportOf(result.report);
    expect(deterministic.contentDigest).toMatch(/^[0-9a-f]{64}$/);

    const check = result.report.checks.find((entry) => entry.id === "pdf.determinism");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("date span(s) zeroed in place");
    expect(check?.detail).toContain(`sha256:${deterministic.contentDigest}`);
    expect(result.report.warnings.some((warning) => warning.code === "determinism.residual")).toBe(false);
  });

  test("the normalized PDF still parses structurally", async () => {
    const result = await converter.convert({ input: { type: "html", html: DETERMINISM_HTML }, deterministic: true });
    const inspection = await inspectPdf(result.bytes);
    expect(inspection.pageCount).toBe(result.report.pdf.pageCount);
    expect(inspection.headerVersion).not.toBeNull();
  });

  test("different content produces a different digest", async () => {
    const first = await converter.convert({ input: { type: "html", html: "<p>alpha content</p>" }, deterministic: true });
    const second = await converter.convert({ input: { type: "html", html: "<p>beta content</p>" }, deterministic: true });
    expect(deterministicReportOf(first.report).contentDigest).not.toBe(
      deterministicReportOf(second.report).contentDigest,
    );
  });

  test("omits the determinism report and check when disabled", async () => {
    const result = await converter.convert({ input: { type: "html", html: DETERMINISM_HTML } });
    expect(result.report.deterministic).toBeUndefined();
    expect(result.report.checks.some((check) => check.id === "pdf.determinism")).toBe(false);
  });

  test("CLI --deterministic writes byte-identical files and prints the digest", async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), "pageforge-det-"));
    try {
      const outA = path.join(workDir, "run-a.pdf");
      const outB = path.join(workDir, "run-b.pdf");
      const first = await runCli(["convert", "--stdin", "--deterministic", "-o", outA], { stdin: DETERMINISM_HTML });
      const second = await runCli(["convert", "--stdin", "--deterministic", "-o", outB], { stdin: DETERMINISM_HTML });
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(first.stdout).toContain("deterministic: content digest sha256:");

      const [bytesA, bytesB] = await Promise.all([readFile(outA), readFile(outB)]);
      expect(sha256(new Uint8Array(bytesA))).toBe(sha256(new Uint8Array(bytesB)));
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  });
});
