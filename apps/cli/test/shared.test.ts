import path from "node:path";
import { describe, expect, it } from "vitest";
import { Dom2PdfError, type ErrorCode } from "dom2pdf-js";
import {
  buildConvertOptions,
  errorToJson,
  errorToText,
  EXIT_CODES,
  exitCodeFor,
  formatBytes,
  parseMargin,
  parseIntFlag,
  parseViewport,
  resolveInputSource,
  UsageError,
  type ConvertFlags,
} from "../src/shared.js";

const STDIN_HTML = () => "<p>piped</p>";

function flags(overrides: Partial<ConvertFlags> = {}): ConvertFlags {
  return { output: "dom2pdf.pdf", ...overrides };
}

describe("resolveInputSource", () => {
  it("treats scheme-bearing input as URL input", () => {
    expect(resolveInputSource("https://example.com/x", false)).toEqual({
      kind: "url",
      url: "https://example.com/x",
    });
    // Non-http schemes still route to URL input so the library's protocol
    // policy can reject them with BLOCKED_URL (exit 3), not a usage error.
    expect(resolveInputSource("ftp://example.com/x", false)).toEqual({
      kind: "url",
      url: "ftp://example.com/x",
    });
  });

  it("treats plain paths as files and resolves them", () => {
    const source = resolveInputSource("fixtures/basic-text.html", false);
    expect(source).toEqual({ kind: "file", path: path.resolve("fixtures/basic-text.html") });
  });

  it("does not mistake a Windows drive path for a URL", () => {
    const source = resolveInputSource("C:\\pages\\index.html", false);
    expect(source.kind).toBe("file");
  });

  it("rejects missing sources and --stdin with a positional argument", () => {
    expect(() => resolveInputSource(undefined, false)).toThrow(UsageError);
    expect(() => resolveInputSource("", false)).toThrow(UsageError);
    expect(() => resolveInputSource("x.html", true)).toThrow(UsageError);
    expect(resolveInputSource(undefined, true)).toEqual({ kind: "stdin" });
  });
});

