import { createConverter, createSilentLogger, type Converter } from "pageforge-pdf";
import type { BenchmarkScenario } from "../scenarios.js";
import type { BenchmarkEngine, EngineAvailability, EngineTimedRun } from "./types.js";

/**
 * PageForge itself: the full production pipeline — isolated context, request
 * policy, readiness phase, quality report — measured end to end. The browser
 * launches on the first timed run and is reused for the rest of the suite,
 * matching how the library is used in practice.
 */
export function createPageForgeEngine(): BenchmarkEngine {
  let converter: Converter | undefined;
  let browserVersion: string | undefined;

  return {
    name: "pageforge",
    description: "PageForge full pipeline (context isolation, request policy, readiness, quality report)",

    async probe(): Promise<EngineAvailability> {
      return { available: true };
    },

    async prepare(_scenario: BenchmarkScenario, _html: string): Promise<void> {
      // Input is handed to `convert()` per run; nothing to stage.
    },

    async run(scenario: BenchmarkScenario, html: string): Promise<EngineTimedRun> {
      converter ??= await createConverter({ logger: createSilentLogger() });
      const startedAt = performance.now();
      const result = await converter.convert({
        input: { type: "html", html },
        ...(scenario.pageforgeOptions ?? {}),
      });
      const ms = performance.now() - startedAt;
      browserVersion ??= result.report.browser.version;
      return { ms, outputBytes: result.bytes.byteLength };
    },

    browserVersion(): string | undefined {
      return browserVersion;
    },

    async cleanup(): Promise<void> {
      const active = converter;
      converter = undefined;
      if (active !== undefined) await active.close();
    },
  };
}
