import { computePaperFit } from "../capture/paper.js";
import { Dom2PdfError } from "../errors/index.js";
import { raceWithAbort } from "../utils/cancellation.js";
import { Deadline } from "../utils/deadline.js";
import { withTimeout } from "../utils/async.js";
import { finishAnimations } from "./animations.js";
import { buildPdfOptions } from "./pdf-options.js";
import type { RenderContext, RenderResult, Renderer } from "./types.js";

/**
 * Screen-mode renderer with the `paper-fit` output policy: the page lays out
 * at the configured viewport under screen CSS, then is scaled so the viewport
 * width lands exactly on the paper's content width (margins excluded) and
 * paginates vertically at that scale.
 *
 * Content narrower than the paper is never enlarged past 100%. Fixed/sticky
 * elements and scroll containers are reported as warnings, not removed — DOM
 * mutation requires an explicit policy and is not part of this phase.
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
    // `pdf.scale` is rejected by schema validation in screen mode, so the
    // computed fit scale is the single source of truth here.
    const pdfOptions = { ...buildPdfOptions(options.pdf), scale: fit.scale };

    logger.debug("Rendering PDF", {
      mode: "screen",
      outputPolicy: "paper-fit",
      scale: fit.scale,
      paper: fit.paperLabel,
      viewportWidth: options.viewport.width,
    });

    try {
      await finishAnimations(page);
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
