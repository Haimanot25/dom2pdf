import { preparePage } from "../capture/prepare.js";
import { BrowserManager } from "../browser/manager.js";
import { normalizeOptions, type NormalizedOptions } from "../config/normalize.js";
import type { ConvertOptions } from "../config/schema.js";
import {
  attachDiagnostics,
  gatherDiagnostics,
  installDiagnosticsCapture,
  isCancellation,
  readAttachedDiagnostics,
} from "../diagnostics/collect.js";
import { isDom2PdfError, Dom2PdfError } from "../errors/index.js";
import { applyInput } from "../inputs/apply.js";
import { prepareInput } from "../inputs/resolve.js";
import { analyzeScreenLayout, layoutWarnings } from "../layout-analysis/analyze.js";
import { contentDigest, normalizePdfDates, type DeterminismReport } from "../pdf/determinism.js";
import { inspectPdf } from "../pdf/inspect.js";
import { fidelityDiagnostics, measureFidelity, type FidelityReport } from "../quality/fidelity.js";
import { assertQualityPolicy } from "../quality/policy.js";
import { buildQualityReport, type QualityCheck, type QualityWarning } from "../quality/report.js";
import { documentRenderer } from "../renderers/document.js";
import { screenRenderer } from "../renderers/screen.js";
import type { Renderer } from "../renderers/types.js";
import { describeReadiness, waitForReadiness, type ReadinessResult } from "../readiness/wait.js";
import { trackResources, type ResourceTracker } from "../readiness/tracking.js";
import { installRequestGuard, type RequestGuard } from "../security/request-guard.js";
import { raceWithAbort, throwIfAborted } from "../utils/cancellation.js";
import { Deadline } from "../utils/deadline.js";
import { createLogger, type Logger } from "../utils/logger.js";
import { sanitizeUrl } from "../utils/url.js";
import { ConversionResult } from "./result.js";
import type { Converter, ConvertResult, CreateConverterOptions } from "./types.js";

const DEFAULT_LAUNCH_TIMEOUT_MS = 60_000;
const LIST_PREVIEW_LIMIT = 3;

function rendererFor(mode: "document" | "screen"): Renderer {
  return mode === "screen" ? screenRenderer : documentRenderer;
}

function previewList(items: string[]): string {
  const shown = items.slice(0, LIST_PREVIEW_LIMIT).join(", ");
  return items.length > LIST_PREVIEW_LIMIT ? `${shown}, … (${items.length} total)` : shown;
}

/** Turns tracked resource traffic + image state into observed warnings/checks. */
function resourceDiagnostics(
  tracker: ResourceTracker,
  readiness: ReadinessResult,
): { warnings: QualityWarning[]; check: QualityCheck } {
  const issues = tracker.issues();
  const failed = issues.filter((issue) => issue.kind === "request-failed");
  const httpErrors = issues.filter((issue) => issue.kind === "http-error");
  const brokenImages = readiness.images.brokenUrls.map((url) => sanitizeUrl(url));
  const warnings: QualityWarning[] = [];

  if (failed.length > 0) {
    warnings.push({
      code: "resources.request-failed",
      source: "observed",
      message: `${failed.length} request(s) failed: ${previewList(
        failed.map((issue) => (issue.errorText !== undefined ? `${issue.url} (${issue.errorText})` : issue.url)),
      )}`,
    });
  }
  if (httpErrors.length > 0) {
    warnings.push({
      code: "resources.http-error",
      source: "observed",
      message: `${httpErrors.length} request(s) returned HTTP ≥ 400: ${previewList(
        httpErrors.map((issue) => `${issue.url} → ${String(issue.status ?? "?")}`),
      )}`,
    });
  }
  if (brokenImages.length > 0) {
    warnings.push({
      code: "resources.broken-images",
      source: "observed",
      message: `${brokenImages.length} <img> element(s) failed to load: ${previewList(brokenImages)}`,
    });
  }
  if (readiness.unavailableFonts.length > 0) {
    warnings.push({
      code: "resources.font-unavailable",
      source: "observed",
      message: `Font famil(ies) the browser reports as unavailable: ${previewList(readiness.unavailableFonts)}`,
    });
  }
  const slowImages = readiness.images.slowUrls.map((url) => sanitizeUrl(url));
  const slowImageSet = new Set(slowImages);
  // `stalledUrls` includes the slow images' own requests — keep each URL once.
  const stalledRequests = readiness.stalledUrls
    .map((url) => sanitizeUrl(url))
    .filter((url) => !slowImageSet.has(url));
  const slowAssets = slowImages.length + stalledRequests.length;
  if (slowAssets > 0) {
    const parts: string[] = [];
    if (slowImages.length > 0) parts.push(`${slowImages.length} image(s) still pending`);
    if (stalledRequests.length > 0) parts.push(`${stalledRequests.length} request(s) still in flight`);
    warnings.push({
      code: "resources.slow",
      source: "observed",
      message: `${parts.join(" and ")} after their individual patience — the PDF may render them blank or incomplete: ${previewList([...slowImages, ...stalledRequests])}`,
    });
  }
  if (readiness.lazy.truncated) {
    warnings.push({
      code: "resources.lazy-load-truncated",
      source: "heuristic",
      message: `The lazy-load sweep reached its step limit (${readiness.lazy.steps} steps); content added by infinite scroll beyond that may be missing images`,
    });
  }

  const problemCount = failed.length + httpErrors.length + brokenImages.length + slowAssets;
  const check: QualityCheck =
    problemCount === 0
      ? {
          id: "resources",
          status: "pass",
          detail: "no failed requests, HTTP errors, broken images, or slow resources",
        }
      : {
          id: "resources",
          status: "warn",
          detail: `${failed.length} failed request(s), ${httpErrors.length} HTTP error(s), ${brokenImages.length} broken image(s), ${slowAssets} slow asset(s)`,
          recommendation:
            "Check the URLs listed in the report warnings; missing assets render as placeholders in the PDF",
        };
  return { warnings, check };
}

