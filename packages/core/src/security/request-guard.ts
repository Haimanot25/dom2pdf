import type { BrowserContext, Page, Request, Response as PlaywrightResponse, Route } from "playwright";
import { Dom2PdfError } from "../errors/index.js";
import { redactUrlCredentials, sanitizeUrl } from "../utils/url.js";
import {
  assertUrlDestinationAllowed,
  systemDnsLookup,
  type DestinationPolicy,
  type DnsLookup,
  type ResolvedAddress,
} from "./destination-policy.js";

/** Second SSRF layer: classifies requests after the input-side check, blocks
 * policy rejections at the network layer, and enforces the request cap. */
export interface RequestGuardOptions {
  /** Destination policy applied to every request beyond the pre-validated one. */
  policy: DestinationPolicy;
  /** Injectable DNS lookup (tests); results are cached per hostname. */
  dnsLookup?: DnsLookup;
  /** URL already validated by `prepareInput`; requested as-is (includes `file:` for local input). */
  validatedUrl?: string | undefined;
  /** Per-conversion cap on http(s) requests; `undefined` = unlimited. */
  maxRequests?: number | undefined;
}

export interface RequestGuard {
  /** First blocked HTTP redirect hop. */
  blockedRedirect: Dom2PdfError | undefined;
  /** First subresource (or popup/iframe request) rejected by policy. */
  blockedResource: Dom2PdfError | undefined;
  /** First page-scripted main-frame navigation rejected by policy. */
  blockedNavigation: Dom2PdfError | undefined;
  /** First applicable failure: security blocks first, then the request cap. */
  failure(): Dom2PdfError | undefined;
  /** Awaits in-flight redirect-hop classifications so `failure()` sees their verdicts. */
  drain(): Promise<void>;
  /** http(s) requests observed (favicon excluded), for report detail. */
  requestCount(): number;
  /** Detaches the response listener; the route dies with the context. Safe to call more than once. */
  dispose(): Promise<void>;
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

/** Same resource ignoring fragment (Chromium may add a trailing slash or drop `#hash`). */
function sameResource(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    const urlA = new URL(a);
    const urlB = new URL(b);
    urlA.hash = "";
    urlB.hash = "";
    return urlA.href === urlB.href;
  } catch {
    return false;
  }
}

/** Context teardown closes targets under in-flight handlers; only those errors are ignored. */
function isTeardownError(value: unknown): boolean {
  return (
    value instanceof Error &&
    (value.name === "TargetClosedError" || /Target closed|context destroyed|disposed/i.test(value.message))
  );
}

async function safeContinue(route: Route): Promise<void> {
  try {
    await route.continue();
  } catch (cause) {
    if (!isTeardownError(cause)) throw cause;
  }
}

async function safeAbort(route: Route): Promise<void> {
  try {
    await route.abort("blockedbyclient");
  } catch (cause) {
    if (!isTeardownError(cause)) throw cause;
  }
}

