import { PageForgeError } from "../errors/index.js";
import {
  convertOptionsSchema,
  type ConvertOptions,
  type InputOptions,
  type PaperFormat,
  type PdfOptions,
} from "./schema.js";

/** Defaults, documented in docs/modes.md and docs/api.md. */
export const DEFAULTS = {
  viewport: { width: 1280, height: 720 },
  readinessTimeoutMs: 30_000,
  renderTimeoutMs: 30_000,
  pdfFormat: "A4" as PaperFormat,
  pdfScale: 1,
  /** PageForge preserves colors/backgrounds by default (Chromium defaults to off). */
  pdfPrintBackground: true,
  /** Wait for fonts/images plus a short network quiet window before rendering. */
  readinessFonts: true,
  readinessImages: true,
  readinessNetworkIdleMs: 300,
  readinessSettleMs: 0,
  /** Safety rails on resource usage per conversion. */
  limitsMaxRequests: 500,
} as const;

export interface NormalizedViewport {
  width: number;
  height: number;
}

export type PdfLength = string | number;

/** PDF options with defaults filled in; absent fields fall back to Chromium behavior (e.g. zero margins). */
export interface NormalizedPdfOptions {
  format: PaperFormat | undefined;
  width: PdfLength | undefined;
  height: PdfLength | undefined;
  margin: { top?: PdfLength; right?: PdfLength; bottom?: PdfLength; left?: PdfLength } | undefined;
  landscape: boolean;
  scale: number;
  printBackground: boolean;
  preferCSSPageSize: boolean;
  pageRanges: string | undefined;
  displayHeaderFooter: boolean;
  headerTemplate: string | undefined;
  footerTemplate: string | undefined;
  outline: boolean;
  tagged: boolean;
}

export interface NormalizedReadinessOptions {
  timeoutMs: number;
  fonts: boolean;
  waitForFonts: string[];
  images: boolean;
  /** `0` disables the network-idle check. */
  networkIdleMs: number;
  selector: string | undefined;
  settleMs: number;
}

export interface NormalizedQualityOptions {
  minTextChars: number | undefined;
  minPages: number | undefined;
  maxPages: number | undefined;
  maxBytes: number | undefined;
  failOnWarnings: boolean;
}

export interface NormalizedRenderOptions {
  timeoutMs: number;
}

export interface NormalizedSecurityOptions {
  allowLocalFiles: boolean;
  allowedLocalDirectories: string[];
  allowLoopback: boolean;
  allowPrivateNetwork: boolean;
}

export interface NormalizedLimits {
  maxRequests: number;
  maxOutputBytes: number | undefined;
}

export interface NormalizedBrowserOptions {
  /** Explicit User-Agent override; `undefined` = the derived standard Chrome UA. */
  userAgent: string | undefined;
}

export interface NormalizedOptions {
  input: InputOptions;
  mode: "document" | "screen";
  /** Only present for screen mode; document mode rejects it. */
  outputPolicy: { type: "paper-fit" } | undefined;
  viewport: NormalizedViewport;
  pdf: NormalizedPdfOptions;
  readiness: NormalizedReadinessOptions;
  render: NormalizedRenderOptions;
  quality: NormalizedQualityOptions;
  limits: NormalizedLimits;
  security: NormalizedSecurityOptions;
  browser: NormalizedBrowserOptions;
  signal: AbortSignal | undefined;
}

interface ZodIssueLike {
  code?: unknown;
  path?: readonly (string | number)[];
  message?: unknown;
  keys?: readonly string[];
}

function serializeIssues(issues: readonly ZodIssueLike[]): Array<Record<string, unknown>> {
  return issues.map((issue) => ({
    code: issue.code,
    path: [...(issue.path ?? [])],
    message: issue.message,
    ...(issue.keys !== undefined ? { keys: [...issue.keys] } : {}),
  }));
}

/** Validates raw `convert()` options.
 *
 * - Unknown keys → `UNSUPPORTED_OPTION`
 * - Reserved-but-unimplemented values → `UNSUPPORTED_OPTION`
 * - Everything else (bad values, cross-field conflicts) → `INVALID_INPUT`
 */
