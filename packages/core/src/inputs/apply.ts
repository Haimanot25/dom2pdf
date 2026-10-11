import type { Page } from "playwright";
import { PageForgeError } from "../errors/index.js";
import { sanitizeUrl } from "../utils/url.js";
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
    try {
      await page.goto(plan.url, { waitUntil: "load", timeout: timeoutMs });
    } catch (cause) {
      throw wrapNavigationFailure(cause, { url: sanitizeUrl(plan.url), source: plan.source, timeoutMs });
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
  const message = cause instanceof Error ? cause.message : String(cause);
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