class ConverterImpl implements Converter {
  private closed = false;
  private activeConversions = 0;

  constructor(
    private readonly browserManager: BrowserManager,
    private readonly logger: Logger,
    private readonly maxConcurrentConversions: number | undefined,
  ) {}

  async convert(options: ConvertOptions): Promise<ConvertResult> {
    if (this.closed) {
      throw new Dom2PdfError({ code: "CONVERTER_CLOSED", message: "Converter has been closed" });
    }

    const normalized = normalizeOptions(options);
    throwIfAborted(normalized.signal);

    // Fail-fast back-pressure: no queuing, so callers control their own
    // scheduling and never accumulate unbounded pending jobs.
    const max = this.maxConcurrentConversions;
    if (max !== undefined && this.activeConversions >= max) {
      throw new Dom2PdfError({
        code: "RESOURCE_LIMIT_EXCEEDED",
        message: `Concurrent conversion limit reached: this converter allows ${max} conversion(s) at a time`,
        details: { limit: "maxConcurrentConversions", max, active: this.activeConversions },
      });
    }
    this.activeConversions += 1;
    try {
      return await this.runConversion(normalized);
    } finally {
      this.activeConversions -= 1;
    }
  }

  private async runConversion(normalized: NormalizedOptions): Promise<ConvertResult> {
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
            const tracker = trackResources(page);
            // Failure forensics (opt-in): console/pageerror/network capture
            // from the first moment the page exists, attached to the error
            // when the conversion fails.
            const diagnosticsCapture = normalized.diagnostics ? installDiagnosticsCapture(page) : undefined;
            let guard: RequestGuard | undefined;
            try {
              const plan = await raceWithAbort(prepareInput(normalized), signal);
              // Second security layer: every request the page makes beyond the
              // pre-validated plan is classified at the network layer, and the
              // request cap aborts floods in-flight.
              guard = await installRequestGuard(page, {
                policy: {
                  allowLoopback: normalized.security.allowLoopback,
                  allowPrivateNetwork: normalized.security.allowPrivateNetwork,
                },
                validatedUrl: plan.kind === "navigate" ? plan.url : undefined,
                maxRequests: normalized.limits.maxRequests,
              });

              readinessDeadline.throwIfExpired(
                "READINESS_TIMEOUT",
                `Readiness deadline (${normalized.readiness.timeoutMs}ms) elapsed before navigation started`,
              );
              try {
                await raceWithAbort(applyInput(page, plan, readinessDeadline.remainingMs()), signal);
              } catch (cause) {
                // A policy-blocked redirect surfaces from `goto` as an
                // ordinary net error — or, when the blocked address is
                // unreachable, as the navigation deadline running out. The
                // typed verdict outranks either.
                if (
                  isDom2PdfError(cause) &&
                  (cause.code === "NAVIGATION_FAILED" || cause.code === "READINESS_TIMEOUT")
                ) {
                  await guard.drain();
                  if (guard.blockedRedirect !== undefined) throw guard.blockedRedirect;
                }
                throw cause;
              }
              await guard.drain();
              const blockedAfterNavigation = guard.failure();
              if (blockedAfterNavigation !== undefined) throw blockedAfterNavigation;

              const readiness = await raceWithAbort(
                waitForReadiness(page, normalized.readiness, readinessDeadline, tracker),
                signal,
              );
              await guard.drain();
              const blockedAfterReadiness = guard.failure();
              if (blockedAfterReadiness !== undefined) throw blockedAfterReadiness;
              await raceWithAbort(preparePage(page, normalized), signal);

              const warnings: QualityWarning[] = [];
              const checks: QualityCheck[] = [];

              checks.push({ id: "readiness", status: "pass", detail: describeReadiness(readiness) });
              const resources = resourceDiagnostics(tracker, readiness);
              checks.push(resources.check);
              warnings.push(...resources.warnings);

              if (normalized.mode === "screen" && normalized.outputPolicy !== undefined) {
                const findings = await raceWithAbort(analyzeScreenLayout(page), signal);
                warnings.push(...layoutWarnings(findings));
              }

              readinessDeadline.throwIfExpired(
                "READINESS_TIMEOUT",
                `Readiness deadline (${normalized.readiness.timeoutMs}ms) elapsed before rendering started`,
              );

              const browserVersion = page.context().browser()?.version() ?? "unknown";
              const renderer = rendererFor(normalized.mode);
              const renderStartedAt = Date.now();
              const { bytes: renderedBytes, metadata } = await renderer.render({
                page,
                options: normalized,
                logger: log.child("render"),
                signal,
              });
              const renderMs = Date.now() - renderStartedAt;

              if (metadata?.outputPolicy === "paper-fit") {
                checks.push({
                  id: "screen.output-policy",
                  status: "pass",
                  detail: `paper-fit: ${metadata.viewportWidth}px viewport scaled to ${Math.round(metadata.scale * 100)}% to fit ${metadata.paperLabel} content width`,
                });
              }

              await guard.drain();
              const blockedAfterRender = guard.failure();
              if (blockedAfterRender !== undefined) throw blockedAfterRender;
              const maxOutputBytes = normalized.limits.maxOutputBytes;
              if (maxOutputBytes !== undefined && renderedBytes.byteLength > maxOutputBytes) {
                throw new Dom2PdfError({
                  code: "RESOURCE_LIMIT_EXCEEDED",
                  message: `Generated PDF is ${renderedBytes.byteLength} bytes, exceeding limits.maxOutputBytes (${maxOutputBytes})`,
                  details: { limit: "maxOutputBytes", maxOutputBytes, byteLength: renderedBytes.byteLength },
                });
              }

              // Deterministic output (opt-in): zero the two PDF date stamps in
              // place — a byte-length-preserving rewrite — so repeated
              // conversions of the same input are byte-identical on the same
              // browser build. The content digest over extracted page text
              // lets callers verify "same content" independently of the
              // stamps; a date span that cannot be normalized is reported as
              // `determinism.residual`, never hidden.
              let bytes = renderedBytes;
              let deterministic: DeterminismReport | undefined;
              if (normalized.deterministic) {
                const normalizedPdf = normalizePdfDates(renderedBytes);
                bytes = normalizedPdf.bytes;
                deterministic = {
                  contentDigest: await raceWithAbort(contentDigest(bytes), signal),
                  normalizedSpans: normalizedPdf.normalizedSpans,
                  residual: normalizedPdf.residual,
                };
                checks.push({
                  id: "pdf.determinism",
                  status: deterministic.residual > 0 ? "warn" : "pass",
                  detail: `${deterministic.normalizedSpans} date span(s) zeroed in place; content digest sha256:${deterministic.contentDigest}${deterministic.residual > 0 ? `; ${deterministic.residual} span(s) left unnormalized` : ""}`,
                  ...(deterministic.residual > 0
                    ? { recommendation: "Output may not be byte-reproducible; inspect the PDF for date stamps outside /CreationDate and /ModDate" }
                    : {}),
                });
                if (deterministic.residual > 0) {
                  warnings.push({
                    code: "determinism.residual",
                    source: "observed",
                    message: `${deterministic.residual} date span(s) could not be normalized; byte-level output may not be reproducible`,
                  });
                }
              }

              const inspection = await raceWithAbort(inspectPdf(bytes, { extractText: true }), signal);
              const textStats = inspection.text;
              if (textStats === null) {
                throw new Dom2PdfError({
                  code: "PDF_VALIDATION_FAILED",
                  message: "Internal error: text extraction was requested but produced no stats",
                  details: { byteLength: inspection.byteLength },
                });
              }

              checks.push(
                textStats.totalChars > 0
                  ? {
                      id: "pdf-text",
                      status: "pass",
                      detail: `${textStats.totalChars} extractable character(s) across ${inspection.pageCount} page(s)`,
                    }
                  : {
                      id: "pdf-text",
                      status: "warn",
                      detail: "no extractable text found in the generated PDF",
                      recommendation:
                        "The document may be image-only, or fonts may have failed to render as text",
                    },
              );
              if (textStats.emptyPages.length > 0) {
                warnings.push({
                  code: "pdf.empty-pages",
                  source: "observed",
                  message: `page(s) ${previewList(textStats.emptyPages.map(String))} contain no extractable text (may be blank or image-only)`,
                });
              }

              // Render-fidelity verification: re-rasterize the PDF inside
              // Chromium (pdf.js) and compare sampled pages against live-page
              // screenshots taken under the same media emulation. The phase
              // degrades to `skipped` on infrastructure failure; only
              // cancellation propagates.
              let fidelity: FidelityReport | undefined;
              if (normalized.fidelity.enabled) {
                fidelity = await measureFidelity({
                  page,
                  bytes,
                  options: normalized,
                  screenScale: metadata?.scale,
                  signal,
                });
                const fidelityParts = fidelityDiagnostics(fidelity);
                checks.push(fidelityParts.check);
                warnings.push(...fidelityParts.warnings);
                // The capture-viewport resize may have triggered new requests;
                // drain and re-check the guard so policy verdicts still hold.
                await guard.drain();
                const blockedAfterFidelity = guard.failure();
                if (blockedAfterFidelity !== undefined) throw blockedAfterFidelity;
              }

              const report = buildQualityReport({
                durationMs: Date.now() - startedAt,
                mode: normalized.mode,
                browserVersion,
                inspection,
                timings: { readinessMs: readiness.durationMs, renderMs },
                checks: [
                  ...checks,
                  {
                    id: "security.requests",
                    status: "pass",
                    detail: `${guard.requestCount()} http(s) request(s) intercepted and checked against destination policy (limit ${normalized.limits.maxRequests})`,
                  },
                ],
                warnings,
                ...(fidelity !== undefined ? { fidelity } : {}),
                ...(deterministic !== undefined ? { deterministic } : {}),
              });

              assertQualityPolicy(
                normalized.quality,
                {
                  pageCount: report.pdf.pageCount,
                  byteLength: report.pdf.byteLength,
                  textChars: textStats.totalChars,
                  warningCodes: warnings.map((warning) => warning.code),
                },
                report,
              );

              log.info("Conversion succeeded", {
                mode: report.mode,
                pages: report.pdf.pageCount,
                bytes: report.pdf.byteLength,
                durationMs: report.durationMs,
                readinessMs: report.timings.readinessMs,
                renderMs: report.timings.renderMs,
                warnings: report.warnings.length,
              });
              return new ConversionResult(bytes, report);
            } catch (cause) {
              // Forensics are best effort: they never mask, delay, or replace
              // the original failure, and cancellation stays prompt.
              if (diagnosticsCapture !== undefined && !isCancellation(cause)) {
                let bundle;
                try {
                  bundle = await gatherDiagnostics(page, diagnosticsCapture);
                } catch (gatherCause) {
                  bundle = {
                    gatheredAtMs: Date.now(),
                    url: null,
                    console: diagnosticsCapture.console.map((entry) => ({ ...entry })),
                    pageErrors: [...diagnosticsCapture.pageErrors],
                    requests: diagnosticsCapture.requests.map((record) => ({ ...record })),
                    incomplete: [
                      `diagnostics gathering failed: ${gatherCause instanceof Error ? gatherCause.message : String(gatherCause)}`,
                    ],
                  };
                }
                attachDiagnostics(cause, bundle);
              }
              throw cause;
            } finally {
              await guard?.dispose();
              tracker.dispose();
              diagnosticsCapture?.dispose();
            }
          },
          {
            viewport: normalized.viewport,
            ...(normalized.browser.userAgent === undefined ? {} : { userAgent: normalized.browser.userAgent }),
            ...(signal !== undefined ? { signal } : {}),
          },
        ),
        signal,
      );
    } catch (cause) {
      if (cause instanceof Dom2PdfError) throw cause;
      // Plain failures are wrapped as BROWSER_FAILURE; carry any forensics
      // that were attached to the original cause onto the typed error.
      const diagnostics = readAttachedDiagnostics(cause);
      throw new Dom2PdfError({
        code: "BROWSER_FAILURE",
        message: `Unexpected conversion failure${cause instanceof Error ? `: ${cause.message}` : ""}`,
        cause,
        ...(diagnostics !== undefined ? { details: { diagnostics } } : {}),
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
  const maxConcurrentConversions = options.limits?.maxConcurrentConversions;
  if (
    maxConcurrentConversions !== undefined &&
    (!Number.isInteger(maxConcurrentConversions) || maxConcurrentConversions < 1)
  ) {
    throw new Dom2PdfError({
      code: "INVALID_INPUT",
      message: `limits.maxConcurrentConversions must be an integer ≥ 1; received ${String(maxConcurrentConversions)}`,
    });
  }
  const browserManager = new BrowserManager(
    {
      sandbox: options.browser?.sandbox ?? true,
      launchTimeoutMs: options.browser?.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    },
    logger.child("browser"),
  );
  return new ConverterImpl(browserManager, logger.child("converter"), maxConcurrentConversions);
}
