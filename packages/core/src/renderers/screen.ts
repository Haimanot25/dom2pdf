import { computePaperFit, computePrintGeometry } from "../capture/paper.js";
import { Dom2PdfError } from "../errors/index.js";
import { applyPaginationHints } from "../pagination/keep-together.js";
import { raceWithAbort } from "../utils/cancellation.js";
import { Deadline } from "../utils/deadline.js";
import { withTimeout } from "../utils/async.js";
import { finishAnimations } from "./animations.js";
import { buildPdfOptions } from "./pdf-options.js";
import type { RenderContext, RenderResult, Renderer } from "./types.js";

/**
 * Screen renderer with the `paper-fit` policy: the viewport is scaled so its
 * width lands on the paper content width, then paginated at that scale.
 * Content narrower than the paper is never enlarged past 100%. Fixed/sticky
 * elements and scroll containers are reported as warnings, not removed.
 */
export const screenRenderer: Renderer = {
  mode: "screen",
  async render({ page, options, logger, signal }: RenderContext): Promise<RenderResult> {
    const deadline = Deadline.in(options.render.timeoutMs);
    deadline.throwIfExpired(
      "RENDER_TIMEOUT",
      `Render deadline (${options.render.timeoutMs}ms) already elapsed before rendering started`,
    );

    const fit = computePaperFit(options.pdf, options.viewport);
    // `pdf.scale` is rejected by schema validation in screen mode; `fit.scale` is the only scale source.
    const pdfOptions = { ...buildPdfOptions(options.pdf), scale: fit.scale };
    const geometry = computePrintGeometry(options.pdf);

    logger.debug("Rendering PDF", {
      mode: "screen",
      outputPolicy: "paper-fit",
      scale: fit.scale,
      paper: fit.paperLabel,
      viewportWidth: options.viewport.width,
    });

    try {
      await finishAnimations(page);
      const pagination = options.pagination.keepTogether
        ? await applyPaginationHints(page, {
            // Print lays out at contentWidth/scale; the fit scale maps that back onto the viewport width.
            printLayoutWidthCssPx: geometry.contentWidthPx / fit.scale,
            pageBudgetCssPx: geometry.contentHeightPx / fit.scale,
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
              details: { stage: "render", mode: "screen", timeoutMs: options.render.timeoutMs },
            }),
        ),
        signal,
      );
      return {
        bytes,
        ...(pagination !== undefined ? { pagination } : {}),
        metadata: {
          outputPolicy: "paper-fit",
          scale: fit.scale,
          paperLabel: fit.paperLabel,
          viewportWidth: options.viewport.width,
        },
      };
    } catch (cause) {
      if (cause instanceof Dom2PdfError) throw cause;
      throw new Dom2PdfError({
        code: "BROWSER_FAILURE",
        message: `Chromium failed to generate the PDF${cause instanceof Error ? `: ${cause.message}` : ""}`,
        details: { stage: "render", mode: "screen" },
        cause,
      });
    }
  },
};
