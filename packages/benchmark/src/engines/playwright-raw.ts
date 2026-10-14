import { chromium, type Browser } from "playwright";
import type { BenchmarkScenario } from "../scenarios.js";
import type { BenchmarkEngine, EngineAvailability, EngineTimedRun } from "./types.js";

/**
 * Raw Playwright: `setContent` + `page.pdf()` on a fresh page per run, same
 * pinned Chromium as dom2pdf, print backgrounds on (dom2pdf's default).
 *
 * This is the honest baseline: it isolates what dom2pdf's pipeline
 * (readiness, policy, report) adds on top of Chromium's native PDF path. It
 * deliberately applies no readiness logic — what you pay for the extras is
 * exactly what is being measured.
 */
export function createPlaywrightRawEngine(): BenchmarkEngine {
  let browser: Browser | undefined;
  let browserVersion: string | undefined;

  async function ensureBrowser(): Promise<Browser> {
    browser ??= await chromium.launch({ headless: true, chromiumSandbox: true });
    return browser;
  }

  return {
    name: "playwright-raw",
    description: "raw Playwright setContent + page.pdf() on the same Chromium (baseline)",

    async probe(): Promise<EngineAvailability> {
      return { available: true };
    },

    async prepare(_scenario: BenchmarkScenario, _html: string): Promise<void> {
      // Each run builds its own page; nothing to stage.
    },

    async run(_scenario: BenchmarkScenario, html: string): Promise<EngineTimedRun> {
      const active = await ensureBrowser();
      const context = await active.newContext();
      try {
        const page = await context.newPage();
        const startedAt = performance.now();
        await page.setContent(html, { waitUntil: "load" });
        const pdf = await page.pdf({ format: "A4", printBackground: true });
        const ms = performance.now() - startedAt;
        browserVersion ??= active.version();
        return { ms, outputBytes: pdf.byteLength };
      } finally {
        await context.close();
      }
    },

    browserVersion(): string | undefined {
      return browserVersion;
    },

    async cleanup(): Promise<void> {
      const active = browser;
      browser = undefined;
      if (active !== undefined && active.isConnected()) await active.close();
    },
  };
}
