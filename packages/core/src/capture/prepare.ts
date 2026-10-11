import type { Page } from "playwright";
import type { NormalizedOptions } from "../config/normalize.js";

/**
 * Prepares the page for rendering per the requested mode.
 *
 * - `document` renders with print CSS (author print styles apply).
 * - `screen` renders with screen CSS; Playwright's `page.pdf()` honors a prior
 *   `emulateMedia({ media: "screen" })` call (verified against playwright@1.64.0
 *   documentation).
 */
export async function preparePage(page: Page, options: NormalizedOptions): Promise<void> {
  await page.emulateMedia({ media: options.mode === "screen" ? "screen" : "print" });
}
