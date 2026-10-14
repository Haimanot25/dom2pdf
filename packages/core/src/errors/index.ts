/**
 * Typed errors with stable, machine-readable codes.
 *
 * These codes are part of dom2pdf's public API contract: they are safe to
 * branch on programmatically. New codes may be added in minor releases;
 * existing codes are never renamed or removed within a major version.
 */

export const ERROR_CODES = [
  /** Input failed validation (malformed URL, bad types, out-of-range values). */
  "INVALID_INPUT",
  /** A recognized option is not supported (unknown key, not-yet-implemented value). */
  "UNSUPPORTED_OPTION",
  /** URL/destination rejected by security policy (protocol, private network, loopback). */
  "BLOCKED_URL",
  /** A redirect landed on a destination rejected by security policy. */
  "BLOCKED_REDIRECT",
  /** A sub-resource request was rejected by security policy. */
  "BLOCKED_RESOURCE",
  /** Local file access is disabled or the path is outside the allowed directories. */
  "LOCAL_FILE_NOT_ALLOWED",
  /** Navigation failed (DNS error, connection refused, HTTP-level failure, crash). */
  "NAVIGATION_FAILED",
  /** The overall readiness deadline elapsed before the page was ready. */
  "READINESS_TIMEOUT",
  /** PDF rendering exceeded its deadline. */
  "RENDER_TIMEOUT",
  /** Output failed PDF structural validation. */
  "PDF_VALIDATION_FAILED",
  /** A configured resource limit (bytes, pages, time, concurrency) was exceeded. */
  "RESOURCE_LIMIT_EXCEEDED",
  /** The conversion was cancelled via AbortSignal. */
  "CANCELLED",
  /** Chromium failed to launch or crashed during the conversion. */
  "BROWSER_FAILURE",
  /** The output was rejected by the configured quality policy. */
  "QUALITY_POLICY_FAILED",
  /** Operation attempted on a converter that has been closed. */
  "CONVERTER_CLOSED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface Dom2PdfErrorOptions {
  message: string;
  code: ErrorCode;
  /** Structured, sanitized context (never include credentials). */
  details?: Record<string, unknown>;
  /** The underlying error, preserved for debugging. */
  cause?: unknown;
}

/** All dom2pdf errors extend this class and carry a stable `code`. */
export class Dom2PdfError extends Error {
  override readonly name = "Dom2PdfError";
  readonly code: ErrorCode;
  /**
   * Structured, sanitized context. Set at construction; on failure paths it
   * may be extended afterwards with `details.diagnostics` (failure forensics,
   * opt-in via the `diagnostics` convert option).
   */
  details: Record<string, unknown> | undefined;

  constructor(options: Dom2PdfErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code;
    this.details = options.details;
  }

  toJSON(): { name: string; code: ErrorCode; message: string; details?: Record<string, unknown> } {
    return this.details === undefined
      ? { name: this.name, code: this.code, message: this.message }
      : { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Structural check so serialized/cross-realm errors still identify as dom2pdf errors. */
export function isDom2PdfError(value: unknown): value is Dom2PdfError {
  if (value instanceof Dom2PdfError) return true;
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as { code: unknown }).code === "string" &&
    (ERROR_CODES as readonly string[]).includes((value as { code: string }).code) &&
    "message" in value &&
    typeof (value as { message: unknown }).message === "string"
  );
}

/** Wraps an arbitrary error as a dom2pdf error, preserving dom2pdf errors as-is. */
export function toDom2PdfError(
  value: unknown,
  fallback: { code: ErrorCode; message: string },
): Dom2PdfError {
  if (value instanceof Dom2PdfError) return value;
  return new Dom2PdfError({ code: fallback.code, message: fallback.message, cause: value });
}
