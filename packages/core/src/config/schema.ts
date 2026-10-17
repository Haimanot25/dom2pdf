import { z } from "zod";

/**
 * Runtime schema for `converter.convert(options)`. Every options object is
 * strict: unknown keys are rejected with `UNSUPPORTED_OPTION`. Cross-field
 * constraints live in `.superRefine` checks.
 */

export const PAPER_FORMATS = [
  "A0",
  "A1",
  "A2",
  "A3",
  "A4",
  "A5",
  "A6",
  "Letter",
  "Legal",
  "Tabloid",
  "Ledger",
] as const;

/** Chromium accepts lengths as `number` (CSS px) or strings with units (px, in, cm, mm). */
const LENGTH_PATTERN = /^\d+(?:\.\d+)?\s*(?:px|in|cm|mm)?$/;
const lengthSchema = z.union([
  z.string().min(1).regex(LENGTH_PATTERN, 'must be a positive length like 100, "100px", "10mm", "8.5in"'),
  z.number().positive(),
]);

/** Matches Chromium's `pageRanges` grammar: `1-5, 8, 11-13` (spaces allowed). */
const PAGE_RANGES_PATTERN = /^\s*\d+(?:-\d+)?(?:\s*,\s*\d+(?:-\d+)?)*\s*$/;

const marginSchema = z.strictObject({
  top: lengthSchema.optional(),
  right: lengthSchema.optional(),
  bottom: lengthSchema.optional(),
  left: lengthSchema.optional(),
});

export const pdfOptionsSchema = z
  .strictObject({
    /** Paper format. Defaults to A4 unless width/height are given. */
    format: z.enum(PAPER_FORMATS).optional(),
    /** Explicit paper width (e.g. `210`, `"210mm"`, `"8.5in"`). */
    width: lengthSchema.optional(),
    /** Explicit paper height. */
    height: lengthSchema.optional(),
    margin: marginSchema.optional(),
    landscape: z.boolean().optional(),
    /** Render scale, 0.1–2 (Chromium's supported range). */
    scale: z.number().min(0.1).max(2).optional(),
    /** dom2pdf defaults to `true` so backgrounds/colors survive. Chromium's own default is `false`. */
    printBackground: z.boolean().optional(),
    /** Give an author's CSS `@page` size priority over format/width/height. */
    preferCSSPageSize: z.boolean().optional(),
    /** e.g. `"1-5, 8, 11-13"`; omit to print every page. */
    pageRanges: z.string().min(1).optional(),
    displayHeaderFooter: z.boolean().optional(),
    headerTemplate: z.string().optional(),
    footerTemplate: z.string().optional(),
    /** Embed the document outline (headings) in the PDF. */
    outline: z.boolean().optional(),
    /** Ask Chromium for a tagged (structurally accessible) PDF. */
    tagged: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    const hasExplicitPaper = value.width !== undefined || value.height !== undefined;
    if (value.format !== undefined && hasExplicitPaper) {
      ctx.addIssue({
        code: "custom",
        message: "pdf.format cannot be combined with pdf.width/pdf.height — pick one paper-size strategy",
        path: ["format"],
      });
    }
    if (value.pageRanges !== undefined && !PAGE_RANGES_PATTERN.test(value.pageRanges)) {
      ctx.addIssue({
        code: "custom",
        message: `pdf.pageRanges must look like "1-5, 8, 11-13"; received "${value.pageRanges}"`,
        path: ["pageRanges"],
      });
    }
    if (value.headerTemplate !== undefined && value.displayHeaderFooter !== true) {
      ctx.addIssue({
        code: "custom",
        message: "pdf.headerTemplate requires pdf.displayHeaderFooter: true",
        path: ["headerTemplate"],
      });
    }
    if (value.footerTemplate !== undefined && value.displayHeaderFooter !== true) {
      ctx.addIssue({
        code: "custom",
        message: "pdf.footerTemplate requires pdf.displayHeaderFooter: true",
        path: ["footerTemplate"],
      });
    }
  });

export const viewportSchema = z.strictObject({
  width: z.number().int().min(1).max(10_000),
  height: z.number().int().min(1).max(10_000),
});

