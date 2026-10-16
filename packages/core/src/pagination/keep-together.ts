import type { Page } from "playwright";
import type { Logger } from "../utils/logger.js";

/**
 * Object-aware pagination pre-pass (`pagination.keepTogether`, opt-in).
 *
 * Chromium's print engine owns pagination, and the fragmentation rules it
 * actually honors are the CSS break properties — so this pass measures each
 * candidate exactly as print will lay it out (at `contentWidth / scale`,
 * independent of the live viewport) and marks only the objects that can fit
 * on one page:
 *
 * - Marked blocks get `break-inside: avoid`: page-fitting tables, figures,
 *   images, videos, code blocks, and standalone SVGs never straddle a page
 *   break (verified against this Chromium build).
 * - Every table row gets `break-inside: avoid`, so a row whose box would
 *   cross a page edge is pushed whole instead of being clipped there. Rows
 *   taller than a page still break — forced breaks override avoidance.
 * - Tables whose `<thead>` was overridden to `table-row-group` (the common
 *   responsive "don't repeat the header" trick) get a scoped rule restoring
 *   `table-header-group`, so headers repeat on continuation pages. Theads
 *   hidden with `display: none` are left alone — hiding them is intentional.
 *
 * Two measured constraints shape the design (both verified against this
 * Chromium build, not assumed):
 *
 * 1. An avoid block *taller than a page* is pushed to the next page and then
 *    overflows past the page edge — its overflowing content renders invisible.
 *    Candidates are therefore measured at the print layout width and skipped
 *    (counted as `skippedTooTall`) when they exceed 95% of the page budget.
 * 2. `break-after: avoid` (heading + following content) is not honored by
 *    this engine, so no heading rules are applied — shipping inert CSS would
 *    be an untested claim.
 *
 * The viewport is transiently resized to the print layout size for the
 * measurement and restored immediately after; in the common case the live
 * size already matches and no resize happens.
 *
 * Failure to apply is an enrichment loss, never a conversion failure: the
 * verdict comes back as `applied: false` with the reason (reported as a
 * `render.pagination` check with status `skipped`). Attribute marking is
 * inert without the stylesheet, so the CSS is injected last — a failure
 * before that point leaves the document completely untouched.
 */

export type PaginationHintsResult =
  | {
      applied: true;
      /** Objects marked to stay on one page (nested descendants are not re-counted). */
      marked: number;
      /** Visible candidates taller than one page — deliberately left to fragment normally. */
      skippedTooTall: number;
      /** Tables whose overridden `<thead>` group was restored so it repeats. */
      headerTables: number;
      /** One page's content height in unscaled CSS px — the height budget the marking used. */
      pageBudgetCssPx: number;
    }
  | {
      applied: false;
      /** Why the hints were not applied; reported verbatim in the `skipped` check. */
      reason: string;
    };

export interface PaginationPrepassInput {
  /** Viewport width print lays out at (`contentWidth / scale`), in CSS px. */
  printLayoutWidthCssPx: number;
  /** One page's content height in unscaled CSS px — the keep budget. */
  pageBudgetCssPx: number;
  /** `pdf.preferCSSPageSize`: the paper then comes from the page's `@page` rule, unknown before rendering. */
  preferCSSPageSize: boolean;
  logger: Logger;
}

/** Attribute marking objects that must stay on one page. */
const KEEP_ATTR = "data-dom2pdf-keep";
/** Attribute marking tables whose overridden thead group must repeat. */
const REPEAT_ATTR = "data-dom2pdf-repeat-header";
/** Slack (5% of the page budget) absorbing sub-pixel drift between measurement and print layout. */
const KEEP_THRESHOLD_FACTOR = 0.95;

const PAGINATION_CSS = `
[${KEEP_ATTR}] { break-inside: avoid; page-break-inside: avoid; }
tr { break-inside: avoid; page-break-inside: avoid; }
[${REPEAT_ATTR}] > thead { display: table-header-group; }
`;

interface MarkCounts {
  marked: number;
  skippedTooTall: number;
  headerTables: number;
}

/**
 * Runs inside the page (`page.evaluate`) — must stay fully self-contained:
 * Playwright serializes the function source, so it may not close over any
 * module scope (attribute names are spelled out as literals).
 *
 * Runs after `emulateMedia` has selected the conversion's media and, in
 * document mode, after the transient resize to the print layout width, so
 * the rectangles it measures are the ones print pagination will see.
 */
