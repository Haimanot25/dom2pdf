import type { ConvertOptions } from "../config/schema.js";
import type { Logger } from "../utils/logger.js";
import type { QualityReport } from "../quality/report.js";

export type { ConvertOptions };

export interface ConvertResult {
  /** The complete PDF file content. */
  bytes: Uint8Array;
  /** Structured quality report with measured values. */
  report: QualityReport;
  /** Writes the PDF to `path` (creating parent directories as needed). */
  save(path: string): Promise<void>;
}

export interface Converter {
  /**
   * Converts a URL, HTML string, or explicitly-permitted local file to PDF.
   * Throws `PageForgeError` with a stable `code` on any failure.
   */
  convert(options: ConvertOptions): Promise<ConvertResult>;
  /** Closes the underlying browser. Idempotent. */
  close(): Promise<void>;
}

export interface CreateConverterOptions {
  browser?: {
    /**
     * Chromium sandbox. Defaults to `true` (enabled). Only disable this in
     * controlled environments where the OS provides an equivalent boundary.
     */
    sandbox?: boolean;
    /** Launch timeout in ms (default 60000). */
    launchTimeoutMs?: number;
  };
  limits?: {
    /**
     * Fail-fast cap on conversions running at the same time on this converter
     * with `RESOURCE_LIMIT_EXCEEDED` (no queuing). Unlimited by default.
     * Isolation between jobs is unaffected: each conversion still gets its own
     * browser context.
     */
    maxConcurrentConversions?: number;
  };
  /** Custom logger; defaults to a console logger at `warn` level. */
  logger?: Logger;
}