export const readinessSchema = z.strictObject({
  /**
   * Overall deadline (ms) for input preparation, navigation, and all
   * readiness checks — not per-stage. Exceeding it fails with
   * `READINESS_TIMEOUT`, naming the stage that gave out.
   */
  timeoutMs: z.number().int().positive().max(30 * 60_000).optional(),
  /** Await `document.fonts.ready` (in-flight web-font loads finish first). Default `true`. */
  fonts: z.boolean().optional(),
  /**
   * Font families with a matching `@font-face` that must load before
   * rendering. Failed declarations surface as `resources.font-unavailable`;
   * families with no declaration are not flagged (Chromium cannot
   * distinguish a system font from a fallback there).
   */
  waitForFonts: z.array(z.string().min(1).max(200)).max(20).optional(),
  /** Wait until every `<img>` has finished loading (failed images count as finished). Default `true`. */
  images: z.boolean().optional(),
  /**
   * Individual patience (ms) for a still-pending image; past it the
   * conversion proceeds with a `resources.slow` warning instead of spending
   * the shared deadline. `0` disables it (a pending image then blocks until
   * `timeoutMs`). Default `10000`.
   */
  slowResourceMs: z.number().int().min(0).max(300_000).optional(),
  /**
   * Sweep-scroll the page before the other checks to trigger lazy content
   * (`loading="lazy"` images/iframes, `data-src`-style markup) that would
   * otherwise render blank. Bounded by step count and the deadline.
   * Default `true`.
   */
  lazyLoad: z.boolean().optional(),
  /** Consider the page ready after this many ms without network activity. `0` disables. Default `300`. */
  networkIdleMs: z.number().int().min(0).max(60_000).optional(),
  /** Wait until this CSS selector matches at least one *visible* element. */
  selector: z.string().min(1).max(1_000).optional(),
  /** Extra quiet period (ms) after the other checks pass. Default `0`. */
  settleMs: z.number().int().min(0).max(60_000).optional(),
});

export const qualitySchema = z
  .strictObject({
    /** Minimum extractable (non-whitespace) characters in the generated PDF. */
    minTextChars: z.number().int().min(0).optional(),
    /** Fail when the PDF has fewer pages than this. */
    minPages: z.number().int().min(1).optional(),
    /** Fail when the PDF has more pages than this. */
    maxPages: z.number().int().min(1).optional(),
    /** Fail when the PDF is larger than this many bytes. */
    maxBytes: z.number().int().min(1).optional(),
    /** Fail when the report contains any warnings. */
    failOnWarnings: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.minPages !== undefined && value.maxPages !== undefined && value.minPages > value.maxPages) {
      ctx.addIssue({
        code: "custom",
        message: `quality.minPages (${value.minPages}) cannot exceed quality.maxPages (${value.maxPages})`,
        path: ["minPages"],
      });
    }
  });

export const fidelitySchema = z.strictObject({
  /**
   * Re-rasterize the PDF in Chromium (pdf.js) and compare sampled pages
   * against live-page screenshots under the same media emulation.
   * Default `true`.
   */
  enabled: z.boolean().optional(),
  /** How many PDF pages to verify (first N, 1–50, or `"all"`). Default `3`. */
  samplePages: z.union([z.number().int().min(1).max(50), z.literal("all")]).optional(),
  /**
   * Mean SSIM below which the `render.fidelity` check warns — a visual
   * comparison, not a pixel-perfectness claim. Range 0–1. Default `0.8`.
   */
  threshold: z.number().min(0).max(1).optional(),
});

export const limitsSchema = z.strictObject({
  /**
   * Maximum http(s) requests per conversion (the browser-probed favicon is
   * excluded); exceeding it aborts further requests and fails with
   * `RESOURCE_LIMIT_EXCEEDED`. Default `500`.
   */
  maxRequests: z.number().int().min(1).max(100_000).optional(),
  /**
   * Hard cap on generated PDF bytes, checked before inspection — fails the
   * conversion outright, unlike `quality.maxBytes`, an expectation checked
   * with the measured report.
   */
  maxOutputBytes: z.number().int().min(1).optional(),
});

export const renderSchema = z.strictObject({
  /** Deadline (ms) for PDF generation itself. */
  timeoutMs: z.number().int().positive().max(30 * 60_000).optional(),
});

export const paginationSchema = z.strictObject({
  /**
   * Keep tables, figures, images, videos, code blocks, and standalone SVGs
   * whole across page breaks when they fit one page; never clip a table row
   * at a page edge; repeat overridden table headers. Default `false`.
   */
  keepTogether: z.boolean().optional(),
});

export const securitySchema = z.strictObject({
  /** Allow `{ type: "file" }` input. Off by default. */
  allowLocalFiles: z.boolean().optional(),
  /** Directory allowlist; paths (after resolution, symlink-free) must live inside one of these. */
  allowedLocalDirectories: z.array(z.string().min(1)).optional(),
  /** Permit loopback destinations (localhost, 127.0.0.0/8, ::1). Off by default. */
  allowLoopback: z.boolean().optional(),
  /** Permit RFC1918/link-local/metadata destinations. Off by default. */
  allowPrivateNetwork: z.boolean().optional(),
});

