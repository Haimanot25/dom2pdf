import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "playwright";
import {
  attachDiagnostics,
  CONSOLE_ENTRIES_CAP,
  CONSOLE_TEXT_CAP,
  DOM_CAP_CHARS,
  gatherDiagnostics,
  GATHER_DEADLINE_MS,
  installDiagnosticsCapture,
  isCancellation,
  readAttachedDiagnostics,
  REQUESTS_CAP,
  type DiagnosticsBundle,
} from "../src/diagnostics/collect.js";
import { Dom2PdfError } from "../src/errors/index.js";

/**
 * Minimal structural stand-in for Playwright's Page: event emitter plus the
 * three gather targets. The capture only uses `on`/`off`, and gathering uses
 * `url`/`screenshot`/`content` — both are exercised for real here.
 */
class FakePage {
  private readonly handlers = new Map<string, Array<(event: unknown) => void>>();
  currentUrl = "https://example.test/page?q=1";
  screenshotOutcome: Buffer | "hang" | Error = Buffer.from("fake-jpeg-bytes");
  contentOutcome: string | "hang" = "<html><body>probe page</body></html>";

  on(event: string, handler: (event: unknown) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  off(event: string, handler: (event: unknown) => void): this {
    this.handlers.set(
      event,
      (this.handlers.get(event) ?? []).filter((entry) => entry !== handler),
    );
    return this;
  }

  emit(event: string, payload: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload);
  }

  listenerCount(event: string): number {
    return (this.handlers.get(event) ?? []).length;
  }

  url(): string {
    return this.currentUrl;
  }

  async screenshot(): Promise<Buffer> {
    if (this.screenshotOutcome === "hang") return new Promise<Buffer>(() => undefined);
    if (this.screenshotOutcome instanceof Error) throw this.screenshotOutcome;
    return this.screenshotOutcome;
  }

  async content(): Promise<string> {
    if (this.contentOutcome === "hang") return new Promise<string>(() => undefined);
    return this.contentOutcome;
  }
}

function asPage(fake: FakePage): Page {
  return fake as unknown as Page;
}

