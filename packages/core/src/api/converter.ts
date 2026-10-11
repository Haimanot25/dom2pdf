import { preparePage } from "../capture/prepare.js";
import { BrowserManager } from "../browser/manager.js";
import { normalizeOptions } from "../config/normalize.js";
import type { ConvertOptions } from "../config/schema.js";
import { PageForgeError } from "../errors/index.js";
import { applyInput } from "../inputs/apply.js";
import { prepareInput } from "../inputs/resolve.js";
import { inspectPdf } from "../pdf/inspect.js";
import { buildQualityReport } from "../quality/report.js";
import { documentRenderer } from "../renderers/document.js";
import { Deadline } from "../utils/deadline.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { ConversionResult } from "./result.js";
import type { Converter, ConvertResult, CreateConverterOptions } from "./types.js";

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;

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
    const startedAt = Date.now();
    const log = this.logger.child("convert");

    // One overall deadline covers input preparation, navigation, and readiness
    // checks; stages clamp to the remaining time instead of getting their own
    // independent budget.
    const readinessDeadline = Deadline.in(normalized.readiness.timeoutMs);

    try {
      return await this.browserManager.usePage(
        async (page) => {
          const plan = await prepareInput(normalized);
          readinessDeadline.throwIfExpired(
            "READINESS_TIMEOUT",
            `Readiness deadline (${normalized.readiness.timeoutMs}ms) elapsed before navigation started`,
          );
          await applyInput(page, plan, readinessDeadline.remainingMs());
          await preparePage(page, normalized);
          // Phase 3 readiness checks (fonts, images, network, selector,
          // custom conditions, settling) run here under the same deadline.
          readinessDeadline.throwIfExpired(
            "READINESS_TIMEOUT",
            `Readiness deadline (${normalized.readiness.timeoutMs}ms) elapsed before rendering started`,
          );

          const browserVersion = page.context().browser()?.version() ?? "unknown";
          const { bytes } = await documentRenderer.render({
            page,
            options: normalized,
            logger: log.child("render"),
          });
          const inspection = await inspectPdf(bytes);
          const report = buildQualityReport({
            durationMs: Date.now() - startedAt,
            mode: normalized.mode,
            browserVersion,
            inspection,
          });

          log.info("Conversion succeeded", {
            mode: report.mode,
            pages: report.pdf.pageCount,
            bytes: report.pdf.byteLength,
            durationMs: report.durationMs,
          });
          return new ConversionResult(bytes, report);
        },
        { viewport: normalized.viewport },
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