function markKeepCandidates(thresholdCssPx: number): MarkCounts {
  let marked = 0;
  let skippedTooTall = 0;
  let headerTables = 0;

  const isRendered = (element: Element): boolean => {
    if (element.getClientRects().length === 0) return false;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      // Fixed/sticky layers repeat or float above pagination; break rules are
      // meaningless there, so their contents are never marked.
      if (style.position === "fixed" || style.position === "sticky") return false;
    }
    return true;
  };

  // Array.from: this lib config has no DOM.Iterable, and NodeList is not iterable here.
  const candidates = Array.from(document.querySelectorAll("table, figure, img, video, pre, svg"));
  for (const element of candidates) {
    if (!isRendered(element)) continue;
    // An ancestor already kept whole covers this object (document order means
    // ancestors are visited first); counting it again would overstate the pass.
    if (element.closest("[data-dom2pdf-keep]") !== null) continue;
    const height = element.getBoundingClientRect().height;
    if (height <= 0) continue;
    if (height > thresholdCssPx) {
      skippedTooTall += 1;
      continue;
    }
    element.setAttribute("data-dom2pdf-keep", "");
    marked += 1;
  }

  const tables = Array.from(document.querySelectorAll("table"));
  for (const table of tables) {
    if (!isRendered(table)) continue;
    const thead = table.querySelector(":scope > thead");
    if (thead === null || thead.getClientRects().length === 0) continue;
    // Only the known "don't repeat the header" override is normalized;
    // anything else (including a deliberately hidden thead) is left as authored.
    if (getComputedStyle(thead).display !== "table-row-group") continue;
    table.setAttribute("data-dom2pdf-repeat-header", "");
    headerTables += 1;
  }

  return { marked, skippedTooTall, headerTables };
}

/**
 * Measures keep candidates at the print layout size, marks them, and injects
 * the print-fragmentation stylesheet. Always resolves with a verdict —
 * callers turn `applied: false` into a `skipped` check, never a failure.
 */
export async function applyPaginationHints(
  page: Page,
  input: PaginationPrepassInput,
): Promise<PaginationHintsResult> {
  const { printLayoutWidthCssPx, pageBudgetCssPx, preferCSSPageSize, logger } = input;
  if (preferCSSPageSize) {
    return {
      applied: false,
      reason:
        "pdf.preferCSSPageSize lets the page's @page rule choose the paper, so the one-page height budget cannot be known before rendering",
    };
  }

  const thresholdCssPx = pageBudgetCssPx * KEEP_THRESHOLD_FACTOR;
  let restoreViewport: { width: number; height: number } | undefined;
  try {
    const live = page.viewportSize();
    const targetWidth = Math.max(1, Math.round(printLayoutWidthCssPx));
    const targetHeight = Math.max(1, Math.round(pageBudgetCssPx));
    if (
      live !== null &&
      (Math.abs(live.width - targetWidth) > 1 || Math.abs(live.height - targetHeight) > 1)
    ) {
      // Measure exactly as print will lay the document out (media is already
      // emulated), then restore the live viewport so fidelity capture and the
      // caller's view of the page are unaffected.
      restoreViewport = live;
      await page.setViewportSize({ width: targetWidth, height: targetHeight });
      logger.debug("Pagination pre-pass measuring at print layout size", {
        width: targetWidth,
        height: targetHeight,
      });
    }

    const counts = await page.evaluate(markKeepCandidates, thresholdCssPx);
    // Marking is inert without the stylesheet, so injection comes last: a
    // failure before this point leaves the document exactly as it was.
    await page.addStyleTag({ content: PAGINATION_CSS });
    logger.debug("Keep-together applied", {
      marked: counts.marked,
      skippedTooTall: counts.skippedTooTall,
      headerTables: counts.headerTables,
      pageBudgetCssPx: Math.round(pageBudgetCssPx),
    });
    return { applied: true, ...counts, pageBudgetCssPx };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    logger.debug("Keep-together pre-pass could not be applied", { reason: message });
    return { applied: false, reason: `keep-together pre-pass failed: ${message}` };
  } finally {
    if (restoreViewport !== undefined) await page.setViewportSize(restoreViewport);
  }
}
