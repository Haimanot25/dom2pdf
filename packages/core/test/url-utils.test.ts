import { describe, expect, it } from "vitest";
import { sanitizeUrl, escapeHtmlAttribute, sanitizeBytesForDisplay } from "../src/utils/url.js";

describe("sanitizeUrl", () => {
  it("removes userinfo credentials", () => {
    expect(sanitizeUrl("https://user:secret@example.com/path")).toBe("https://example.com/path");
  });

  it("redacts sensitive query parameters", () => {
    expect(sanitizeUrl("https://example.com/?token=abc123&q=pdf")).toBe(
      "https://example.com/?token=REDACTED&q=pdf",
    );
    expect(sanitizeUrl("https://example.com/?access_token=zzz")).toBe("https://example.com/?access_token=REDACTED");
  });

  it("keeps harmless query parameters readable", () => {
    expect(sanitizeUrl("https://example.com/search?page=2")).toBe("https://example.com/search?page=2");
  });

  it("drops fragments entirely", () => {
    expect(sanitizeUrl("https://example.com/doc#secret-part")).toBe("https://example.com/doc");
  });

  it("never throws on malformed input", () => {
    expect(typeof sanitizeUrl("::::not a url")).toBe("string");
    expect(sanitizeUrl("x".repeat(500)).length).toBeLessThanOrEqual(201);
  });
});

describe("escapeHtmlAttribute", () => {
  it("escapes quote, ampersand, and angle brackets", () => {
    expect(escapeHtmlAttribute('a"b<c>&d')).toBe("a&quot;b&lt;c&gt;&amp;d");
  });
});

describe("sanitizeBytesForDisplay", () => {
  it("renders printable bytes and dots for binary data", () => {
    expect(sanitizeBytesForDisplay(new TextEncoder().encode("%PDF-1.7\n"))).toBe("%PDF-1.7\n".slice(0, 16).replace("\n", "."));
  });

  it("appends an ellipsis when truncated", () => {
    expect(sanitizeBytesForDisplay(new Uint8Array(64), 8).endsWith("…")).toBe(true);
  });
});
