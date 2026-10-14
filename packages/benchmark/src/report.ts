import type { TimingStats } from "./stats.js";

/**
 * Machine-readable benchmark report.
 *
 * Honesty rules baked into the shape:
 * - `status` is always present — `skipped` carries `skipReason` (external
 *   tool missing), `failed` carries `error`. Nothing is ever estimated.
 * - `runs` holds the raw per-run milliseconds so consumers can recompute
 *   statistics instead of trusting ours.
 */
export interface EngineResult {
  engine: string;
  status: "ok" | "skipped" | "failed";
  /** Present when `status === "skipped"`: why the engine could not run. */
  skipReason?: string;
  /** Present when `status === "failed"`: what went wrong. */
  error?: string;
  /** Measured run durations in ms (may be partial when `status === "failed"`). */
  runs: number[];
  /** Summary statistics; `undefined` until at least one run completed. */
  stats: TimingStats | undefined;
  /** Output size of the last completed run, in bytes. */
  outputBytes: number | undefined;
}

export interface ScenarioResult {
  scenario: string;
  description: string;
  engines: EngineResult[];
}

export interface BenchmarkMeta {
  tool: "dom2pdf-benchmark";
  version: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  platform: string;
  arch: string;
  cpuCount: number;
  cpuModel: string | undefined;
  nodeVersion: string;
  chromiumVersion: string | undefined;
  iterations: number;
  warmup: number;
}

export interface BenchmarkReport {
  meta: BenchmarkMeta;
  scenarios: ScenarioResult[];
}

function pad(label: string, width: number): string {
  return label.length >= width ? label : label + " ".repeat(width - label.length);
}

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** Human-readable summary table (the `--json` form is the raw report). */
export function formatReportHuman(report: BenchmarkReport): string {
  const { meta } = report;
  const lines: string[] = [
    `dom2pdf benchmark — ${report.scenarios.length} scenario(s), ${meta.iterations} measured run(s), ${meta.warmup} warm-up run(s)`,
    "",
  ];
  for (const scenario of report.scenarios) {
    lines.push(`${scenario.scenario} — ${scenario.description}`);
    const width = Math.max(...scenario.engines.map((engine) => engine.engine.length), 10);
    for (const engine of scenario.engines) {
      const label = pad(engine.engine, width);
      if (engine.status === "skipped") {
        lines.push(`  ${label}  skipped — ${engine.skipReason ?? "(no reason recorded)"}`);
        continue;
      }
      if (engine.status === "failed") {
        const partial = engine.runs.length > 0 ? ` (${engine.runs.length} run(s) before the failure)` : "";
        lines.push(`  ${label}  FAILED${partial} — ${engine.error ?? "(no error recorded)"}`);
        continue;
      }
      const stats = engine.stats;
      if (stats === undefined) {
        lines.push(`  ${label}  ok (no samples?)`);
        continue;
      }
      lines.push(
        `  ${label}  median ${Math.round(stats.medianMs)}ms` +
          `  (min ${Math.round(stats.minMs)}, max ${Math.round(stats.maxMs)}, p95 ${Math.round(stats.p95Ms)})` +
          `  output ${formatBytes(engine.outputBytes)}`,
      );
    }
    lines.push("");
  }
  lines.push(
    `meta: ${meta.platform} ${meta.arch} · ${meta.cpuCount} cpu(s)` +
      `${meta.cpuModel !== undefined ? ` · ${meta.cpuModel}` : ""}` +
      ` · node ${meta.nodeVersion}` +
      `${meta.chromiumVersion !== undefined ? ` · chromium ${meta.chromiumVersion}` : ""}` +
      ` · ${meta.durationMs}ms total`,
  );
  return lines.join("\n");
}
