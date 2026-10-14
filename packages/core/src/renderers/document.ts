import { Dom2PdfError } from "../errors/index.js";
import { raceWithAbort } from "../utils/cancellation.js";
import { Deadline } from "../utils/deadline.js";
import { withTimeout } from "../utils/async.js";
import { buildPdfOptions } from "./pdf-options.js";
import type { RenderContext, RenderResult, Renderer } from "./types.js";

/**
 * Document-mode renderer: Chromium's native print-to-PDF with print media.
 *
 * `page.pdf()` has no timeout parameter (verified against playwright@1.64.0),
 * so the render is raced against dom2pdf's own deadline; on timeout or
 * cancellation the surrounding context close aborts the in-flight CDP call.
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
    logger.debug("Rendering PDF", { mode: "document", timeoutMs: options.render.timeoutMs });

    try {
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
      return { bytes };
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
