import { describe, expect, it } from "vitest";
import { chromeUserAgent } from "../src/browser/manager.js";
import { normalizeOptions, parseConvertOptions } from "../src/config/normalize.js";
import { Dom2PdfError } from "../src/errors/index.js";

const htmlInput = { type: "html" as const, html: "<p>x</p>" };

describe("chromeUserAgent", () => {
  it("builds a standard Chrome UA from the running Chromium version", () => {
    const ua = chromeUserAgent("156.0.8078.4");
    expect(ua).toContain("Chrome/156.0.0.0");
    expect(ua).toContain("AppleWebKit/537.36");
    expect(ua).not.toContain("HeadlessChrome");
    expect(ua.startsWith("Mozilla/5.0 (")).toBe(true);
  });

  it("uses the platform token matching this machine", () => {
    const ua = chromeUserAgent("120.0.1.2");
    if (process.platform === "win32") expect(ua).toContain("Windows NT 10.0");
    else if (process.platform === "darwin") expect(ua).toContain("Macintosh");
    else expect(ua).toContain("X11");
  });

  it("falls back safely on a malformed version", () => {
    expect(chromeUserAgent("")).toContain("Chrome/0.0.0.0");
  });
});

describe("browser convert options", () => {
  it("accepts an explicit userAgent and defaults to undefined (derived)", () => {
    const explicit = parseConvertOptions({ input: htmlInput, browser: { userAgent: "Bot/1.0" } });
    expect(explicit.browser?.userAgent).toBe("Bot/1.0");
    const normalized = normalizeOptions(parseConvertOptions({ input: htmlInput }));
    expect(normalized.browser.userAgent).toBeUndefined(); // → derived Chrome UA at context creation
  });

  it("rejects empty and unknown browser keys with typed errors", () => {
    for (const [raw, code] of [
      [{ input: htmlInput, browser: { userAgent: "" } }, "INVALID_INPUT"],
      [{ input: htmlInput, browser: { headless: false } }, "UNSUPPORTED_OPTION"],
    ] as const) {
      let caught: unknown;
      try {
        parseConvertOptions(raw);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Dom2PdfError);
      expect((caught as Dom2PdfError).code).toBe(code);
    }
  });
});
