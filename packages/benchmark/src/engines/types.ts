import type { BenchmarkScenario } from "../scenarios.js";

/** Why an engine cannot run (external tool missing, asset unavailable, …). */
export type EngineAvailability =
  | { available: true; detail?: string }
  | { available: false; reason: string };

/** One measured conversion. */
export interface EngineTimedRun {
  /** Wall-clock milliseconds for the whole conversion. */
  ms: number;
  /** Generated PDF size in bytes (engines that produce bytes always fill this). */
  outputBytes: number;
}

/**
 * One benchmark engine. Lifecycle per run of the suite:
 * `probe()` once → for each scenario `prepare()` (untimed) → `run()` n times
 * (warm-up first, then measured) → `cleanup()` once, always.
 */
export interface BenchmarkEngine {
  /** Stable machine-readable name (used by `--engines`). */
  readonly name: string;
  /** One-line human description. */
  readonly description: string;
  /** Cheap availability check. Throwing marks the engine failed, not skipped. */
  probe(): Promise<EngineAvailability>;
  /** Untimed setup for a scenario (load content, write input files, …). */
  prepare(scenario: BenchmarkScenario, html: string): Promise<void>;
  /** One timed conversion. */
  run(scenario: BenchmarkScenario, html: string): Promise<EngineTimedRun>;
  /** Chromium version, when this engine knows it (reported in meta). */
  browserVersion?(): string | undefined;
  /** Release everything (browsers, temp files). Must be idempotent. */
  cleanup(): Promise<void>;
}
