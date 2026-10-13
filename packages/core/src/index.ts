/** PageForge — HTML-to-PDF conversion engine built on Playwright's Chromium. */

export { createConverter } from "./api/converter.js";
export type { Converter, ConvertResult, ConvertOptions, CreateConverterOptions } from "./api/types.js";

export { PAPER_FORMATS } from "./config/schema.js";
export type { PaperFormat, FidelityOptions } from "./config/schema.js";

export { PageForgeError, ERROR_CODES, isPageForgeError, toPageForgeError } from "./errors/index.js";
export type { ErrorCode, PageForgeErrorOptions } from "./errors/index.js";

export { buildQualityReport } from "./quality/report.js";
export type { QualityReport, QualityCheck, QualityWarning, CheckStatus } from "./quality/report.js";
export type { FidelityReport, FidelityPageScore, SliceGeometry } from "./quality/fidelity.js";

export { inspectPdf } from "./pdf/inspect.js";
export type { PdfInspection, PdfTextStats } from "./pdf/inspect.js";

export { createLogger, createSilentLogger } from "./utils/logger.js";
export type { Logger, LoggerOptions, LogLevel, LogRecord } from "./utils/logger.js";

export { Deadline } from "./utils/deadline.js";
export { sanitizeUrl } from "./utils/url.js";

export { classifyIp } from "./security/destination-policy.js";
export type { DestinationPolicy, IpClassification, LocalFilePolicy } from "./security/destination-policy.js";
