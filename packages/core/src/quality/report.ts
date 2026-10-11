import type { PdfInspection } from "../pdf/inspect.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skipped";

export interface QualityCheck {
  /** Stable identifier, e.g. `pdf-structure`. */
  id: string;
  status: CheckStatus;
  detail: string;
  /** Actionable suggestion when status is `warn` or `fail`. */
  recommendation?: string;
}

export interface QualityWarning {
  /** Stable identifier, e.g. `layout.horizontal-overflow`. */
  code: string;
  message: string;
  /**
   * `observed` = something was directly measured (a failed request, a parse
   * error). `heuristic` = a best-effort estimate (DOM-based layout analysis).
   */
  source: "observed" | "heuristic";
}

export interface QualityReport {
  status: "succeeded";
  /** Wall-clock time for the whole conversion. */
  durationMs: number;
  /** Wall-clock time of measured phases within the conversion. */
  timings: {
    /** Readiness phase: selector/fonts/images/network-idle/settle waits. */
    readinessMs: number;
    /** PDF generation (`page.pdf()`) itself. */
    renderMs: number;
  };
  mode: "document" | "screen";
  browser: { name: "chromium"; version: string };
  pdf: {
    byteLength: number;
    pageCount: number;
    headerVersion: string;
  };
  checks: QualityCheck[];
  warnings: QualityWarning[];
}

export interface QualityReportInput {
  durationMs: number;
  mode: "document" | "screen";
  browserVersion: string;
  inspection: PdfInspection;
  timings: { readinessMs: number; renderMs: number };
  /** Extra checks produced during the conversion (e.g. the output-policy check). */
  checks?: QualityCheck[];
  /** Observed or heuristic warnings gathered before rendering finished. */
  warnings?: QualityWarning[];
}

/**
 * Builds the structured report from *measured* values only.
 *
 * Text-extraction, resource, and layout checks are added by the quality phase;
 * every check that appears here has actually run.
 */
export function buildQualityReport(input: QualityReportInput): QualityReport {
  const { inspection } = input;
  return {
    status: "succeeded",
    durationMs: input.durationMs,
    timings: input.timings,
    mode: input.mode,
    browser: { name: "chromium", version: input.browserVersion },
    pdf: {
      byteLength: inspection.byteLength,
      pageCount: inspection.pageCount,
      headerVersion: inspection.headerVersion ?? "unknown",
    },
    checks: [
      {
        id: "pdf-structure",
        status: "pass",
        detail: `PDF parsed successfully: ${inspection.pageCount} page(s), ${inspection.byteLength} bytes, header %PDF-${inspection.headerVersion ?? "?"}`,
      },
      ...(input.checks ?? []),
    ],
    warnings: input.warnings ?? [],
  };
}
