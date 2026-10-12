import { writeFileSync } from "node:fs";
import type { Command } from "commander";
import {
  ENGINE_NAMES,
  formatReportHuman,
  runBenchmark,
  SCENARIO_NAMES,
  type BenchmarkReport,
} from "pageforge-benchmark";
import { parseIntFlag, UsageError } from "./shared.js";

interface BenchmarkFlags {
  iterations: string;
  warmup: string;
  scenarios?: string;
  engines?: string;
  output?: string;
  json?: boolean;
}

/**
 * Engines whose failure fails the whole benchmark (exit 3). PageForge and its
 * raw-Playwright baseline are the pair the suite exists to compare — if either
 * cannot run, the numbers are meaningless. Comparators (html2pdf.js,
 * WeasyPrint) are informational: their failures are reported in the JSON
 * (`status: "failed"`) but do not fail the command, and missing tools are
 * `skipped` with a reason — never estimated.
 */
const REQUIRED_ENGINES: ReadonlySet<string> = new Set(["pageforge", "playwright-raw"]);

/** Parses and validates a comma-separated `--scenarios`/`--engines` value. */
export function parseNameList(
  flagName: string,
  value: string | undefined,
  valid: readonly string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  const names = value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (names.length === 0) {
    throw new UsageError(`--${flagName} requires at least one name`);
  }
  const unknown = names.filter((name) => !valid.includes(name));
  if (unknown.length > 0) {
    throw new UsageError(
      `--${flagName}: unknown name(s) ${unknown.join(", ")} — valid names: ${valid.join(", ")}`,
    );
  }
  return names;
}

function requiredFailures(report: BenchmarkReport): string[] {
  const failures: string[] = [];
  for (const scenario of report.scenarios) {
    for (const engine of scenario.engines) {
      if (REQUIRED_ENGINES.has(engine.engine) && engine.status === "failed") {
        failures.push(`${engine.engine} @ ${scenario.scenario}: ${engine.error ?? "unknown error"}`);
      }
    }
  }
  return failures;
}

export function registerBenchmarkCommand(program: Command): void {
  program
    .command("benchmark")
    .description("run the deterministic HTML-to-PDF benchmark suite")
    .option("--iterations <n>", "measured runs per engine and scenario", "5")
    .option("--warmup <n>", "warm-up runs excluded from statistics", "1")
    .option("--scenarios <list>", `comma-separated scenarios (${SCENARIO_NAMES.join(", ")})`, undefined)
    .option("--engines <list>", `comma-separated engines (${ENGINE_NAMES.join(", ")})`, undefined)
    .option("--output <path>", "write the JSON report to a file", undefined)
    .option("--json", "print the JSON report on stdout")
    .action(async (flags: BenchmarkFlags) => {
      const iterations = parseIntFlag("iterations", flags.iterations);
      const warmup = parseIntFlag("warmup", flags.warmup);
      if (iterations < 1) throw new UsageError(`--iterations must be >= 1; received ${String(iterations)}`);
      if (warmup < 0) throw new UsageError(`--warmup must be >= 0; received ${String(warmup)}`);
      const scenarios = parseNameList("scenarios", flags.scenarios, SCENARIO_NAMES);
      const engines = parseNameList("engines", flags.engines, ENGINE_NAMES);

      // SIGINT exits 130 like `convert` does; Playwright terminates the
      // browsers it owns when this process goes away.
      const onSignal = (): void => process.exit(130);
      process.once("SIGINT", onSignal);
      try {
        const report = await runBenchmark({
          iterations,
          warmup,
          ...(scenarios === undefined ? {} : { scenarios }),
          ...(engines === undefined ? {} : { engines }),
          // Progress would corrupt the single-document JSON contract on stdout.
          ...(flags.json === true ? {} : { onProgress: (message: string) => console.log(message) }),
        });

        const json = JSON.stringify(report, null, 2);
        if (flags.output !== undefined) {
          writeFileSync(flags.output, `${json}\n`, "utf8");
        }
        if (flags.json === true) {
          console.log(json);
        } else {
          console.log(`\n${formatReportHuman(report)}`);
          if (flags.output !== undefined) console.log(`\nJSON report written to ${flags.output}`);
        }

        const failures = requiredFailures(report);
        if (failures.length > 0) {
          throw new Error(`benchmark failed:\n  ${failures.join("\n  ")}`);
        }
      } finally {
        process.removeListener("SIGINT", onSignal);
      }
    });
}
