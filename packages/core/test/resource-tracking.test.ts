import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page, Request, Response } from "playwright";
import { trackResources } from "../src/readiness/tracking.js";

/**
 * The tracker feeds every network verdict readiness makes (`inFlightRecent`
 * decides loading-vs-churn, `requestStartAt` applies per-resource patience,
 * `stalledUrls` reports what readiness gave up on). Its bookkeeping must
 * survive the same URL being requested more than once at the same time —
 * URL-keyed entries lost concurrent requests (one response deleted another
 * request's entry), which silently under-reported transfers and flipped
 * load-vs-churn verdicts under load.
 */
type Handler = (...args: unknown[]) => void;

function fakePage(): { page: Page; emit: (event: string, payload: unknown) => void } {
  const handlers = new Map<string, Handler[]>();
  const page = {
    on(event: string, handler: Handler): void {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    off(event: string, handler: Handler): void {
      handlers.set(event, (handlers.get(event) ?? []).filter((entry) => entry !== handler));
    },
  } as unknown as Page;
  return {
    page,
    emit: (event: string, payload: unknown) => {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
  };
}

function makeRequest(url: string): Request {
  return { url: () => url, failure: () => null } as unknown as Request;
}

function makeResponse(request: Request, url: string, status = 200): Response {
  return { url: () => url, status: () => status, request: () => request } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resource tracker: concurrent same-URL requests", () => {
  it("keeps every in-flight request of the same URL accounted for", () => {
    const { page, emit } = fakePage();
    const tracker = trackResources(page);
    const url = "https://cdn.example/poll.png";

    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const first = makeRequest(url);
    emit("request", first);
    vi.setSystemTime(1_000_050);
    const second = makeRequest(url);
    emit("request", second);

    // Both instances must be visible — URL-keyed entries stored only one.
    expect(tracker.inFlightRecent(10_000)).toBe(2);

    // The first response settles only the first request; the second is
    // still transferring. URL-keyed bookkeeping deleted BOTH here.
    vi.setSystemTime(1_000_100);
    emit("response", makeResponse(first, url));
    expect(tracker.inFlightRecent(10_000)).toBe(1);
    expect(tracker.inFlight()).toBe(1);
    expect(tracker.requestStartAt(url)).toBe(1_000_050);

    vi.setSystemTime(1_000_150);
    emit("response", makeResponse(second, url));
    expect(tracker.inFlightRecent(10_000)).toBe(0);
    expect(tracker.requestStartAt(url)).toBeUndefined();
  });

  it("reports a same-URL stall once, not once per instance", () => {
    const { page, emit } = fakePage();
    const tracker = trackResources(page);
    const url = "https://cdn.example/hung.png";

    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    emit("request", makeRequest(url));
    emit("request", makeRequest(url));

    vi.setSystemTime(2_000_000 + 15_000);
    expect(tracker.stalledUrls(10_000)).toEqual([url]);
    // Still counted as in-flight (both instances) for the network verdict.
    expect(tracker.inFlight()).toBe(2);
  });

  it("settles requests independently across URLs and records failures", () => {
    const { page, emit } = fakePage();
    const tracker = trackResources(page);

    const a = makeRequest("https://cdn.example/a.png");
    const b = makeRequest("https://cdn.example/b.png");
    emit("request", a);
    emit("request", b);

    emit("response", makeResponse(a, "https://cdn.example/a.png", 404));
    expect(tracker.inFlightRecent(10_000)).toBe(1);
    expect(tracker.requestStartAt("https://cdn.example/a.png")).toBeUndefined();
    expect(tracker.requestStartAt("https://cdn.example/b.png")).toBeGreaterThan(0);
    expect(tracker.issues()).toEqual([
      { kind: "http-error", url: "https://cdn.example/a.png", status: 404 },
    ]);

    // Same object identity as the `request` event delivered — Playwright
    // hands the identical Request to requestfailed.
    const failed = b as unknown as { failure: () => { errorText: string } };
    failed.failure = () => ({ errorText: "net::ERR_FAILED" });
    emit("requestfailed", b);
    expect(tracker.inFlight()).toBe(0);
    // The failed request must leave the in-flight map too (settled by
    // object, not by URL string — a string delete is a silent no-op here).
    expect(tracker.inFlightRecent(10_000)).toBe(0);
    expect(tracker.issues()).toEqual([
      { kind: "http-error", url: "https://cdn.example/a.png", status: 404 },
      { kind: "request-failed", url: "https://cdn.example/b.png", errorText: "net::ERR_FAILED" },
    ]);
  });
});