describe("parseMargin", () => {
  it("applies a single value to every side", () => {
    expect(parseMargin("10mm")).toEqual({ top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" });
    expect(parseMargin(" 12 ")).toEqual({ top: "12", right: "12", bottom: "12", left: "12" });
  });

  it("applies four comma-separated values to their sides", () => {
    expect(parseMargin("10mm,15mm,10mm,15mm")).toEqual({
      top: "10mm",
      right: "15mm",
      bottom: "10mm",
      left: "15mm",
    });
  });

  it("rejects bad lengths and wrong arity", () => {
    expect(() => parseMargin("10em")).toThrow();
    expect(() => parseMargin("10mm,15mm")).toThrow();
    expect(() => parseMargin("")).toThrow();
  });
});

describe("parseViewport", () => {
  it("parses WxH", () => {
    expect(parseViewport("1440x900")).toEqual({ width: 1440, height: 900 });
    expect(parseViewport(" 800X600 ")).toEqual({ width: 800, height: 600 });
  });

  it("rejects malformed or out-of-range specs", () => {
    expect(() => parseViewport("big")).toThrow();
    expect(() => parseViewport("1440*900")).toThrow();
    expect(() => parseViewport("0x900")).toThrow();
    expect(() => parseViewport("20000x900")).toThrow();
  });
});

describe("buildConvertOptions", () => {
  it("maps URL input and flags onto core options", () => {
    const options = buildConvertOptions(
      flags({
        mode: "screen",
        format: "Letter",
        landscape: true,
        margin: "10mm",
        viewport: "1440x900",
        timeout: "5000",
        renderTimeout: "4000",
        minPages: "2",
        maxPages: "9",
        failOnWarnings: true,
        allowLoopback: true,
        pageRanges: "1-3",
        printBackground: false,
      }),
      { kind: "url", url: "https://example.com" },
      STDIN_HTML,
    );

    expect(options).toEqual({
      input: { type: "url", url: "https://example.com" },
      mode: "screen",
      pdf: {
        format: "Letter",
        landscape: true,
        margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
        pageRanges: "1-3",
        printBackground: false,
      },
      viewport: { width: 1440, height: 900 },
      readiness: { timeoutMs: 5000 },
      render: { timeoutMs: 4000 },
      quality: { minPages: 2, maxPages: 9, failOnWarnings: true },
      security: { allowLoopback: true },
    });
  });

  it("omits unset sections entirely", () => {
    const options = buildConvertOptions(flags(), { kind: "url", url: "https://example.com" }, STDIN_HTML);
    expect(options).toEqual({ input: { type: "url", url: "https://example.com" } });
  });

  it("grants local-file permission scoped to the input file's directory", () => {
    const source = { kind: "file" as const, path: path.resolve("fixtures/basic-text.html") };
    const options = buildConvertOptions(flags(), source, STDIN_HTML);
    expect(options.input).toEqual({ type: "file", path: source.path });
    expect(options.security).toEqual({
      allowLocalFiles: true,
      allowedLocalDirectories: [path.dirname(source.path)],
    });
  });

  it("reads HTML from stdin for stdin input", () => {
    const options = buildConvertOptions(flags(), { kind: "stdin" }, STDIN_HTML);
    expect(options.input).toEqual({ type: "html", html: "<p>piped</p>" });
    expect(options.security).toBeUndefined();
  });

  it("maps resource-limit flags onto the limits option", () => {
    const options = buildConvertOptions(
      flags({ maxRequests: "25", maxOutputBytes: "65536" }),
      { kind: "url", url: "https://example.com" },
      STDIN_HTML,
    );
    expect(options.limits).toEqual({ maxRequests: 25, maxOutputBytes: 65536 });
  });

  it("leaves limits unset when the flags are absent", () => {
    const options = buildConvertOptions(flags(), { kind: "url", url: "https://example.com" }, STDIN_HTML);
    expect(options.limits).toBeUndefined();
  });

  it("maps --diagnostics onto the diagnostics option and omits it otherwise", () => {
    const enabled = buildConvertOptions(flags({ diagnostics: true }), { kind: "stdin" }, STDIN_HTML);
    expect(enabled.diagnostics).toBe(true);
    const absent = buildConvertOptions(flags(), { kind: "stdin" }, STDIN_HTML);
    expect(absent.diagnostics).toBeUndefined();
  });

  it("maps --deterministic onto the deterministic option and omits it otherwise", () => {
    const enabled = buildConvertOptions(flags({ deterministic: true }), { kind: "stdin" }, STDIN_HTML);
    expect(enabled.deterministic).toBe(true);
    const absent = buildConvertOptions(flags(), { kind: "stdin" }, STDIN_HTML);
    expect(absent.deterministic).toBeUndefined();
  });

  it("rejects non-integer numeric flags", () => {
    expect(() => buildConvertOptions(flags({ minPages: "2.5" }), { kind: "stdin" }, STDIN_HTML)).toThrow(
      UsageError,
    );
    expect(() => buildConvertOptions(flags({ maxRequests: "ten" }), { kind: "stdin" }, STDIN_HTML)).toThrow(
      UsageError,
    );
    expect(() => parseIntFlag("max-concurrent", "1.5")).toThrow(UsageError);
    expect(parseIntFlag("max-concurrent", "3")).toBe(3);
  });
});

describe("exit codes and error rendering", () => {
  it("maps error codes to the documented exit codes", () => {
    const withCode = (code: ErrorCode): number =>
      exitCodeFor(new Dom2PdfError({ code, message: "x" }));
    expect(withCode("INVALID_INPUT")).toBe(EXIT_CODES.error);
    expect(withCode("BLOCKED_URL")).toBe(EXIT_CODES.error);
    expect(withCode("READINESS_TIMEOUT")).toBe(EXIT_CODES.error);
    expect(withCode("QUALITY_POLICY_FAILED")).toBe(EXIT_CODES.qualityPolicy);
    expect(withCode("CANCELLED")).toBe(EXIT_CODES.cancelled);
    expect(exitCodeFor(new UsageError("bad arg"))).toBe(EXIT_CODES.usage);
    expect(exitCodeFor(new Error("plain"))).toBe(EXIT_CODES.error);
  });

  it("renders human and JSON error forms", () => {
    const error = new Dom2PdfError({ code: "BLOCKED_URL", message: "nope", details: { a: 1 } });
    expect(errorToText(error)).toBe("Error [BLOCKED_URL]: nope");
    expect(errorToJson(error)).toMatchObject({ name: "Dom2PdfError", code: "BLOCKED_URL", details: { a: 1 } });
    expect(errorToText(new Error("plain"))).toBe("Error: plain");
    expect(errorToJson("just a string")).toEqual({ name: "Error", message: "just a string" });
  });

  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(40_960)).toBe("40.0 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.00 MB");
  });
});
