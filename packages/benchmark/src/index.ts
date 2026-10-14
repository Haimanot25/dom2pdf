/**
 * dom2pdf benchmark harness — deterministic scenarios, honest results.
 *
 * The CLI (`dom2pdf benchmark`) is a thin wrapper around `runBenchmark()`;
 * everything here is usable as a library too.
 */
export { runBenchmark, ENGINE_NAMES, createDefaultEngines } from "./run.js";
export type { BenchmarkRunOptions } from "./run.js";
export { SCENARIOS, SCENARIO_NAMES } from "./scenarios.js";
export type { BenchmarkScenario } from "./scenarios.js";
export { computeStats } from "./stats.js";
export type { TimingStats } from "./stats.js";
export { formatReportHuman } from "./report.js";
export type { BenchmarkMeta, BenchmarkReport, EngineResult, ScenarioResult } from "./report.js";
export type { BenchmarkEngine, EngineAvailability, EngineTimedRun } from "./engines/types.js";
export { createWeasyPrintEngine } from "./engines/weasyprint.js";
export type { CommandOutcome, CommandRunner } from "./engines/weasyprint.js";
