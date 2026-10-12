import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { runCli } from "./helpers/cli.js";

/**
 * Phase 6: `pageforge benchmark` end to end.
 *
 * Uses one scenario and zero warm-ups so the suite stays fast; the harness
 * itself (stats, skip/fail semantics, determinism) is unit-tested in
 * `packages/benchmark/test`.
 */

interface ReportJson {
  meta: {
    tool: string;
    version: string;
    iterations: number;
    warmup: number;
    chromiumVersion?: string;
  };
  scenarios: Array<{
    scenario: string;
    engines: Array<{
      engine: string;
      status: "ok" | "skipped" | "failed";
      skipReason?: string;
      error?: string;
      runs: number[];
      outputBytes?: number;
    }>;
  }>;
}

function engineResult(report: ReportJson, engineName: string): (typeof report.scenarios)[0]["engines"][0] {
  const engines = report.scenarios[0]?.engines ?? [];
  const found = engines.find((engine) => engine.engine === engineName);
  if (found === undefined) throw new Error(`engine ${engineName} missing from report`);
  return found;
}

let workDir: string;

test.beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "pageforge-bench-"));
});

test.afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

test.describe("pageforge benchmark", () => {
  test("--json emits a machine-readable report with honest per-engine statuses", async () => {
    test.setTimeout(120_000); // slow CI runners launch several browsers here
    const result = await runCli(
      ["benchmark", "--iterations", "1", "--warmup", "0", "--scenarios", "simple", "--json"],
      { timeoutMs: 100_000 },
    );
    expect(result.code).toBe(0);

    const report = JSON.parse(result.stdout) as ReportJson;
    expect(report.meta.tool).toBe("pageforge-benchmark");
    expect(report.meta.iterations).toBe(1);
    expect(report.meta.warmup).toBe(0);
    expect(report.scenarios).toHaveLength(1);
    expect(report.scenarios[0]?.scenario).toBe("simple");

    // PageForge and its raw baseline must both produce measured output.
    for (const name of ["pageforge", "playwright-raw", "html2pdf.js"]) {
      const engine = engineResult(report, name);
      expect(engine.status).toBe("ok");
      expect(engine.runs).toHaveLength(1);
      expect(engine.runs[0]).toBeGreaterThan(0);
      expect(engine.outputBytes ?? 0).toBeGreaterThan(0);
    }

    // WeasyPrint: present → measured; absent → skipped WITH the install hint.
    // Never anything in between (no estimated numbers).
    const weasyprint = engineResult(report, "weasyprint");
    if (weasyprint.status === "skipped") {
      expect(weasyprint.skipReason).toContain("never estimated");
      expect(weasyprint.runs).toEqual([]);
    } else {
      expect(weasyprint.status).toBe("ok");
      expect(weasyprint.runs).toHaveLength(1);
    }

    // Progress lines must not corrupt the single JSON document on stdout.
    expect(result.stdout.trimStart().startsWith("{")).toBe(true);
  });

  test("human mode prints the table and --output writes the JSON report", async () => {
    test.setTimeout(120_000);
    const outputPath = path.join(workDir, "report.json");
    const result = await runCli(
      [
        "benchmark",
        "--iterations",
        "1",
        "--warmup",
        "0",
        "--scenarios",
        "simple",
        "--output",
        outputPath,
      ],
      { timeoutMs: 100_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PageForge benchmark");
    expect(result.stdout).toContain("median");
    expect(result.stdout).toContain(`JSON report written to ${outputPath}`);

    const written = JSON.parse(await readFile(outputPath, "utf8")) as ReportJson;
    expect(written.meta.tool).toBe("pageforge-benchmark");
    expect(written.scenarios[0]?.scenario).toBe("simple");
  });

  test("unknown scenario names are usage errors (exit 2) and invalid counts too", async () => {
    const unknown = await runCli(["benchmark", "--scenarios", "nope"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("--scenarios");
    expect(unknown.stderr).toContain("nope");

    const badCount = await runCli(["benchmark", "--iterations", "0"]);
    expect(badCount.code).toBe(2);
    expect(badCount.stderr).toContain("--iterations");

    const badEngine = await runCli(["benchmark", "--engines", "chrome-pdf"]);
    expect(badEngine.code).toBe(2);
    expect(badEngine.stderr).toContain("--engines");
  });

  test("--help documents the benchmark command", async () => {
    const result = await runCli(["benchmark", "--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("benchmark");
    expect(result.stdout).toContain("--iterations");
    expect(result.stdout).toContain("--scenarios");
  });
});
