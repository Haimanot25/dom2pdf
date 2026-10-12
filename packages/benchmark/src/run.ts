import { readFileSync } from "node:fs";
import os from "node:os";
import { PageForgeError } from "pageforge-pdf";
import { createHtml2PdfEngine } from "./engines/html2pdf.js";
import { createPageForgeEngine } from "./engines/pageforge.js";
import { createPlaywrightRawEngine } from "./engines/playwright-raw.js";
import type { BenchmarkEngine } from "./engines/types.js";
import { createWeasyPrintEngine } from "./engines/weasyprint.js";
import type { BenchmarkReport, EngineResult, ScenarioResult } from "./report.js";
import { SCENARIOS, SCENARIO_NAMES, type BenchmarkScenario } from "./scenarios.js";
import { computeStats } from "./stats.js";

/** Stable engine names, in report order (used by `--engines`). */
export const ENGINE_NAMES = ["pageforge", "playwright-raw", "html2pdf.js", "weasyprint"] as const;

export function createDefaultEngines(): BenchmarkEngine[] {
  return [
    createPageForgeEngine(),
    createPlaywrightRawEngine(),
    createHtml2PdfEngine(),
    createWeasyPrintEngine(),
  ];
}

export interface BenchmarkRunOptions {
  /** Measured runs per engine/scenario (default 5, minimum 1). */
  iterations?: number;
  /** Warm-up runs excluded from statistics (default 1, minimum 0). */
  warmup?: number;
  /** Scenario names to run; default: all. Unknown names are rejected. */
  scenarios?: string[];
  /** Engine names to run; default: all. Unknown names are rejected. */
  engines?: string[];
  /** Progress callbacks (human output streams them to stderr/stdout). */
  onProgress?: (message: string) => void;
  /** Injected engines — tests use fakes; the default is the real four. */
  engineFactory?: () => BenchmarkEngine[];
}

type ProbeOutcome =
  | { status: "available" }
  | { status: "unavailable"; reason: string }
  | { status: "failed"; error: string };

function readPackageVersion(): string {
  try {
    const source = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(source);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version = (parsed as { version?: unknown }).version;
      if (typeof version === "string") return version;
    }
  } catch {
    // Fall through — version is metadata, not a reason to fail a benchmark.
  }
  return "unknown";
}

function assertIntegerOption(name: string, value: number, minimum: number): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new PageForgeError({
      code: "INVALID_INPUT",
      message: `${name} must be an integer >= ${minimum}; received ${String(value)}`,
      details: { option: name, value },
    });
  }
}

function selectScenarios(names: string[] | undefined): BenchmarkScenario[] {
  if (names === undefined) return [...SCENARIOS];
  const byName = new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));
  const unknown = names.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new PageForgeError({
      code: "INVALID_INPUT",
      message: `Unknown scenario(s): ${unknown.join(", ")} — valid names: ${SCENARIO_NAMES.join(", ")}`,
      details: { unknown, valid: [...SCENARIO_NAMES] },
    });
  }
  return names.map((name) => byName.get(name) as BenchmarkScenario);
}

function selectEngines(
  names: string[] | undefined,
  factory: () => BenchmarkEngine[],
): BenchmarkEngine[] {
  const all = factory();
  if (names === undefined) return all;
  const known = new Set(all.map((engine) => engine.name));
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    throw new PageForgeError({
      code: "INVALID_INPUT",
      message: `Unknown engine(s): ${unknown.join(", ")} — valid names: ${[...known].join(", ")}`,
      details: { unknown, valid: [...known] },
    });
  }
  const byName = new Map(all.map((engine) => [engine.name, engine]));
  const selected = names.map((name) => byName.get(name) as BenchmarkEngine);
  // Discard engines that were not selected so nothing is launched for them.
  for (const engine of all) {
    if (!names.includes(engine.name)) {
      void engine.cleanup().catch(() => undefined);
    }
  }
  return selected;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Run the benchmark suite and return the full report.
 *
 * Never fabricates results: engines that cannot run come back `skipped` with a
 * reason, engines that break come back `failed` with the error, and both are
 * part of the report rather than hidden.
 */
