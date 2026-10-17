import type { Page } from "playwright";
import type { NormalizedPdfOptions } from "../config/normalize.js";

/**
 * Builds the option object for Playwright's `page.pdf()`.
 * `undefined` fields fall back to Chromium's documented defaults (zero
 * margins, all pages, no header/footer).
 */
export function buildPdfOptions(pdf: NormalizedPdfOptions): NonNullable<Parameters<Page["pdf"]>[0]> {
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
