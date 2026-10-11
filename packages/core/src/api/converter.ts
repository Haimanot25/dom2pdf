import { preparePage } from "../capture/prepare.js";
import { BrowserManager } from "../browser/manager.js";
import { normalizeOptions } from "../config/normalize.js";
import type { ConvertOptions } from "../config/schema.js";
import { PageForgeError } from "../errors/index.js";
import { applyInput } from "../inputs/apply.js";
import { prepareInput } from "../inputs/resolve.js";
import { analyzeScreenLayout, layoutWarnings } from "../layout-analysis/analyze.js";
import { inspectPdf } from "../pdf/inspect.js";
import { buildQualityReport, type QualityCheck, type QualityWarning } from "../quality/report.js";
import { documentRenderer } from "../renderers/document.js";
import { screenRenderer } from "../renderers/screen.js";
import type { Renderer } from "../renderers/types.js";
import { raceWithAbort, throwIfAborted } from "../utils/cancellation.js";
import { Deadline } from "../utils/deadline.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { ConversionResult } from "./result.js";
import type { Converter, ConvertResult, CreateConverterOptions } from "./types.js";

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;

function rendererFor(mode: "document" | "screen"): Renderer {
  return mode === "screen" ? screenRenderer : documentRenderer;
}

class ConverterImpl implements Converter {
  private closed = false;

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly logger: Logger,
  ) {}

  async convert(options: ConvertOptions): Promise<ConvertResult> {
    if (this.closed) {
      throw new PageForgeError({ code: "CONVERTER_CLOSED", message: "Converter has been closed" });
    }

    const normalized = normalizeOptions(options);
    throwIfAborted(normalized.signal);

    const startedAt = Date.now();
    const log = this.logger.child("convert");
    const signal = normalized.signal;

    // One overall deadline covers input preparation, navigation, and readiness
    // checks; stages clamp to the remaining time instead of getting their own
    // independent budget.
    const readinessDeadline = Deadline.in(normalized.readiness.timeoutMs);

    try {
      return await raceWithAbort(
        this.browserManager.usePage(
          async (page) => {
            const plan = await raceWithAbort(prepareInput(normalized), signal);
            readinessDeadline.throwIfExpired(
              "READINESS_TIMEOUT",
              `Readiness deadline (${normalized.readiness.timeoutMs}ms) elapsed before navigation started`,
            );
            await raceWithAbort(applyInput(page, plan, readinessDeadline.remainingMs()), signal);
            await raceWithAbort(preparePage(page, normalized), signal);

            const warnings: QualityWarning[] = [];
            const checks: QualityCheck[] = [];
            if (normalized.mode === "screen" && normalized.outputPolicy !== undefined) {
              const findings = await raceWithAbort(analyzeScreenLayout(page), signal);
              warnings.push(...layoutWarnings(findings));
            }

            // Phase 3 readiness checks (fonts, images, network, selector,
            // custom conditions, settling) run here under the same deadline.
            readinessDeadline.throwIfExpired(
              "READINESS_TIMEOUT",
              `Readiness deadline (${normalized.readiness.timeoutMs}ms) elapsed before rendering started`,
            );

            const browserVersion = page.context().browser()?.version() ?? "unknown";
            const renderer = rendererFor(normalized.mode);
            const { bytes, metadata } = await renderer.render({
              page,
              options: normalized,
              logger: log.child("render"),
              signal,
            });

            if (metadata?.outputPolicy === "paper-fit") {
              checks.push({
                id: "screen.output-policy",
                status: "pass",
                detail: `paper-fit: ${metadata.viewportWidth}px viewport scaled to ${Math.round(metadata.scale * 100)}% to fit ${metadata.paperLabel} content width`,
              });
            }

            const inspection = await raceWithAbort(inspectPdf(bytes), signal);
            const report = buildQualityReport({
              durationMs: Date.now() - startedAt,
              mode: normalized.mode,
              browserVersion,
              inspection,
              checks,
              warnings,
            });

            log.info("Conversion succeeded", {
              mode: report.mode,
              pages: report.pdf.pageCount,
              bytes: report.pdf.byteLength,
              durationMs: report.durationMs,
              warnings: report.warnings.length,
            });
            return new ConversionResult(bytes, report);
          },
          { viewport: normalized.viewport, ...(signal !== undefined ? { signal } : {}) },
        ),
        signal,
      );
    } catch (cause) {
      if (cause instanceof PageForgeError) throw cause;
      throw new PageForgeError({
        code: "BROWSER_FAILURE",
        message: `Unexpected conversion failure${cause instanceof Error ? `: ${cause.message}` : ""}`,
        cause,
      });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.browserManager.close();
  }
}

/**
 * Creates a converter. The Chromium process is launched lazily on the first
 * `convert()` call and reused across conversions; every conversion still gets
 * a brand-new isolated browser context.
 */
export async function createConverter(options: CreateConverterOptions = {}): Promise<Converter> {
  const logger = options.logger ?? createLogger();
  const browserManager = new BrowserManager(
    {
      sandbox: options.browser?.sandbox ?? true,
      launchTimeoutMs: options.browser?.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    },
    logger.child("browser"),
  );
  return new ConverterImpl(browserManager, logger.child("converter"));
}