function consoleMessage(text: string, type = "log"): { type(): string; text(): string; location(): { url: string; lineNumber: number; columnNumber: number } } {
  return {
    type: () => type,
    text: () => text,
    location: () => ({ url: "https://example.test/app.js", lineNumber: 3, columnNumber: 9 }),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("installDiagnosticsCapture", () => {
  it("captures console messages, page errors, and requests with status and failure", () => {
    const fake = new FakePage();
    const capture = installDiagnosticsCapture(asPage(fake));

    fake.emit("console", consoleMessage("probe log"));
    fake.emit("console", consoleMessage("probe warn", "warning"));
    fake.emit("pageerror", new Error("uncaught boom"));

    const request = {
      url: () => "https://user:secret@example.test/api?x=1#frag",
      method: () => "GET",
      resourceType: () => "fetch",
    };
    fake.emit("request", request);
    fake.emit("response", { request: () => request, status: () => 500 });
    const failing = {
      url: () => "https://example.test/gone.png",
      method: () => "GET",
      resourceType: () => "image",
      failure: () => ({ errorText: "net::ERR_CONNECTION_REFUSED" }),
    };
    fake.emit("request", failing);
    fake.emit("requestfailed", failing);
    fake.emit("request", { url: () => "data:image/png;base64,AAAA", method: () => "GET", resourceType: () => "image" });

    expect(capture.console.map((entry) => entry.text)).toEqual(["probe log", "probe warn"]);
    expect(capture.console[1]?.type).toBe("warning");
    expect(capture.console[0]?.location).toContain("app.js");
    expect(capture.pageErrors).toEqual(["Error: uncaught boom"]);
    expect(capture.requests).toHaveLength(2); // data: URLs are not recorded
    expect(capture.requests[0]?.status).toBe(500);
    expect(capture.requests[0]?.url).not.toContain("secret"); // credentials redacted
    expect(capture.requests[0]?.url).not.toContain("#frag"); // fragment dropped
    expect(capture.requests[1]?.failureText).toBe("net::ERR_CONNECTION_REFUSED");
    expect(capture.droppedRequests).toBe(0);

    capture.dispose();
  });

  it("keeps a bounded ring buffer of console messages", () => {
    const fake = new FakePage();
    const capture = installDiagnosticsCapture(asPage(fake));
    for (let i = 0; i < CONSOLE_ENTRIES_CAP + 50; i += 1) {
      fake.emit("console", consoleMessage(`message ${i}`));
    }
    expect(capture.console).toHaveLength(CONSOLE_ENTRIES_CAP);
    expect(capture.console[0]?.text).toBe("message 50"); // oldest dropped
    expect(capture.console.at(-1)?.text).toBe(`message ${CONSOLE_ENTRIES_CAP + 49}`);
    capture.dispose();
  });

  it("caps overlong console text with a truncation marker", () => {
    const fake = new FakePage();
    const capture = installDiagnosticsCapture(asPage(fake));
    fake.emit("console", consoleMessage("x".repeat(CONSOLE_TEXT_CAP * 2)));
    expect(capture.console[0]?.text.length).toBeLessThanOrEqual(CONSOLE_TEXT_CAP + 20);
    expect(capture.console[0]?.text.startsWith("x".repeat(CONSOLE_TEXT_CAP))).toBe(true);
    expect(capture.console[0]?.text).toContain("[truncated]");
    capture.dispose();
  });

  it("counts requests beyond the cap instead of growing without bound", () => {
    const fake = new FakePage();
    const capture = installDiagnosticsCapture(asPage(fake));
    for (let i = 0; i < REQUESTS_CAP + 3; i += 1) {
      fake.emit("request", { url: () => `https://example.test/r${i}`, method: () => "GET", resourceType: () => "fetch" });
    }
    expect(capture.requests).toHaveLength(REQUESTS_CAP);
    expect(capture.droppedRequests).toBe(3);
    capture.dispose();
  });

  it("detaches every listener on dispose", () => {
    const fake = new FakePage();
    const capture = installDiagnosticsCapture(asPage(fake));
    expect(fake.listenerCount("console")).toBe(1);
    expect(fake.listenerCount("request")).toBe(1);
    capture.dispose();
    capture.dispose(); // idempotent
    expect(fake.listenerCount("console")).toBe(0);
    expect(fake.listenerCount("pageerror")).toBe(0);
    expect(fake.listenerCount("request")).toBe(0);
    expect(fake.listenerCount("response")).toBe(0);
    expect(fake.listenerCount("requestfailed")).toBe(0);
  });
});

describe("gatherDiagnostics", () => {
  it("snapshots captured state plus screenshot and DOM artifacts", async () => {
    const fake = new FakePage();
    const capture = installDiagnosticsCapture(asPage(fake));
    fake.emit("console", consoleMessage("before failure"));
    fake.emit("request", { url: () => "https://example.test/a.png", method: () => "GET", resourceType: () => "image" });

    const bundle = await gatherDiagnostics(asPage(fake), capture);
    expect(bundle.url).toBe("https://example.test/page?q=1");
    expect(bundle.console[0]?.text).toBe("before failure");
    expect(bundle.requests).toHaveLength(1);
    expect(bundle.screenshotJpegBase64).toBe(Buffer.from("fake-jpeg-bytes").toString("base64"));
    expect(bundle.dom).toContain("probe page");
    expect(bundle.incomplete).toBeUndefined();
    expect(bundle.gatheredAtMs).toBeGreaterThan(0);
    capture.dispose();
  });

  it("records a failed step in incomplete[] and keeps the rest", async () => {
    const fake = new FakePage();
    fake.screenshotOutcome = new Error("page is closed");
    const capture = installDiagnosticsCapture(asPage(fake));

    const bundle = await gatherDiagnostics(asPage(fake), capture);
    expect(bundle.screenshotJpegBase64).toBeUndefined();
    expect(bundle.dom).toContain("probe page");
    expect(bundle.incomplete?.[0]).toContain("screenshot unavailable: page is closed");
    capture.dispose();
  });

  it("truncates a huge DOM at the documented cap", async () => {
    const fake = new FakePage();
    fake.contentOutcome = `<html><body>${"d".repeat(DOM_CAP_CHARS)}</body></html>`;
    const capture = installDiagnosticsCapture(asPage(fake));

    const bundle = await gatherDiagnostics(asPage(fake), capture);
    expect(bundle.dom?.length).toBeLessThanOrEqual(DOM_CAP_CHARS + 80);
    expect(bundle.dom).toContain("DOM truncated");
    capture.dispose();
  });

  it("bounds hung artifact capture with the gather deadline", async () => {
    vi.useFakeTimers();
    const fake = new FakePage();
    fake.screenshotOutcome = "hang";
    fake.contentOutcome = "hang";
    const capture = installDiagnosticsCapture(asPage(fake));

    const pending = gatherDiagnostics(asPage(fake), capture);
    await vi.advanceTimersByTimeAsync(GATHER_DEADLINE_MS + 100);
    const bundle = await pending;
    expect(bundle.incomplete?.join(" ")).toContain("artifact capture exceeded");
    expect(bundle.console).toEqual([]); // captured state still reported
    capture.dispose();
  });
});

describe("attachDiagnostics / readAttachedDiagnostics", () => {
  it("merges the bundle into existing error details and round-trips", () => {
    const error = new Dom2PdfError({
      code: "RESOURCE_LIMIT_EXCEEDED",
      message: "cap hit",
      details: { limit: "maxRequests" },
    });
    const bundle: DiagnosticsBundle = {
      gatheredAtMs: 1,
      url: "https://example.test/",
      console: [],
      pageErrors: [],
      requests: [],
    };
    attachDiagnostics(error, bundle);
    expect(error.details?.["limit"]).toBe("maxRequests");
    expect(readAttachedDiagnostics(error)).toEqual(bundle);
  });

  it("also works on plain errors the converter wraps later", () => {
    const error = new Error("boom");
    const bundle: DiagnosticsBundle = { gatheredAtMs: 2, url: null, console: [], pageErrors: [], requests: [] };
    attachDiagnostics(error, bundle);
    expect(readAttachedDiagnostics(error)).toEqual(bundle);
  });

  it("ignores primitives and errors without a bundle", () => {
    expect(() => attachDiagnostics(null, { gatheredAtMs: 0, url: null, console: [], pageErrors: [], requests: [] })).not.toThrow();
    expect(readAttachedDiagnostics(undefined)).toBeUndefined();
    expect(readAttachedDiagnostics(new Error("no details"))).toBeUndefined();
  });
});

describe("isCancellation", () => {
  it("recognizes only CANCELLED typed errors", () => {
    expect(isCancellation(new Dom2PdfError({ code: "CANCELLED", message: "aborted" }))).toBe(true);
    expect(isCancellation(new Dom2PdfError({ code: "NAVIGATION_FAILED", message: "nope" }))).toBe(false);
    expect(isCancellation(new Error("plain"))).toBe(false);
  });
});
