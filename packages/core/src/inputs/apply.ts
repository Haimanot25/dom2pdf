import type { Page, Response } from "playwright";
import { Dom2PdfError } from "../errors/index.js";
import { redactUrlCredentials, sanitizeUrl } from "../utils/url.js";
import { injectBaseHref, type InputPlan } from "./resolve.js";

function isTimeoutError(value: unknown): boolean {
  return value instanceof Error && value.name === "TimeoutError";
}

/**
 * Loads the planned input within `timeoutMs`, waiting on `domcontentloaded` only:
 * subresource settling belongs to the readiness phase. Timeouts map to
 * `READINESS_TIMEOUT`, other failures to `NAVIGATION_FAILED`.
 */
export async function applyInput(page: Page, plan: InputPlan, timeoutMs: number): Promise<void> {
  if (plan.kind === "navigate") {
    let response: Response | null;
    try {
      response = await page.goto(plan.url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch (cause) {
      throw wrapNavigationFailure(cause, { url: sanitizeUrl(plan.url), source: plan.source, timeoutMs });
    }
    // Playwright treats HTTP >= 400 as a successful navigation; status is checked explicitly.
    if (response !== null && response.status() >= 400) {
      throw new Dom2PdfError({
        code: "NAVIGATION_FAILED",
        message: `Navigation to ${sanitizeUrl(plan.url)} failed with HTTP ${response.status()}`,
        details: { url: sanitizeUrl(plan.url), source: plan.source, status: response.status() },
      });
    }
    return;
  }

  const html = plan.baseUrl !== undefined ? injectBaseHref(plan.html, plan.baseUrl) : plan.html;
  try {
    await page.setContent(html, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  } catch (cause) {
    throw wrapNavigationFailure(
      cause,
      { input: "html", timeoutMs, ...(plan.baseUrl !== undefined ? { baseUrl: sanitizeUrl(plan.baseUrl) } : {}) },
    );
  }
}

function wrapNavigationFailure(cause: unknown, details: Record<string, unknown>): Dom2PdfError {
  if (cause instanceof Dom2PdfError) return cause;
  // Playwright net errors embed the request URL verbatim, credentials included.
  const message = redactUrlCredentials(cause instanceof Error ? cause.message : String(cause));
  if (isTimeoutError(cause)) {
    return new Dom2PdfError({
      code: "READINESS_TIMEOUT",
      message: `Page did not become ready within the deadline (${String(details["timeoutMs"])}ms): ${message}`,
      details: { stage: "navigation", ...details },
      cause,
    });
  }
  return new Dom2PdfError({
    code: "NAVIGATION_FAILED",
    message: `Failed to load input: ${message}`,
    details: { stage: "navigation", ...details },
    cause,
  });
}
