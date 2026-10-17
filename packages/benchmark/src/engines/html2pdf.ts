import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium, type Browser, type Page } from "playwright";
import type { BenchmarkScenario } from "../scenarios.js";
import type { BenchmarkEngine, EngineAvailability, EngineTimedRun } from "./types.js";

const require = createRequire(import.meta.url);

/** Fixed html2pdf.js configuration; not tuned per run. */
const HTML2PDF_OPTIONS = Object.freeze({
  margin: 10,
  image: { type: "jpeg", quality: 0.95 },
  html2canvas: { scale: 2, useCORS: true, logging: false, backgroundColor: "#ffffff" },
  jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
});

/**
 * html2pdf.js (html2canvas + jsPDF) running inside Chromium: the UMD bundle is
 * injected into the scenario's page and conversion runs as a page script.
 */
export function createHtml2PdfEngine(): BenchmarkEngine {
  let browser: Browser | undefined;
  let page: Page | undefined;
  let bundleSource: string | undefined;
  let browserVersion: string | undefined;

  return {
    name: "html2pdf.js",
    description: "html2pdf.js (html2canvas + jsPDF) running inside the same Chromium",

    async probe(): Promise<EngineAvailability> {
      try {
        const bundlePath = require.resolve("html2pdf.js/dist/html2pdf.bundle.min.js");
        bundleSource = readFileSync(bundlePath, "utf8");
        return { available: true, detail: "bundle resolved from node_modules" };
      } catch (cause) {
        return {
          available: false,
          reason: `html2pdf.js bundle unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
        };
      }
    },

    async prepare(_scenario: BenchmarkScenario, html: string): Promise<void> {
      if (bundleSource === undefined) throw new Error("html2pdf.js engine was not probed first");
      browser ??= await chromium.launch({ headless: true, chromiumSandbox: true });
      browserVersion ??= browser.version();
      const fresh = await browser.newPage();
      // `setContent` wipes scripts, so the bundle is injected afterwards.
      await fresh.setContent(html, { waitUntil: "load" });
      await fresh.addScriptTag({ content: bundleSource });
      page?.close().catch(() => undefined);
      page = fresh;
    },

    async run(_scenario: BenchmarkScenario, _html: string): Promise<EngineTimedRun> {
      const active = page;
      if (active === undefined) throw new Error("html2pdf.js engine was not prepared for this scenario");
      const startedAt = performance.now();
      const base64 = await active.evaluate(async (options) => {
        interface Chain {
          set(o: unknown): Chain;
          from(source: unknown): Chain;
          toPdf(): { output(type: string): Promise<ArrayBuffer> };
        }
        const factory = (globalThis as unknown as { html2pdf: (o?: unknown) => Chain }).html2pdf;
        if (typeof factory !== "function") throw new Error("html2pdf bundle did not load in the page");
        const arrayBuffer = await factory().set(options).from(document.body).toPdf().output("arraybuffer");
        const bytes = new Uint8Array(arrayBuffer);
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
      }, HTML2PDF_OPTIONS);
      const ms = performance.now() - startedAt;
      return { ms, outputBytes: Buffer.from(base64, "base64").byteLength };
    },

    browserVersion(): string | undefined {
      return browserVersion;
    },

    async cleanup(): Promise<void> {
      page = undefined;
      bundleSource = undefined;
      const active = browser;
      browser = undefined;
      if (active !== undefined && active.isConnected()) await active.close();
    },
  };
}
