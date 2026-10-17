import type { Page } from "playwright";
import type { QualityWarning } from "../quality/report.js";

export interface LayoutFindings {
  /** `window.innerWidth` at analysis time. */
  viewportWidth: number;
  /** `document.scrollingElement.scrollWidth`. */
  contentWidth: number;
  /** Content extending beyond the viewport to the right (0 when none). */
  horizontalOverflowPx: number;
  /** Elements with `position: fixed` or `position: sticky`. */
  fixedOrStickyElements: number;
  /** Scroll containers whose content exceeds their visible box. */
  scrollableContainers: number;
}

/**
 * Measures DOM geometry to flag screen-mode risks (horizontal overflow,
 * fixed/sticky elements, scroll containers). DOM-coordinate heuristics only.
 */
export async function analyzeScreenLayout(page: Page): Promise<LayoutFindings> {
  return page.evaluate((): LayoutFindings => {
    const scrollingElement = document.scrollingElement ?? document.documentElement;
    let fixedOrStickyElements = 0;
    let scrollableContainers = 0;

    for (const element of Array.from(document.querySelectorAll("*"))) {
      const style = window.getComputedStyle(element);
      if (style.position === "fixed" || style.position === "sticky") {
        fixedOrStickyElements += 1;
      }
      const overflowAxis = (axis: string): boolean =>
        axis === "auto" || axis === "scroll" || axis === "overlay";
      if (
        (overflowAxis(style.overflowX) || overflowAxis(style.overflowY)) &&
        (element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1)
      ) {
        scrollableContainers += 1;
      }
    }

    return {
      viewportWidth: window.innerWidth,
      contentWidth: scrollingElement.scrollWidth,
      horizontalOverflowPx: Math.max(0, scrollingElement.scrollWidth - window.innerWidth),
      fixedOrStickyElements,
      scrollableContainers,
    };
  });
}

/** Converts findings into heuristic quality warnings; empty when none fire. */
export function layoutWarnings(findings: LayoutFindings): QualityWarning[] {
  const warnings: QualityWarning[] = [];

  if (findings.horizontalOverflowPx > 0) {
    warnings.push({
      code: "layout.horizontal-overflow",
      source: "heuristic",
      message: `Content is ${findings.horizontalOverflowPx}px wider than the ${findings.viewportWidth}px viewport; the PDF may gain horizontal pages or clip wide elements`,
    });
  }
  if (findings.fixedOrStickyElements > 0) {
    warnings.push({
      code: "screen.fixed-elements",
      source: "heuristic",
      message: `${findings.fixedOrStickyElements} fixed/sticky element(s) present; they may repeat on every page or overlap content in the PDF`,
    });
  }
  if (findings.scrollableContainers > 0) {
    warnings.push({
      code: "screen.scrollable-containers",
      source: "heuristic",
      message: `${findings.scrollableContainers} scrolling container(s) hold content beyond their visible box; only the visible portion is captured`,
    });
  }

  return warnings;
}
