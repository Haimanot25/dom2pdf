import type { PdfInspection } from "../pdf/inspect.js";
import type { DeterminismReport } from "../pdf/determinism.js";
import type { FidelityReport } from "./fidelity.js";

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
  /** `observed` = directly measured; `heuristic` = best-effort estimate (DOM-based analysis). */
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
  /** Present when `fidelity.enabled` was on (`measured` or `skipped` with a reason). */
  fidelity?: FidelityReport;
  /** Present when `deterministic: true`: content digest plus the date-stamp rewrite counts. */
  deterministic?: DeterminismReport;
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
  /** Render-fidelity outcome; present when verification was enabled (measured or skipped). */
  fidelity?: FidelityReport;
  /** Determinism outcome; present when `deterministic: true` was set. */
  deterministic?: DeterminismReport;
}

/** Builds the report from measured values; `pdf-structure` is the only check added here,
 * the rest are contributed by the quality phase. */
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
    ...(input.fidelity !== undefined ? { fidelity: input.fidelity } : {}),
    ...(input.deterministic !== undefined ? { deterministic: input.deterministic } : {}),
  };
}
