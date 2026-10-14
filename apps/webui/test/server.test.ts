import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Dom2PdfError, type ConvertOptions, type QualityReport } from "dom2pdf-js";
import { createWebServer, statusForError, type WebConverter } from "../src/server.js";

const fakeReport: QualityReport = {
  status: "succeeded",
  durationMs: 1234,
  timings: { readinessMs: 800, renderMs: 400 },
  mode: "document",
  browser: { name: "chromium", version: "156.0.0.0" },
  pdf: { byteLength: 4, pageCount: 2, headerVersion: "1.4" },
  checks: [{ id: "pdf-structure", status: "pass", detail: "parsed" }],
  warnings: [{ code: "SCREEN_FIXED_PIXELS", message: "px widths", source: "heuristic" }],
};

interface FakeState {
  calls: ConvertOptions[];
  throw?: unknown;
}

function fakeConverter(state: FakeState): WebConverter {
  return {
    async convert(options: ConvertOptions) {
      state.calls.push(options);
      if (state.throw !== undefined) throw state.throw;
      return { bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), report: fakeReport };
    },
    async close() {},
  };
}

let base = "";
let state: FakeState;
let calls: ConvertOptions[];

async function start(state_: FakeState): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createWebServer({ converter: fakeConverter(state_) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let stop: (() => Promise<void>) | undefined;

beforeEach(async () => {
  state = { calls: [] };
  calls = state.calls;
  const started = await start(state);
  base = started.url;
  stop = started.close;
});

afterEach(async () => {
  await stop?.();
});

describe("dom2pdf-web server", () => {
  it("serves the UI on GET /", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = (await res.text()) as string;
    expect(html).toContain("dom2pdf");
    expect(html).toContain("/api/convert");
    expect(html).toContain("Convert to PDF");
  });

  it("converts a URL and returns base64 PDF plus the quality report", async () => {
    const res = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", mode: "screen", format: "Letter" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pdf: string; report: QualityReport };
    expect(Buffer.from(body.pdf, "base64").toString("binary")).toBe("%PDF");
    expect(body.report.pdf.pageCount).toBe(2);
    expect(body.report.warnings).toHaveLength(1);

    expect(calls).toHaveLength(1);
    const options = calls[0] as ConvertOptions;
    expect(options.input).toEqual({ type: "url", url: "https://example.com" });
    expect(options.mode).toBe("screen");
    expect(options.pdf).toEqual({ format: "Letter" });
    // Always-on forensics so the error card can show what failed.
    expect(options.diagnostics).toBe(true);
    // Deny-by-default: no security block unless the server was started with flags.
    expect(options.security).toBeUndefined();
  });

  it("passes server-level permissions through to the library", async () => {
    const server = createWebServer({
      converter: fakeConverter(state),
      allowLoopback: true,
      allowPrivateNetwork: true,
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await fetch(`${url}/api/convert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "http://localhost:3000" }),
      });
      expect(calls[0]?.security).toEqual({ allowLoopback: true, allowPrivateNetwork: true });
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  });

  it("rejects non-JSON, malformed, and incomplete requests with 4xx codes", async () => {
    const notJson = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "url=https://example.com",
    });
    expect(notJson.status).toBe(415);

    const malformed = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{nope",
    });
    expect(malformed.status).toBe(400);
    expect(((await malformed.json()) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");

    const missingUrl = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(missingUrl.status).toBe(400);

    const badMode = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", mode: "turbo" }),
    });
    expect(badMode.status).toBe(400);
    expect(calls).toHaveLength(0); // nothing reached the converter
  });

  it("maps tolerant readiness onto the library readiness options", async () => {
    await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", tolerant: true }),
    });
    expect(calls[0]?.readiness).toEqual({ images: false, networkIdleMs: 0 });

    await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", tolerant: false }),
    });
    expect(calls[1]?.readiness).toBeUndefined(); // default stays strict
  });

  it("rejects a non-boolean tolerant flag", async () => {
    const res = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", tolerant: "yes" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("tolerant");
    expect(calls).toHaveLength(0);
  });

  it("rejects cross-origin requests even with valid JSON", async () => {
    const foreign = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(foreign.status).toBe(403);
    expect(calls).toHaveLength(0);

    const same = await fetch(`${base}/api/convert`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    expect(same.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it("maps typed library errors onto documented status codes", async () => {
    for (const [code, status] of [
      ["BLOCKED_URL", 400],
      ["READINESS_TIMEOUT", 504],
      ["NAVIGATION_FAILED", 502],
      ["RESOURCE_LIMIT_EXCEEDED", 429],
    ] as const) {
      state.throw = new Dom2PdfError({ code, message: `simulated ${code}` });
      const res = await fetch(`${base}/api/convert`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com" }),
      });
      expect(res.status, code).toBe(status);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe(code);
      expect(body.error.message).toContain("simulated");
    }
    state.throw = undefined;
  });

  it("404s unknown routes and 204s favicon", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(204);
  });
});

describe("statusForError", () => {
  it("classifies non-dom2pdf errors as 500", () => {
    expect(statusForError(new Error("boom"))).toBe(500);
    expect(statusForError(undefined)).toBe(500);
  });
});
