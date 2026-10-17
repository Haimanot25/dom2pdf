import { Dom2PdfError } from "../errors/index.js";
import {
  convertOptionsSchema,
  type ConvertOptions,
  type FidelityOptions,
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
  /** dom2pdf preserves colors/backgrounds by default (Chromium defaults to off). */
  pdfPrintBackground: true,
  /** Wait for fonts/images plus a short network quiet window before rendering. */
  readinessFonts: true,
  readinessImages: true,
  readinessNetworkIdleMs: 300,
  readinessSettleMs: 0,
  readinessSlowResourceMs: 10_000,
  readinessLazyLoad: true,
  /** Render-fidelity verification (visual comparison) runs sampled by default. */
  fidelityEnabled: true,
  fidelitySamplePages: 3,
  fidelityThreshold: 0.8,
  /** Failure forensics are opt-in: the bundle contains page content. */
  diagnosticsEnabled: false,
  /** Deterministic (byte-reproducible) output is opt-in. */
  deterministicEnabled: false,
  /** Object-aware pagination (keep tables/images whole across page breaks) is opt-in. */
  paginationKeepTogether: false,
  /** Per-conversion cap on http(s) requests. */
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
  /** Individual per-image patience in ms; `0` disables (block until `timeoutMs`). */
  slowResourceMs: number;
  /** Scroll-sweep for lazy-loaded content before the other checks. */
  lazyLoad: boolean;
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

export interface NormalizedFidelityOptions {
  enabled: boolean;
  /** Verify the first N pages, or every page with `"all"`. */
  samplePages: number | "all";
  /** Mean-SSIM threshold below which `render.fidelity` warns. */
  threshold: number;
}

export interface NormalizedRenderOptions {
  timeoutMs: number;
}

export interface NormalizedPaginationOptions {
  /** Keep page-fitting objects whole across page breaks (see `paginationSchema`). */
  keepTogether: boolean;
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
  pagination: NormalizedPaginationOptions;
  quality: NormalizedQualityOptions;
  fidelity: NormalizedFidelityOptions;
  /** Failure forensics: attach `details.diagnostics` to errors. */
  diagnostics: boolean;
  /** Deterministic (byte-reproducible) output: zero PDF date stamps in place. */
  deterministic: boolean;
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

/** Validates raw `convert()` options: unknown or reserved-but-unimplemented keys throw
 * `UNSUPPORTED_OPTION`; other invalid values and conflicts throw `INVALID_INPUT`. */
export function parseConvertOptions(raw: unknown): ConvertOptions {
  const result = convertOptionsSchema.safeParse(raw);
  if (result.success) {
    const parsed = result.data;
    // Reserved but not implemented; reject instead of silently downgrading behavior.
    if (parsed.outputPolicy !== undefined && parsed.outputPolicy.type !== "paper-fit") {
      throw new Dom2PdfError({
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
    throw new Dom2PdfError({
      code: "UNSUPPORTED_OPTION",
      message: `Unknown option${(unknownKeys.path ?? []).length > 0 ? ` at "${(unknownKeys.path ?? []).join(".")}"` : ""}: ${keys}`,
      details,
    });
  }

  throw new Dom2PdfError({
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

function normalizeFidelity(raw: FidelityOptions | undefined): NormalizedFidelityOptions {
  return {
    enabled: raw?.enabled ?? DEFAULTS.fidelityEnabled,
    samplePages: raw?.samplePages ?? DEFAULTS.fidelitySamplePages,
    threshold: raw?.threshold ?? DEFAULTS.fidelityThreshold,
  };
}

export function normalizeOptions(raw: unknown): NormalizedOptions {
  const parsed = parseConvertOptions(raw);
  const mode = parsed.mode ?? "document";

  return {
    input: parsed.input,
    mode,
    // parseConvertOptions rejected any other policy, so screen mode gets the sole implemented one.
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
      slowResourceMs: parsed.readiness?.slowResourceMs ?? DEFAULTS.readinessSlowResourceMs,
      lazyLoad: parsed.readiness?.lazyLoad ?? DEFAULTS.readinessLazyLoad,
      networkIdleMs: parsed.readiness?.networkIdleMs ?? DEFAULTS.readinessNetworkIdleMs,
      selector: parsed.readiness?.selector,
      settleMs: parsed.readiness?.settleMs ?? DEFAULTS.readinessSettleMs,
    },
    render: { timeoutMs: parsed.render?.timeoutMs ?? DEFAULTS.renderTimeoutMs },
    pagination: {
      keepTogether: parsed.pagination?.keepTogether ?? DEFAULTS.paginationKeepTogether,
    },
    quality: {
      minTextChars: parsed.quality?.minTextChars,
      minPages: parsed.quality?.minPages,
      maxPages: parsed.quality?.maxPages,
      maxBytes: parsed.quality?.maxBytes,
      failOnWarnings: parsed.quality?.failOnWarnings ?? false,
    },
    fidelity: normalizeFidelity(parsed.fidelity),
    diagnostics: parsed.diagnostics ?? DEFAULTS.diagnosticsEnabled,
    deterministic: parsed.deterministic ?? DEFAULTS.deterministicEnabled,
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
