import type { Page, Response } from "playwright";
import { PageForgeError } from "../errors/index.js";
import { redactUrlCredentials, sanitizeUrl } from "../utils/url.js";
import { injectBaseHref, type InputPlan } from "./resolve.js";

function isTimeoutError(value: unknown): boolean {
  return value instanceof Error && value.name === "TimeoutError";
}

/**
 * Loads the planned input into the page within `timeoutMs`.
 *
 * - Navigation timeouts map to `READINESS_TIMEOUT` (they consume the overall
 *   readiness deadline).
 * - Other navigation failures map to `NAVIGATION_FAILED` with the cause kept.
 */
export async function applyInput(page: Page, plan: InputPlan, timeoutMs: number): Promise<void> {
  if (plan.kind === "navigate") {
    let response: Response | null;
    try {
      response = await page.goto(plan.url, { waitUntil: "load", timeout: timeoutMs });
    } catch (cause) {
      throw wrapNavigationFailure(cause, { url: sanitizeUrl(plan.url), source: plan.source, timeoutMs });
    }
    // Chromium's `goto` treats HTTP error statuses as successful navigations
    // (it would print the error body); PageForge surfaces them as failures
    // instead of silently producing a "successful" PDF of a 404 page.
    if (response !== null && response.status() >= 400) {
      throw new PageForgeError({
        code: "NAVIGATION_FAILED",
        message: `Navigation to ${sanitizeUrl(plan.url)} failed with HTTP ${response.status()}`,
        details: { url: sanitizeUrl(plan.url), source: plan.source, status: response.status() },
      });
    }
    return;
  }

  const html = plan.baseUrl !== undefined ? injectBaseHref(plan.html, plan.baseUrl) : plan.html;
  try {
    await page.setContent(html, { waitUntil: "load", timeout: timeoutMs });
  } catch (cause) {
    throw wrapNavigationFailure(
      cause,
      { input: "html", timeoutMs, ...(plan.baseUrl !== undefined ? { baseUrl: sanitizeUrl(plan.baseUrl) } : {}) },
    );
  }
}

function wrapNavigationFailure(cause: unknown, details: Record<string, unknown>): PageForgeError {
  if (cause instanceof PageForgeError) return cause;
  // Playwright net errors embed the request URL verbatim — credentials included.
  const message = redactUrlCredentials(cause instanceof Error ? cause.message : String(cause));
  if (isTimeoutError(cause)) {
    return new PageForgeError({
      code: "READINESS_TIMEOUT",
      message: `Page did not become ready within the deadline (${String(details["timeoutMs"])}ms): ${message}`,
      details: { stage: "navigation", ...details },
      cause,
    });
  }
  return new PageForgeError({
    code: "NAVIGATION_FAILED",
    message: `Failed to load input: ${message}`,
    details: { stage: "navigation", ...details },
    cause,
  });
}