export async function runBenchmark(options: BenchmarkRunOptions = {}): Promise<BenchmarkReport> {
  const iterations = options.iterations ?? 5;
  const warmup = options.warmup ?? 1;
  assertIntegerOption("iterations", iterations, 1);
  assertIntegerOption("warmup", warmup, 0);

  const scenarios = selectScenarios(options.scenarios);
  const engines = selectEngines(options.engines, options.engineFactory ?? createDefaultEngines);
  const onProgress = options.onProgress ?? ((): void => undefined);

  const startedAt = new Date();
  const probes = new Map<string, ProbeOutcome>();

  try {
    for (const engine of engines) {
      try {
        const availability = await engine.probe();
        probes.set(
          engine.name,
          availability.available ? { status: "available" } : { status: "unavailable", reason: availability.reason },
        );
      } catch (cause) {
        probes.set(engine.name, { status: "failed", error: errorMessage(cause) });
      }
    }

    const scenarioResults: ScenarioResult[] = [];
    for (const scenario of scenarios) {
      onProgress(`scenario ${scenario.name} — ${scenario.description}`);
      const html = scenario.html();
      const engineResults: EngineResult[] = [];

      for (const engine of engines) {
        const probe = probes.get(engine.name) ?? { status: "failed" as const, error: "engine was never probed" };
        if (probe.status === "unavailable") {
          engineResults.push({
            engine: engine.name,
            status: "skipped",
            skipReason: probe.reason,
            runs: [],
            stats: undefined,
            outputBytes: undefined,
          });
          continue;
        }
        if (probe.status === "failed") {
          engineResults.push({
            engine: engine.name,
            status: "failed",
            error: `probe failed: ${probe.error}`,
            runs: [],
            stats: undefined,
            outputBytes: undefined,
          });
          continue;
        }

        onProgress(`  ${engine.name}: warm-up ${warmup}, measured ${iterations}`);
        const runs: number[] = [];
        let outputBytes: number | undefined;
        try {
          await engine.prepare(scenario, html);
          for (let i = 0; i < warmup; i += 1) {
            await engine.run(scenario, html);
          }
          for (let i = 0; i < iterations; i += 1) {
            const outcome = await engine.run(scenario, html);
            runs.push(outcome.ms);
            outputBytes = outcome.outputBytes;
          }
          engineResults.push({
            engine: engine.name,
            status: "ok",
            runs,
            stats: computeStats(runs),
            outputBytes,
          });
          const stats = computeStats(runs);
          onProgress(
            `  ${engine.name}: median ${Math.round(stats.medianMs)}ms ` +
              `(min ${Math.round(stats.minMs)}, max ${Math.round(stats.maxMs)})`,
          );
        } catch (cause) {
          engineResults.push({
            engine: engine.name,
            status: "failed",
            error: errorMessage(cause),
            runs,
            stats: runs.length > 0 ? computeStats(runs) : undefined,
            outputBytes,
          });
          onProgress(`  ${engine.name}: FAILED — ${errorMessage(cause)}`);
        }
      }

      scenarioResults.push({
        scenario: scenario.name,
        description: scenario.description,
        engines: engineResults,
      });
    }

    const finishedAt = new Date();
    const cpus = os.cpus();
    return {
      meta: {
        tool: "pageforge-benchmark",
        version: readPackageVersion(),
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        platform: process.platform,
        arch: process.arch,
        cpuCount: cpus.length,
        cpuModel: cpus[0]?.model,
        nodeVersion: process.version,
        chromiumVersion: engines.map((engine) => engine.browserVersion?.()).find((v) => v !== undefined),
        iterations,
        warmup,
      },
      scenarios: scenarioResults,
    };
  } finally {
    for (const engine of engines) {
      try {
        await engine.cleanup();
      } catch {
        // Cleanup is best-effort; the report above is what matters. A cleanup
        // failure must not mask a benchmark failure already in flight.
      }
    }
  }
}
