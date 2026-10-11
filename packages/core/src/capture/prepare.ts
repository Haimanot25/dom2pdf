import type { Page } from "playwright";
import type { NormalizedOptions } from "../config/normalize.js";

/**
 * Prepares the page for rendering per the requested mode.
 *
 * Document mode renders with print CSS media. Playwright's `page.pdf()`
 * already defaults to print media; we set it explicitly so behavior does not
 * silently depend on the Playwright default and so screen mode (Phase 2) can
 * branch here.
 */
export async function preparePage(page: Page, options: NormalizedOptions): Promise<void> {
  if (options.mode === "document") {
    await page.emulateMedia({ media: "print" });
  }
}
