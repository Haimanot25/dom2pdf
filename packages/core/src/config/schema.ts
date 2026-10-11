import { z } from "zod";

/**
 * Runtime schema for `converter.convert(options)`.
 *
 * Every options object is a strict object: unknown keys are rejected with
 * `UNSUPPORTED_OPTION` (never silently ignored). Cross-field constraints live
 * in `.superRefine` checks so callers get one clear message per mistake.
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
    /** PageForge defaults to `true` so backgrounds/colors survive. Chromium's own default is `false`. */
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
   * Overall deadline (ms) covering input preparation, navigation, and all
   * readiness checks — not a per-stage budget.
   */
  timeoutMs: z.number().int().positive().max(30 * 60_000).optional(),
});

export const renderSchema = z.strictObject({
  /** Deadline (ms) for PDF generation itself. */
  timeoutMs: z.number().int().positive().max(30 * 60_000).optional(),
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
   * Credentials in the URL are rejected.
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
   * How screen-mode output is produced.
   *
   * - `paper-fit` (implemented): the viewport is scaled to fit the paper width
   *   and paginates vertically at that scale.
   * - `viewport-pages` (planned): one PDF page per viewport-sized region.
   * - `full-content` (planned): one very tall page containing everything.
   *
   * The planned values are reserved in the schema and rejected with
   * `UNSUPPORTED_OPTION` until implemented.
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
    security: securitySchema.optional(),
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
export type PaperFormat = (typeof PAPER_FORMATS)[number];
