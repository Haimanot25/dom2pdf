import { describe, expect, it } from "vitest";
import { ERROR_CODES, Dom2PdfError, isDom2PdfError, toDom2PdfError } from "../src/errors/index.js";

describe("Dom2PdfError", () => {
  it("carries a stable code, message, details, and cause", () => {
    const cause = new Error("boom");
    const error = new Dom2PdfError({
      code: "NAVIGATION_FAILED",
      message: "nav failed",
      details: { url: "https://example.com/" },
      cause,
    });
    expect(error.code).toBe("NAVIGATION_FAILED");
    expect(error.name).toBe("Dom2PdfError");
    expect(error.message).toBe("nav failed");
    expect(error.details).toEqual({ url: "https://example.com/" });
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  it("serializes to JSON with the code", () => {
    const error = new Dom2PdfError({ code: "BLOCKED_URL", message: "nope", details: { a: 1 } });
    const round = JSON.parse(JSON.stringify(error)) as unknown;
    expect(round).toMatchObject({ code: "BLOCKED_URL", message: "nope", details: { a: 1 } });
  });

  it("exposes an exhaustive, unique code list", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
    expect(ERROR_CODES).toContain("READINESS_TIMEOUT");
    expect(ERROR_CODES).toContain("RENDER_TIMEOUT");
    expect(ERROR_CODES).toContain("PDF_VALIDATION_FAILED");
    expect(ERROR_CODES).toContain("RESOURCE_LIMIT_EXCEEDED");
    expect(ERROR_CODES).toContain("CANCELLED");
    expect(ERROR_CODES).toContain("LOCAL_FILE_NOT_ALLOWED");
  });

  it("identifies errors structurally, including plain serialized objects", () => {
    expect(isDom2PdfError(new Dom2PdfError({ code: "CANCELLED", message: "x" }))).toBe(true);
    expect(isDom2PdfError({ code: "CANCELLED", message: "x" })).toBe(true);
    expect(isDom2PdfError({ code: "NOT_A_REAL_CODE", message: "x" })).toBe(false);
    expect(isDom2PdfError(new Error("plain"))).toBe(false);
    expect(isDom2PdfError(null)).toBe(false);
    expect(isDom2PdfError("CANCELLED")).toBe(false);
  });

  it("wraps unknown causes without double-wrapping dom2pdf errors", () => {
    const original = new Dom2PdfError({ code: "BLOCKED_URL", message: "keep" });
    expect(toDom2PdfError(original, { code: "BROWSER_FAILURE", message: "wrap" })).toBe(original);

    const wrapped = toDom2PdfError(new Error("inner"), { code: "BROWSER_FAILURE", message: "outer" });
    expect(wrapped.code).toBe("BROWSER_FAILURE");
    expect(wrapped.message).toBe("outer");
    expect(wrapped.cause).toBeInstanceOf(Error);
  });
});
