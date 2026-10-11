import type { Page } from "playwright";
import type { NormalizedPdfOptions } from "../config/normalize.js";
import { PageForgeError } from "../errors/index.js";
import { Deadline } from "../utils/deadline.js";
import { withTimeout } from "../utils/async.js";
import type { RenderContext, RenderResult, Renderer } from "./types.js";

/**
 * Builds the option object for Playwright's `page.pdf()`.
 *
 * Only options Playwright actually supports are passed through (verified
 * against playwright@1.64.0 types); `undefined` fields are left to Chromium's
 * documented defaults (zero margins, all pages, no header/footer).
 */
function buildPdfOptions(pdf: NormalizedPdfOptions): NonNullable<Parameters<Page["pdf"]>[0]> {
  return {
    format: pdf.format,
    width: pdf.width,
    height: pdf.height,
    margin: pdf.margin,
    landscape: pdf.landscape,
    scale: pdf.scale,
    printBackground: pdf.printBackground,
    preferCSSPageSize: pdf.preferCSSPageSize,
    pageRanges: pdf.pageRanges,
    displayHeaderFooter: pdf.displayHeaderFooter,
    headerTemplate: pdf.headerTemplate,
    footerTemplate: pdf.footerTemplate,
    outline: pdf.outline,
    tagged: pdf.tagged,
  };
}

/**
 * Document-mode renderer: Chromium's native print-to-PDF with print media.
 *
 * `page.pdf()` has no timeout parameter (verified against playwright@1.64.0),
 * so the render is raced against PageForge's own deadline; on timeout the
 * surrounding context close aborts the in-flight CDP call.
 */
export const documentRenderer: Renderer = {
  mode: "document",
  async render({ page, options, logger }: RenderContext): Promise<RenderResult> {
    const deadline = Deadline.in(options.render.timeoutMs);
    deadline.throwIfExpired(
      "RENDER_TIMEOUT",
      `Render deadline (${options.render.timeoutMs}ms) already elapsed before rendering started`,
    );

    const pdfOptions = buildPdfOptions(options.pdf);
    logger.debug("Rendering PDF", { mode: "document", timeoutMs: options.render.timeoutMs });

    let bytes: Uint8Array;
    try {
      bytes = await withTimeout(
        page.pdf(pdfOptions),
        deadline.remainingMs(),
        () =>
          new PageForgeError({
            code: "RENDER_TIMEOUT",
            message: `PDF rendering exceeded the ${options.render.timeoutMs}ms render deadline`,
            details: { stage: "render", mode: "document", timeoutMs: options.render.timeoutMs },
          }),
      );
    } catch (cause) {
      if (cause instanceof PageForgeError) throw cause;
      throw new PageForgeError({
        code: "BROWSER_FAILURE",
        message: `Chromium failed to generate the PDF${cause instanceof Error ? `: ${cause.message}` : ""}`,
        details: { stage: "render", mode: "document" },
        cause,
      });
    }

    return { bytes };
  },
};
