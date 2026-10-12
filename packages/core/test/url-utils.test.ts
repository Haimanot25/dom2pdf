import { describe, expect, it } from "vitest";
import { redactUrlCredentials, sanitizeUrl, escapeHtmlAttribute, sanitizeBytesForDisplay } from "../src/utils/url.js";

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

describe("redactUrlCredentials", () => {
  it("strips userinfo that Playwright embeds in net-error text", () => {
    const scrubbed = redactUrlCredentials("net::ERR_FAILED at http://user:secret@10.0.0.1/steal");
    expect(scrubbed).toBe("net::ERR_FAILED at http://REDACTED@10.0.0.1/steal");
    expect(scrubbed).not.toContain("secret");
  });

  it("handles username-only userinfo and leaves credential-free text alone", () => {
    expect(redactUrlCredentials("at http://user@host.example/p")).toBe("at http://REDACTED@host.example/p");
    expect(redactUrlCredentials("timeout contacting admin@example.com")).toBe("timeout contacting admin@example.com");
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
