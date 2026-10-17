import type { NormalizedQualityOptions } from "../config/normalize.js";
import { Dom2PdfError } from "../errors/index.js";
import type { QualityReport } from "./report.js";

/** Compares measured output against caller-declared expectations. Violations fail the conversion
 * with `QUALITY_POLICY_FAILED` (CLI exit code 4) and carry `details.violations` and `details.report`. */

export interface QualityMetrics {
  pageCount: number;
  byteLength: number;
  /** Extractable (non-whitespace) characters in the generated PDF. */
  textChars: number;
  /** Warning codes recorded in the report, in order. */
  warningCodes: string[];
}

export interface QualityViolation {
  /** Stable option name the violation came from, e.g. `minTextChars`. */
  rule: string;
  message: string;
}

export function qualityViolations(
  policy: NormalizedQualityOptions,
  metrics: QualityMetrics,
): QualityViolation[] {
  const violations: QualityViolation[] = [];

  if (policy.minTextChars !== undefined && metrics.textChars < policy.minTextChars) {
    violations.push({
      rule: "minTextChars",
      message: `expected at least ${policy.minTextChars} extractable characters, measured ${metrics.textChars}`,
    });
  }
  if (policy.minPages !== undefined && metrics.pageCount < policy.minPages) {
    violations.push({
      rule: "minPages",
      message: `expected at least ${policy.minPages} page(s), measured ${metrics.pageCount}`,
    });
  }
  if (policy.maxPages !== undefined && metrics.pageCount > policy.maxPages) {
    violations.push({
      rule: "maxPages",
      message: `expected at most ${policy.maxPages} page(s), measured ${metrics.pageCount}`,
    });
  }
  if (policy.maxBytes !== undefined && metrics.byteLength > policy.maxBytes) {
    violations.push({
      rule: "maxBytes",
      message: `expected at most ${policy.maxBytes} bytes, measured ${metrics.byteLength}`,
    });
  }
  if (policy.failOnWarnings && metrics.warningCodes.length > 0) {
    violations.push({
      rule: "failOnWarnings",
      message: `conversion produced ${metrics.warningCodes.length} warning(s): ${metrics.warningCodes.join(", ")}`,
    });
  }

  return violations;
}

/** Throws `QUALITY_POLICY_FAILED` with `details.violations` and `details.report` when any rule is violated. */
export function assertQualityPolicy(
  policy: NormalizedQualityOptions,
  metrics: QualityMetrics,
  report: QualityReport,
): void {
  const violations = qualityViolations(policy, metrics);
  if (violations.length === 0) return;
  throw new Dom2PdfError({
    code: "QUALITY_POLICY_FAILED",
    message: `Output rejected by quality policy: ${violations.map((violation) => violation.message).join("; ")}`,
    details: { violations, report },
  });
}
