import type { Page } from "playwright";
import type { Logger } from "../utils/logger.js";

/**
 * Object-aware pagination pre-pass (`pagination.keepTogether`, opt-in).
 *
 * Chromium's print engine honors the CSS break properties, so this pass
 * measures each candidate at the print layout size (`contentWidth / scale`)
 * and marks only objects that fit one page with `break-inside: avoid` —
 * tables, figures, images, videos, code blocks, standalone SVGs, and iframe
 * boxes. Candidates come from the document and every open shadow root
 * (closed roots are unreachable from page script and are not scanned).
 * Table rows are always avoid-marked (rows taller than a page still break),
 * and tables whose `<thead>` was overridden to `table-row-group` get the
 * repeat restored; `display: none` theads are left hidden.
 *
 * Two engine constraints shape the pass (verified against this Chromium
 * build): an avoid block taller than a page overflows invisibly past the
 * page edge, so over-tall candidates are skipped (counted as
 * `skippedTooTall`, 95% budget); `break-after: avoid` is not honored, so no
 * heading rules are applied.
 *
 * The stylesheet is a constructed stylesheet on `document.adoptedStyleSheets`
 * (adopted per shadow root), which CSP `style-src` without `unsafe-inline`
 * does not block — unlike `addStyleTag`/inline `<style>`. Failure to apply
 * is an enrichment loss: `applied: false` with the reason, reported as a
 * `render.pagination` check with status `skipped`, never a conversion
 * failure.
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
      /** Open shadow roots that received the stylesheet (their content cannot see the document's sheets). */
      shadowRoots: number;
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

/** Slack (5% of the page budget) absorbing sub-pixel drift between measurement and print layout. */
const KEEP_THRESHOLD_FACTOR = 0.95;

interface MarkCounts {
  marked: number;
  skippedTooTall: number;
  headerTables: number;
  shadowRoots: number;
}

/**
 * Runs inside the page (`page.evaluate`) — must stay fully self-contained:
 * Playwright serializes the function source, so it may not close over module
 * scope. Installs the constructed stylesheet first (root collection is
 * read-only, so an install failure touches nothing), and runs after media
 * emulation and the transient resize to the print layout width, so the
 * rectangles it measures are the ones print pagination sees.
 */
function applyKeepHints(thresholdCssPx: number): MarkCounts {
  // ---- 1. Collect roots: the document plus every open shadow root ---------
  const roots: Array<{ root: Document | ShadowRoot; candidates: Element[] }> = [];
  const seen = new Set<Document | ShadowRoot>();
  const collect = (root: Document | ShadowRoot): void => {
    if (seen.has(root)) return;
    seen.add(root);
    const candidates = Array.from(
      root.querySelectorAll("table, figure, img, video, pre, svg, iframe"),
    );
    // Shadow roots without candidates or rows still get walked for nested
    // roots, but need no stylesheet of their own.
    if (root === document || candidates.length > 0 || root.querySelectorAll("tr").length > 0) {
      roots.push({ root, candidates });
    }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node instanceof Element && node.shadowRoot !== null) collect(node.shadowRoot);
    }
  };
  collect(document);

  // ---- 2. Install one constructed stylesheet in every collected root ------
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
[data-dom2pdf-keep] { break-inside: avoid; page-break-inside: avoid; }
tr { break-inside: avoid; page-break-inside: avoid; }
[data-dom2pdf-repeat-header] > thead { display: table-header-group; }
`);
  let shadowRoots = 0;
  for (const entry of roots) {
    entry.root.adoptedStyleSheets = [...entry.root.adoptedStyleSheets, sheet];
    if (entry.root !== document) shadowRoots += 1;
  }

  let marked = 0;
  let skippedTooTall = 0;
  let headerTables = 0;

  /** Parent element, crossing a shadow boundary upward to the host. */
  const outerOf = (node: Element): Element | null => {
    const parent = node.parentElement;
    if (parent !== null) return parent;
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };

  const isRendered = (element: Element): boolean => {
    if (element.getClientRects().length === 0) return false;
    let node: Element | null = element;
    while (node !== null) {
      const style = getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
      // Fixed/sticky layers repeat or float above pagination; break rules do
      // not apply. The walk crosses shadow boundaries upward.
      if (style.position === "fixed" || style.position === "sticky") return false;
      node = outerOf(node);
    }
    return true;
  };

  // An ancestor already kept whole covers this object; `closest()` stops at
  // shadow boundaries, so kept hosts in outer roots cover their content too.
  const keptByAncestor = (element: Element): boolean => {
    if (element.closest("[data-dom2pdf-keep]") !== null) return true;
    let root = element.getRootNode();
    while (root instanceof ShadowRoot) {
      if (root.host.closest("[data-dom2pdf-keep]") !== null) return true;
      root = root.host.getRootNode();
    }
    return false;
  };

  for (const entry of roots) {
    // Array.from: this lib config has no DOM.Iterable, and NodeList is not iterable here.
    for (const element of entry.candidates) {
      if (!isRendered(element)) continue;
      if (keptByAncestor(element)) continue;
      const height = element.getBoundingClientRect().height;
      if (height <= 0) continue;
      if (height > thresholdCssPx) {
        skippedTooTall += 1;
        continue;
      }
      element.setAttribute("data-dom2pdf-keep", "");
      marked += 1;
    }

    const tables = Array.from(entry.root.querySelectorAll("table"));
    for (const table of tables) {
      if (!isRendered(table)) continue;
      const thead = table.querySelector(":scope > thead");
      if (thead === null || thead.getClientRects().length === 0) continue;
      // Only the "don't repeat the header" override is normalized; a thead
      // hidden with `display: none` stays hidden.
      if (getComputedStyle(thead).display !== "table-row-group") continue;
      table.setAttribute("data-dom2pdf-repeat-header", "");
      headerTables += 1;
    }
  }

  return { marked, skippedTooTall, headerTables, shadowRoots };
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
      // Measure at the print layout size, then restore the live viewport so
      // the fidelity capture and the caller's view are unaffected.
      restoreViewport = live;
      await page.setViewportSize({ width: targetWidth, height: targetHeight });
      logger.debug("Pagination pre-pass measuring at print layout size", {
        width: targetWidth,
        height: targetHeight,
      });
    }

    const counts = await page.evaluate(applyKeepHints, thresholdCssPx);
    logger.debug("Keep-together applied", {
      marked: counts.marked,
      skippedTooTall: counts.skippedTooTall,
      headerTables: counts.headerTables,
      shadowRoots: counts.shadowRoots,
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
