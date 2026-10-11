import type { Page, Request, Response } from "playwright";
import { sanitizeUrl } from "../utils/url.js";

/**
 * Observes subresource traffic during navigation so the quality report can
 * state, as fact, which requests failed or returned HTTP errors — and so the
 * readiness phase can wait for genuine network quiet. The tracker attaches
 * *before* navigation, which is the whole point: activity that started during
 * page parse is visible to it, whereas listeners attached after `load` would
 * miss requests already in flight.
 *
 * Only http(s) resources are tracked — `data:`/`blob:`/`about:` URLs have no
 * server outcome — and `/favicon.ico` is excluded from *issues* because the
 * browser probes it on its own and a 404 there says nothing about the
 * document being converted (it still counts as network activity).
 */

/** Read-only view of network activity used by the network-idle readiness check. */
export interface NetworkActivity {
  /** Epoch ms of the most recent observed http(s) request/response/failure. */
  lastActivityAt(): number;
  /** http(s) requests that started but have not received a response or failed. */
  inFlight(): number;
}

export interface ResourceIssue {
  kind: "request-failed" | "http-error";
  /** Sanitized URL (credentials redacted, fragment dropped). */
  url: string;
  /** HTTP status for `http-error` issues. */
  status?: number;
  /** Chromium failure text (e.g. `net::ERR_EMPTY_RESPONSE`) for `request-failed`. */
  errorText?: string;
}

export interface ResourceTracker extends NetworkActivity {
  /** Snapshot of issues observed so far. */
  issues(): ResourceIssue[];
  /** Detaches listeners. Safe to call more than once. */
  dispose(): void;
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

function isFavicon(url: string): boolean {
  try {
    return new URL(url).pathname === "/favicon.ico";
  } catch {
    return false;
  }
}

export function trackResources(page: Page): ResourceTracker {
  const issues: ResourceIssue[] = [];
  let inFlight = 0;
  let lastActivityAt = Date.now();

  // Counting rules chosen so increments/decrements stay balanced across
  // redirects: `request` fires per hop, `response` fires per hop (including
  // `redirectResponse`), and `requestfailed` covers hops that die early.
  const onRequest = (request: Request): void => {
    if (!isHttpUrl(request.url())) return;
    inFlight += 1;
    lastActivityAt = Date.now();
  };
  const onSettled = (): void => {
    inFlight = Math.max(0, inFlight - 1);
    lastActivityAt = Date.now();
  };
  const onResponse = (response: Response): void => {
    if (!isHttpUrl(response.url())) return;
    onSettled();
    const url = response.url();
    if (response.status() >= 400 && !isFavicon(url)) {
      issues.push({ kind: "http-error", url: sanitizeUrl(url), status: response.status() });
    }
  };
  const onRequestFailed = (request: Request): void => {
    if (!isHttpUrl(request.url())) return;
    onSettled();
    const url = request.url();
    if (isFavicon(url)) return;
    const errorText = request.failure()?.errorText;
    issues.push({
      kind: "request-failed",
      url: sanitizeUrl(url),
      ...(errorText !== undefined ? { errorText } : {}),
    });
  };

  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  let disposed = false;
  return {
    issues: () => [...issues],
    lastActivityAt: () => lastActivityAt,
    inFlight: () => inFlight,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    },
  };
}