export function parseConvertOptions(raw: unknown): ConvertOptions {
  const result = convertOptionsSchema.safeParse(raw);
  if (result.success) {
    const parsed = result.data;
    // Reserved output policies are valid schema values but not yet implemented;
    // reject them explicitly rather than silently downgrading behavior.
    if (parsed.outputPolicy !== undefined && parsed.outputPolicy.type !== "paper-fit") {
      throw new PageForgeError({
        code: "UNSUPPORTED_OPTION",
        message: `outputPolicy "${parsed.outputPolicy.type}" is reserved for a later phase; only "paper-fit" is implemented`,
        details: { outputPolicy: parsed.outputPolicy },
      });
    }
    return parsed;
  }
  const issues = result.error.issues as ZodIssueLike[];
  const details = { issues: serializeIssues(issues) };
  const first = issues[0];
  const firstPath = (first?.path ?? []).join(".") || "(root)";

  const unknownKeys = issues.find((issue) => issue.code === "unrecognized_keys");
  if (unknownKeys !== undefined) {
    const keys = (unknownKeys.keys ?? []).join(", ");
    throw new PageForgeError({
      code: "UNSUPPORTED_OPTION",
      message: `Unknown option${(unknownKeys.path ?? []).length > 0 ? ` at "${(unknownKeys.path ?? []).join(".")}"` : ""}: ${keys}`,
      details,
    });
  }

  throw new PageForgeError({
    code: "INVALID_INPUT",
    message: `Invalid conversion options: ${first?.message ?? "validation failed"} (at ${firstPath})`,
    details,
  });
}

function normalizePdf(raw: PdfOptions | undefined): NormalizedPdfOptions {
  const out: NormalizedPdfOptions = {
    // No explicit paper anywhere → default to A4.
    format: undefined,
    width: undefined,
    height: undefined,
    margin: undefined,
    landscape: false,
    scale: DEFAULTS.pdfScale,
    printBackground: DEFAULTS.pdfPrintBackground,
    preferCSSPageSize: false,
    pageRanges: undefined,
    displayHeaderFooter: false,
    headerTemplate: undefined,
    footerTemplate: undefined,
    outline: false,
    tagged: false,
  };
  if (raw === undefined) {
    out.format = DEFAULTS.pdfFormat;
    return out;
  }
  out.format =
    raw.format ?? (raw.width === undefined && raw.height === undefined ? DEFAULTS.pdfFormat : undefined);
  out.width = raw.width;
  out.height = raw.height;
  out.margin = raw.margin;
  out.landscape = raw.landscape ?? false;
  out.scale = raw.scale ?? DEFAULTS.pdfScale;
  out.printBackground = raw.printBackground ?? DEFAULTS.pdfPrintBackground;
  out.preferCSSPageSize = raw.preferCSSPageSize ?? false;
  out.pageRanges = raw.pageRanges;
  out.displayHeaderFooter = raw.displayHeaderFooter ?? false;
  out.headerTemplate = raw.headerTemplate;
  out.footerTemplate = raw.footerTemplate;
  out.outline = raw.outline ?? false;
  out.tagged = raw.tagged ?? false;
  return out;
}

/** Validates and applies all defaults. Throws typed errors for invalid input. */
export function normalizeOptions(raw: unknown): NormalizedOptions {
  const parsed = parseConvertOptions(raw);
  const mode = parsed.mode ?? "document";

  return {
    input: parsed.input,
    mode,
    // parseConvertOptions already rejects any policy other than paper-fit, so
    // screen mode always normalizes to the sole implemented policy.
    outputPolicy: mode === "screen" ? { type: "paper-fit" as const } : undefined,
    viewport: {
      width: parsed.viewport?.width ?? DEFAULTS.viewport.width,
      height: parsed.viewport?.height ?? DEFAULTS.viewport.height,
    },
    pdf: normalizePdf(parsed.pdf),
    readiness: {
      timeoutMs: parsed.readiness?.timeoutMs ?? DEFAULTS.readinessTimeoutMs,
      fonts: parsed.readiness?.fonts ?? DEFAULTS.readinessFonts,
      waitForFonts: [...(parsed.readiness?.waitForFonts ?? [])],
      images: parsed.readiness?.images ?? DEFAULTS.readinessImages,
      networkIdleMs: parsed.readiness?.networkIdleMs ?? DEFAULTS.readinessNetworkIdleMs,
      selector: parsed.readiness?.selector,
      settleMs: parsed.readiness?.settleMs ?? DEFAULTS.readinessSettleMs,
    },
    render: { timeoutMs: parsed.render?.timeoutMs ?? DEFAULTS.renderTimeoutMs },
    quality: {
      minTextChars: parsed.quality?.minTextChars,
      minPages: parsed.quality?.minPages,
      maxPages: parsed.quality?.maxPages,
      maxBytes: parsed.quality?.maxBytes,
      failOnWarnings: parsed.quality?.failOnWarnings ?? false,
    },
    limits: {
      maxRequests: parsed.limits?.maxRequests ?? DEFAULTS.limitsMaxRequests,
      maxOutputBytes: parsed.limits?.maxOutputBytes,
    },
    security: {
      allowLocalFiles: parsed.security?.allowLocalFiles ?? false,
      allowedLocalDirectories: [...(parsed.security?.allowedLocalDirectories ?? [])],
      allowLoopback: parsed.security?.allowLoopback ?? false,
      allowPrivateNetwork: parsed.security?.allowPrivateNetwork ?? false,
    },
    browser: { userAgent: parsed.browser?.userAgent },
    signal: parsed.signal,
  };
}
