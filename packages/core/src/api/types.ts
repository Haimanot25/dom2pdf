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
  /** Converts a URL, HTML string, or explicitly-permitted local file to PDF;
   * throws `Dom2PdfError` with a stable `code` on any failure. */
  convert(options: ConvertOptions): Promise<ConvertResult>;
  /** Closes the underlying browser. Idempotent. */
  close(): Promise<void>;
}

export interface CreateConverterOptions {
  browser?: {
    /** Chromium sandbox; defaults to `true` (enabled). Disable only where the OS
     * provides an equivalent boundary. */
    sandbox?: boolean;
    /** Launch timeout in ms (default 60000). */
    launchTimeoutMs?: number;
  };
  limits?: {
    /** Fail-fast cap on simultaneous conversions with `RESOURCE_LIMIT_EXCEEDED` (no queuing);
     * unlimited by default. Isolation is unaffected: each conversion gets its own context. */
    maxConcurrentConversions?: number;
  };
  /** Custom logger; defaults to a console logger at `warn` level. */
  logger?: Logger;
}