export async function installRequestGuard(page: Page, options: RequestGuardOptions): Promise<RequestGuard> {
  const context: BrowserContext = page.context();
  const maxRequests = options.maxRequests;

  let requestCount = 0;
  let limitHit = false;
  let blockedRedirect: Dom2PdfError | undefined;
  let blockedResource: Dom2PdfError | undefined;
  let blockedNavigation: Dom2PdfError | undefined;

  // One DNS lookup per hostname per conversion, so interception does not multiply DNS traffic.
  const dnsCache = new Map<string, Promise<ResolvedAddress[]>>();
  const lookup: DnsLookup = (hostname) => {
    const cached = dnsCache.get(hostname);
    if (cached !== undefined) return cached;
    const pending = (options.dnsLookup ?? systemDnsLookup)(hostname);
    dnsCache.set(hostname, pending);
    pending.catch(() => {
      dnsCache.delete(hostname);
    });
    return pending;
  };

  const handler = async (route: Route): Promise<void> => {
    const request: Request = route.request();
    const url = request.url();

    // data:/blob:/about: URLs never reach routes; the browser's own /favicon.ico probe is excluded from counting and classification.
    if (!isHttpUrl(url) || isFavicon(url)) {
      await safeContinue(route);
      return;
    }

    requestCount += 1;
    if (maxRequests !== undefined && requestCount > maxRequests) {
      limitHit = true;
      await safeAbort(route);
      return;
    }

    // Input-side classification already covered this URL (including file:); do not reclassify it.
    const validated = options.validatedUrl;
    if (validated !== undefined && sameResource(url, validated)) {
      await safeContinue(route);
      return;
    }

    try {
      await assertUrlDestinationAllowed(url, options.policy, lookup);
    } catch (cause) {
      const isPolicyRejection =
        cause instanceof Dom2PdfError &&
        (cause.code === "BLOCKED_URL" || cause.code === "INVALID_INPUT");
      if (!isPolicyRejection) {
        // Lookup failure, not a policy verdict: let the browser fail the request.
        await safeContinue(route);
        return;
      }

      const sanitized = sanitizeUrl(url);
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        if (request.redirectedFrom() !== null) {
          blockedRedirect ??= new Dom2PdfError({
            code: "BLOCKED_REDIRECT",
            message: `Redirected navigation was blocked by security policy: ${redactUrlCredentials(cause.message)}`,
            details: { ...(cause.details ?? {}), url: sanitized, kind: "redirect" },
            cause,
          });
        } else {
          blockedNavigation ??= new Dom2PdfError({
            code: "BLOCKED_URL",
            message: `Page attempted to navigate to a blocked destination: ${redactUrlCredentials(cause.message)}`,
            details: { ...(cause.details ?? {}), url: sanitized, kind: "page-navigation" },
            cause,
          });
        }
      } else {
        blockedResource ??= new Dom2PdfError({
          code: "BLOCKED_RESOURCE",
          message: `Subresource request was blocked by security policy: ${redactUrlCredentials(cause.message)}`,
          details: { ...(cause.details ?? {}), url: sanitized, kind: "subresource" },
          cause,
        });
      }
      await safeAbort(route);
      return;
    }

    await safeContinue(route);
  };

  await context.route("**/*", handler);

  // Playwright follows redirect hops inside Chromium's network stack, so `route` never sees them;
  // each hop's `Location` target is classified from response events instead.
  const pendingRedirectChecks = new Set<Promise<void>>();
  const classifyRedirectTarget = (target: string, isMainFrameNavigation: boolean): void => {
    const task = (async () => {
      try {
        await assertUrlDestinationAllowed(target, options.policy, lookup);
      } catch (cause) {
        // Lookup failures are left to the browser, as in the routed path.
        if (!(cause instanceof Dom2PdfError) || cause.code !== "BLOCKED_URL") return;
        const sanitized = sanitizeUrl(target);
        if (isMainFrameNavigation) {
          blockedRedirect ??= new Dom2PdfError({
            code: "BLOCKED_REDIRECT",
            message: `Redirect was blocked by security policy: ${redactUrlCredentials(cause.message)}`,
            details: { ...(cause.details ?? {}), url: sanitized, kind: "redirect" },
            cause,
          });
        } else {
          blockedResource ??= new Dom2PdfError({
            code: "BLOCKED_RESOURCE",
            message: `Subresource redirect was blocked by security policy: ${redactUrlCredentials(cause.message)}`,
            details: { ...(cause.details ?? {}), url: sanitized, kind: "subresource-redirect" },
            cause,
          });
        }
      }
    })();
    pendingRedirectChecks.add(task);
    void task
      .catch(() => undefined)
      .finally(() => {
        pendingRedirectChecks.delete(task);
      });
  };

  const onResponse = (response: PlaywrightResponse): void => {
    const status = response.status();
    if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) return;
    const request = response.request();
    if (isFavicon(request.url())) return;
    const location = response.headers()["location"];
    if (location === undefined || location.length === 0) return;
    let target: string;
    try {
      target = new URL(location, response.url()).toString();
    } catch {
      // Malformed Location cannot be classified; Chromium fails the request itself.
      return;
    }
    // Non-http targets (file:, javascript:, …) are classified too: a typed verdict is recorded
    // even though Chromium refuses most of them natively.
    const validated = options.validatedUrl;
    if (validated !== undefined && sameResource(target, validated)) return;
    const isMainFrameNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
    classifyRedirectTarget(target, isMainFrameNavigation);
  };
  page.on("response", onResponse);

  let disposed = false;
  return {
    get blockedRedirect() {
      return blockedRedirect;
    },
    get blockedResource() {
      return blockedResource;
    },
    get blockedNavigation() {
      return blockedNavigation;
    },
    failure(): Dom2PdfError | undefined {
      if (blockedRedirect !== undefined) return blockedRedirect;
      if (blockedResource !== undefined) return blockedResource;
      if (blockedNavigation !== undefined) return blockedNavigation;
      if (limitHit) {
        return new Dom2PdfError({
          code: "RESOURCE_LIMIT_EXCEEDED",
          message: `Request limit reached: a conversion may make at most ${String(maxRequests)} http(s) request(s) — raise limits.maxRequests for widget/ad-dense pages`,
          details: { limit: "maxRequests", maxRequests, counted: requestCount },
        });
      }
      return undefined;
    },
    requestCount: () => requestCount,
    drain: async () => {
      while (pendingRedirectChecks.size > 0) {
        await Promise.allSettled([...pendingRedirectChecks]);
      }
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      // No `context.unroute`: its teardown waits for in-flight paused requests
      // and would stall cleanup; the route dies with the per-conversion context.
      page.off("response", onResponse);
    },
  };
}
