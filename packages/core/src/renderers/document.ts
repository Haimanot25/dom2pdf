import { computePrintGeometry } from "../capture/paper.js";
import { Dom2PdfError } from "../errors/index.js";
import { applyPaginationHints } from "../pagination/keep-together.js";
import { raceWithAbort } from "../utils/cancellation.js";
import { Deadline } from "../utils/deadline.js";
import { withTimeout } from "../utils/async.js";
import { finishAnimations } from "./animations.js";
import { buildPdfOptions } from "./pdf-options.js";
import type { RenderContext, RenderResult, Renderer } from "./types.js";

/**
 * Document renderer: Chromium print-to-PDF with print media.
 * `page.pdf()` accepts no timeout, so it is raced against the deadline; cancel/timeout closes the context to abort the CDP call.
 */
export const documentRenderer: Renderer = {
  mode: "document",
  async render({ page, options, logger, signal }: RenderContext): Promise<RenderResult> {
    const deadline = Deadline.in(options.render.timeoutMs);
    deadline.throwIfExpired(
      "RENDER_TIMEOUT",
      `Render deadline (${options.render.timeoutMs}ms) already elapsed before rendering started`,
    );

    const pdfOptions = buildPdfOptions(options.pdf);
    // `page.pdf()` lays out at contentWidth/scale and fits contentHeight/scale CSS px per page.
    const geometry = computePrintGeometry(options.pdf);
    logger.debug("Rendering PDF", { mode: "document", timeoutMs: options.render.timeoutMs });

    try {
      await finishAnimations(page);
      const pagination = options.pagination.keepTogether
        ? await applyPaginationHints(page, {
            printLayoutWidthCssPx: geometry.contentWidthPx / options.pdf.scale,
            pageBudgetCssPx: geometry.contentHeightPx / options.pdf.scale,
            preferCSSPageSize: options.pdf.preferCSSPageSize,
            logger,
          })
        : undefined;
      const bytes = await raceWithAbort(
        withTimeout(
          page.pdf(pdfOptions),
          deadline.remainingMs(),
          () =>
            new Dom2PdfError({
              code: "RENDER_TIMEOUT",
              message: `PDF rendering exceeded the ${options.render.timeoutMs}ms render deadline`,
              details: { stage: "render", mode: "document", timeoutMs: options.render.timeoutMs },
            }),
        ),
        signal,
      );
      return { bytes, ...(pagination !== undefined ? { pagination } : {}) };
    } catch (cause) {
      if (cause instanceof Dom2PdfError) throw cause;
      throw new Dom2PdfError({
        code: "BROWSER_FAILURE",
        message: `Chromium failed to generate the PDF${cause instanceof Error ? `: ${cause.message}` : ""}`,
        details: { stage: "render", mode: "document" },
        cause,
      });
    }
  },
};
