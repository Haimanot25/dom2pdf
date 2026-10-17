import type { Page, Request, Response } from "playwright";
import { sanitizeUrl } from "../utils/url.js";

/**
 * Must attach before navigation: listeners attached after `load` miss requests already in flight.
 * `/favicon.ico` is excluded from issues (browser's own probe) but still counts as activity.
 */

/** Read-only view of network activity used by the network-idle readiness check. */
export interface NetworkActivity {
  /** Epoch ms of the most recent observed http(s) request/response/failure. */
  lastActivityAt(): number;
  /** http(s) requests that started but have not received a response or failed. */
  inFlight(): number;
  /**
   * Epoch ms a request with this exact URL started, if still in flight;
   * used for per-resource patience rather than one global stage deadline.
   */
  requestStartAt(url: string): number | undefined;
  /**
   * In-flight requests started within `maxAgeMs`; `undefined` counts all.
   * Requests older than the patience are presumed hung and do not block network quiet.
   */
  inFlightRecent(maxAgeMs: number | undefined): number;
  /**
   * In-flight URLs at least `maxAgeMs` old, reported as `resources.slow` warnings.
   * Empty when patience is disabled (`maxAgeMs` undefined/0).
   */
  stalledUrls(maxAgeMs: number | undefined): string[];
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
  // Keyed by the `Request` object, never by URL: one URL can have several requests in flight
  // at once, and URL-keyed entries would overwrite start times and drop them on the first response.
  const inFlightStarts = new Map<Request, { url: string; startedAt: number }>();
  let inFlight = 0;
  let lastActivityAt = Date.now();

  // Counts balance across redirects: `request` and `response` fire per hop (including
  // `redirectResponse`), and each hop settles exactly the object it started with.
  const onRequest = (request: Request): void => {
    if (!isHttpUrl(request.url())) return;
    inFlight += 1;
    inFlightStarts.set(request, { url: request.url(), startedAt: Date.now() });
    lastActivityAt = Date.now();
  };
  const onSettled = (request: Request): void => {
    inFlight = Math.max(0, inFlight - 1);
    inFlightStarts.delete(request);
    lastActivityAt = Date.now();
  };
  const onResponse = (response: Response): void => {
    if (!isHttpUrl(response.url())) return;
    onSettled(response.request());
    const url = response.url();
    if (response.status() >= 400 && !isFavicon(url)) {
      issues.push({ kind: "http-error", url: sanitizeUrl(url), status: response.status() });
    }
  };
  const onRequestFailed = (request: Request): void => {
    if (!isHttpUrl(request.url())) return;
    onSettled(request);
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
    requestStartAt: (url: string) => {
      // Newest start among in-flight requests for this URL, so a fresh retry does not look stalled.
      let newest: number | undefined;
      for (const entry of inFlightStarts.values()) {
        if (entry.url === url && (newest === undefined || entry.startedAt > newest)) {
          newest = entry.startedAt;
        }
      }
      return newest;
    },
    inFlightRecent: (maxAgeMs: number | undefined) => {
      if (maxAgeMs === undefined) return inFlight;
      const cutoff = Date.now() - maxAgeMs;
      let recent = 0;
      for (const entry of inFlightStarts.values()) {
        if (entry.startedAt >= cutoff) recent += 1;
      }
      return recent;
    },
    stalledUrls: (maxAgeMs: number | undefined) => {
      if (maxAgeMs === undefined || maxAgeMs <= 0) return [];
      const cutoff = Date.now() - maxAgeMs;
      const stalled = new Set<string>();
      for (const entry of inFlightStarts.values()) {
        if (entry.startedAt < cutoff) stalled.add(entry.url);
      }
      return [...stalled];
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    },
  };
}