export const convertBrowserSchema = z.strictObject({
  /**
   * User-Agent for every request. Default: this Chromium build's standard
   * `Chrome` UA (`HeadlessChrome` removed) — WAFs serve error pages to the
   * `HeadlessChrome` string. This changes the UA string only: TLS/HTTP2
   * fingerprints still identify an automated browser. Any string overrides
   * it exactly.
   */
  userAgent: z.string().min(1).max(512).optional(),
});

export const urlInputSchema = z.strictObject({
  type: z.literal("url"),
  url: z.string().min(1),
});

export const htmlInputSchema = z.strictObject({
  type: z.literal("html"),
  html: z.string(),
  /**
   * Optional http(s) base URL for resolving relative references in `html`.
   * Injected as `<base href>` unless the markup already declares one.
   */
  baseUrl: z.string().min(1).optional(),
});

export const fileInputSchema = z.strictObject({
  type: z.literal("file"),
  path: z.string().min(1),
});

export const inputSchema = z.discriminatedUnion("type", [urlInputSchema, htmlInputSchema, fileInputSchema]);

export const outputPolicySchema = z.strictObject({
  /**
   * How screen-mode output is produced: `paper-fit` (implemented) scales
   * the viewport to the paper width and paginates vertically; `viewport-pages`
   * and `full-content` are reserved and rejected with `UNSUPPORTED_OPTION`
   * until implemented.
   */
  type: z.enum(["paper-fit", "viewport-pages", "full-content"]),
});

export const convertOptionsSchema = z
  .strictObject({
    input: inputSchema,
    /**
     * Rendering mode. `document` (print CSS) is the default; `screen` renders
     * with screen CSS under the configured output policy.
     */
    mode: z.enum(["document", "screen"]).optional(),
    /** Screen-mode output policy. Defaults to `{ type: "paper-fit" }`. Document mode rejects it. */
    outputPolicy: outputPolicySchema.optional(),
    /** Browser viewport for layout. Independent of PDF paper size. */
    viewport: viewportSchema.optional(),
    pdf: pdfOptionsSchema.optional(),
    readiness: readinessSchema.optional(),
    render: renderSchema.optional(),
    /** Object-aware page breaks (keep tables/images whole). Off by default. */
    pagination: paginationSchema.optional(),
    /** Output policy: measured values are checked after rendering; violations fail with `QUALITY_POLICY_FAILED`. */
    quality: qualitySchema.optional(),
    /** Render-fidelity verification: visual comparison of the PDF against the source page. */
    fidelity: fidelitySchema.optional(),
    /**
     * Failure forensics: console messages, page errors, and network activity
     * (plus a screenshot and the DOM) attached as `details.diagnostics` on
     * failure. Off by default — the bundle contains page content; treat it
     * as sensitive.
     */
    diagnostics: z.boolean().optional(),
    /**
     * Zero the PDF date stamps in place so repeated conversions of the same
     * input are byte-identical on the same browser build. Off by default.
     */
    deterministic: z.boolean().optional(),
    /** Safety rails: network request and output size caps → `RESOURCE_LIMIT_EXCEEDED`. */
    limits: limitsSchema.optional(),
    security: securitySchema.optional(),
    /** Per-conversion browser presentation (User-Agent). */
    browser: convertBrowserSchema.optional(),
    /** Cooperative cancellation: the conversion fails fast with `CANCELLED` when aborted. */
    signal: z.instanceof(AbortSignal).optional(),
  })
  .superRefine((value, ctx) => {
    const mode = value.mode ?? "document";
    if (mode === "document" && value.outputPolicy !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "outputPolicy applies to screen mode only; remove it or set mode: \"screen\"",
        path: ["outputPolicy"],
      });
    }
    if (mode === "screen" && value.pdf?.scale !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "pdf.scale is computed by the screen-mode output policy and must not be set explicitly",
        path: ["pdf", "scale"],
      });
    }
    if (mode === "screen" && value.pdf?.preferCSSPageSize === true) {
      ctx.addIssue({
        code: "custom",
        message:
          "pdf.preferCSSPageSize cannot be combined with screen mode: the output policy owns the paper size",
        path: ["pdf", "preferCSSPageSize"],
      });
    }
  });

/** Options as accepted by `convert()` (everything optional except `input`). */
export type ConvertOptions = z.input<typeof convertOptionsSchema>;
/** Options after schema validation, before defaults are applied. */
export type ParsedConvertOptions = z.output<typeof convertOptionsSchema>;

export type InputOptions = z.output<typeof inputSchema>;
export type PdfOptions = z.output<typeof pdfOptionsSchema>;
export type SecurityOptions = z.output<typeof securitySchema>;
export type QualityOptions = z.output<typeof qualitySchema>;
export type FidelityOptions = z.output<typeof fidelitySchema>;
export type LimitsOptions = z.output<typeof limitsSchema>;
export type PaperFormat = (typeof PAPER_FORMATS)[number];
