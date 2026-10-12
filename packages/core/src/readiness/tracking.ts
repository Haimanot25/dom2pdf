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
  /**
   * Epoch ms an http(s) request with this exact URL started, if it is still
   * in flight. Lets readiness apply *per-resource* patience (a resource that
   * started 12s ago is out of patience; one that started 200ms ago is not)
   * instead of one global stage deadline.
   */
  requestStartAt(url: string): number | undefined;
  /**
   * In-flight requests that started less than `maxAgeMs` ago. `undefined`
   * counts every in-flight request. Requests older than the per-resource
   * patience are presumed hung — they must not block network quiet, or a
   * single hanging asset would re-create the very deadline trap the patience
   * exists to avoid.
   */
  inFlightRecent(maxAgeMs: number | undefined): number;
  /**
   * Absolute URLs of in-flight requests that are at least `maxAgeMs` old —
   * the hung assets readiness stopped waiting for. Reported as `resources.slow`
   * warnings so giving up is visible, never silent. Empty when patience is
   * disabled (`maxAgeMs` undefined/0).
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
  const requestStarts = new Map<string, number>();
  let inFlight = 0;
  let lastActivityAt = Date.now();

  // Counting rules chosen so increments/decrements stay balanced across
  // redirects: `request` fires per hop, `response` fires per hop (including
  // `redirectResponse`), and `requestfailed` covers hops that die early.
  const onRequest = (request: Request): void => {
    if (!isHttpUrl(request.url())) return;
    inFlight += 1;
    requestStarts.set(request.url(), Date.now());
    lastActivityAt = Date.now();
  };
  const onSettled = (url: string): void => {
    inFlight = Math.max(0, inFlight - 1);
    requestStarts.delete(url);
    lastActivityAt = Date.now();
  };
  const onResponse = (response: Response): void => {
    if (!isHttpUrl(response.url())) return;
    onSettled(response.url());
    const url = response.url();
    if (response.status() >= 400 && !isFavicon(url)) {
      issues.push({ kind: "http-error", url: sanitizeUrl(url), status: response.status() });
    }
  };
  const onRequestFailed = (request: Request): void => {
    if (!isHttpUrl(request.url())) return;
    onSettled(request.url());
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
    requestStartAt: (url: string) => requestStarts.get(url),
    inFlightRecent: (maxAgeMs: number | undefined) => {
      if (maxAgeMs === undefined) return inFlight;
      const cutoff = Date.now() - maxAgeMs;
      let recent = 0;
      for (const startedAt of requestStarts.values()) {
        if (startedAt >= cutoff) recent += 1;
      }
      return recent;
    },
    stalledUrls: (maxAgeMs: number | undefined) => {
      if (maxAgeMs === undefined || maxAgeMs <= 0) return [];
      const cutoff = Date.now() - maxAgeMs;
      const stalled: string[] = [];
      for (const [url, startedAt] of requestStarts) {
        if (startedAt < cutoff) stalled.push(url);
      }
      return stalled;
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
