import type { Page } from "playwright";
import type { NormalizedOptions } from "../config/normalize.js";

/** `page.pdf()` honors a prior `emulateMedia({ media: "screen" })` call, so screen mode
 * renders with screen CSS while document mode uses print CSS. */
export async function preparePage(page: Page, options: NormalizedOptions): Promise<void> {
  await page.emulateMedia({ media: options.mode === "screen" ? "screen" : "print" });
}
