import { createConverter, createSilentLogger, type Converter } from "dom2pdf-js";
import type { BenchmarkScenario } from "../scenarios.js";
import type { BenchmarkEngine, EngineAvailability, EngineTimedRun } from "./types.js";

/**
 * dom2pdf itself: full pipeline (isolated context, request policy, readiness,
 * quality report). The browser launches on the first run and is then reused.
 */
export function createDom2PdfEngine(): BenchmarkEngine {
  let converter: Converter | undefined;
  let browserVersion: string | undefined;

  return {
    name: "dom2pdf",
    description: "dom2pdf full pipeline (context isolation, request policy, readiness, quality report)",

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
        ...(scenario.dom2pdfOptions ?? {}),
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
