import { describe, expect, it } from "vitest";
import { ERROR_CODES, PageForgeError, isPageForgeError, toPageForgeError } from "../src/errors/index.js";

describe("PageForgeError", () => {
  it("carries a stable code, message, details, and cause", () => {
    const cause = new Error("boom");
    const error = new PageForgeError({
      code: "NAVIGATION_FAILED",
      message: "nav failed",
      details: { url: "https://example.com/" },
      cause,
    });
    expect(error.code).toBe("NAVIGATION_FAILED");
    expect(error.name).toBe("PageForgeError");
    expect(error.message).toBe("nav failed");
    expect(error.details).toEqual({ url: "https://example.com/" });
    expect(error.cause).toBe(cause);
    expect(error).toBeInstanceOf(Error);
  });

  it("serializes to JSON with the code", () => {
    const error = new PageForgeError({ code: "BLOCKED_URL", message: "nope", details: { a: 1 } });
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
    expect(isPageForgeError(new PageForgeError({ code: "CANCELLED", message: "x" }))).toBe(true);
    expect(isPageForgeError({ code: "CANCELLED", message: "x" })).toBe(true);
    expect(isPageForgeError({ code: "NOT_A_REAL_CODE", message: "x" })).toBe(false);
    expect(isPageForgeError(new Error("plain"))).toBe(false);
    expect(isPageForgeError(null)).toBe(false);
    expect(isPageForgeError("CANCELLED")).toBe(false);
  });

  it("wraps unknown causes without double-wrapping PageForge errors", () => {
    const original = new PageForgeError({ code: "BLOCKED_URL", message: "keep" });
    expect(toPageForgeError(original, { code: "BROWSER_FAILURE", message: "wrap" })).toBe(original);

    const wrapped = toPageForgeError(new Error("inner"), { code: "BROWSER_FAILURE", message: "outer" });
    expect(wrapped.code).toBe("BROWSER_FAILURE");
    expect(wrapped.message).toBe("outer");
    expect(wrapped.cause).toBeInstanceOf(Error);
  });
});
