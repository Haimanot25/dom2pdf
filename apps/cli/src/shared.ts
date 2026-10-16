import path from "node:path";
import { InvalidArgumentError } from "commander";
import { isDom2PdfError, type ConvertOptions, type ErrorCode } from "dom2pdf-js";

/**
 * Shared CLI plumbing: stable exit codes, error reporting (human + JSON),
 * input resolution, and the mapping from parsed flags to core `ConvertOptions`.
 * The mapping is a pure function so it can be unit-tested without spawning a
 * browser — the CLI itself contains no conversion logic.
 */

export const EXIT_CODES = {
  /** Success. */
  ok: 0,
  /** Usage error: unknown command/flag, missing or invalid argument. */
  usage: 2,
  /** Conversion (or inspection) failed with a typed error. */
  error: 3,
  /** Output rejected by a configured quality policy. */
  qualityPolicy: 4,
  /** Cancelled via SIGINT (conventional 128 + SIGINT). */
  cancelled: 130,
} as const;

/** A CLI-level usage mistake (bad argument combination the library never sees). */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

/** Exit code for an error produced by the command implementation. */
export function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError) return EXIT_CODES.usage;
  if (!isDom2PdfError(error)) return EXIT_CODES.error;
  const code: ErrorCode = error.code;
  if (code === "QUALITY_POLICY_FAILED") return EXIT_CODES.qualityPolicy;
  if (code === "CANCELLED") return EXIT_CODES.cancelled;
  return EXIT_CODES.error;
}

export function errorToText(error: unknown): string {
  if (isDom2PdfError(error)) {
    return `Error [${error.code}]: ${error.message}`;
  }
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}

export function errorToJson(error: unknown): Record<string, unknown> {
  if (isDom2PdfError(error)) return { ...error.toJSON() };
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { name: "Error", message: String(error) };
}

const URL_LIKE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export type InputSource =
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "stdin" };

/**
 * Decides what the positional source is:
 *
 * - `--stdin` → HTML is piped in (no positional argument allowed).
 * - Anything with a URL scheme (`http://`, but also `ftp://` — the library's
 *   protocol policy then rejects it with `BLOCKED_URL`) → URL input.
 * - Otherwise a filesystem path, which must exist; the CLI treats an explicit
 *   path as consent to read that file and grants only its own directory.
 * - `C:\...` Windows paths do not match the URL test (no `//`).
 */
export function resolveInputSource(source: string | undefined, useStdin: boolean): InputSource {
  if (useStdin) {
    if (source !== undefined) {
      throw new UsageError("do not pass a source argument together with --stdin");
    }
    return { kind: "stdin" };
  }
  if (source === undefined || source.length === 0) {
    throw new UsageError("missing input: pass an http(s) URL, a local file path, or --stdin");
  }
  if (URL_LIKE.test(source)) {
    return { kind: "url", url: source };
  }
  return { kind: "file", path: path.resolve(source) };
}

/** `"10mm"` → all sides; `"10mm,15mm,10mm,15mm"` → top,right,bottom,left. */
export function parseMargin(spec: string): { top: string; right: string; bottom: string; left: string } {
  const parts = spec
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const length = (value: string | undefined): string => {
    if (value === undefined) throw new InvalidArgumentError("empty margin value");
    if (!/^\d+(?:\.\d+)?\s*(?:px|in|cm|mm)?$/.test(value)) {
      throw new InvalidArgumentError(`"${value}" is not a length like 10, 10px, 10mm, 8.5in`);
    }
    return value;
  };
  if (parts.length === 1) {
    const value = length(parts[0]);
    return { top: value, right: value, bottom: value, left: value };
  }
  if (parts.length === 4) {
    return {
      top: length(parts[0]),
      right: length(parts[1]),
      bottom: length(parts[2]),
      left: length(parts[3]),
    };
  }
  throw new InvalidArgumentError("margin must be one value or four comma-separated values (top,right,bottom,left)");
}

/** `"1440x900"` → viewport dimensions. */
export function parseViewport(spec: string): { width: number; height: number } {
  const match = /^(\d{1,5})[xX](\d{1,5})$/.exec(spec.trim());
  if (match === null) {
    throw new InvalidArgumentError(`viewport must look like 1440x900; received "${spec}"`);
  }
  const width = Number.parseInt(match[1] ?? "", 10);
  const height = Number.parseInt(match[2] ?? "", 10);
  if (width < 1 || width > 10_000 || height < 1 || height > 10_000) {
    throw new InvalidArgumentError("viewport dimensions must be between 1 and 10000");
  }
  return { width, height };
}

/** Flags produced by the `convert` command (commander's parsed options). */
export interface ConvertFlags {
  output: string;
  stdin?: boolean;
  mode?: "document" | "screen";
  format?: string;
  landscape?: boolean;
  scale?: string;
  margin?: string;
  viewport?: string;
  timeout?: string;
  renderTimeout?: string;
  pageRanges?: string;
  preferCssPageSize?: boolean;
  printBackground?: boolean;
  outline?: boolean;
  tagged?: boolean;
  minPages?: string;
  maxPages?: string;
  minTextChars?: string;
  maxBytes?: string;
  failOnWarnings?: boolean;
  keepTogether?: boolean;
  allowLoopback?: boolean;
  allowPrivateNetwork?: boolean;
  maxRequests?: string;
  maxOutputBytes?: string;
  maxConcurrent?: string;
  diagnostics?: boolean;
  deterministic?: boolean;
  json?: boolean;
  quiet?: boolean;
}

export function parseIntFlag(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new UsageError(`--${name} must be an integer; received "${value}"`);
  }
  return parsed;
}

/**
 * Builds core `ConvertOptions` from parsed flags + resolved input. Local-file
 * input automatically receives permission scoped to the file's own directory:
 * an explicit path on the command line is explicit consent, and the core
 * library still performs realpath/symlink containment checks.
 */
export function buildConvertOptions(
  flags: ConvertFlags,
  source: InputSource,
  readStdinHtml: () => string,
): ConvertOptions {
  const input: ConvertOptions["input"] =
    source.kind === "url"
      ? { type: "url", url: source.url }
      : source.kind === "file"
        ? { type: "file", path: source.path }
        : { type: "html", html: readStdinHtml() };

  const pdf: Record<string, unknown> = {};
  if (flags.format !== undefined) pdf["format"] = flags.format;
  if (flags.landscape === true) pdf["landscape"] = true;
  if (flags.scale !== undefined) pdf["scale"] = Number(flags.scale);
  if (flags.margin !== undefined) pdf["margin"] = parseMargin(flags.margin);
  if (flags.pageRanges !== undefined) pdf["pageRanges"] = flags.pageRanges;
  if (flags.preferCssPageSize === true) pdf["preferCSSPageSize"] = true;
  if (flags.printBackground === false) pdf["printBackground"] = false;
  if (flags.outline === true) pdf["outline"] = true;
  if (flags.tagged === true) pdf["tagged"] = true;

  const quality: Record<string, unknown> = {};
  if (flags.minPages !== undefined) quality["minPages"] = parseIntFlag("min-pages", flags.minPages);
  if (flags.maxPages !== undefined) quality["maxPages"] = parseIntFlag("max-pages", flags.maxPages);
  if (flags.minTextChars !== undefined) quality["minTextChars"] = parseIntFlag("min-text-chars", flags.minTextChars);
  if (flags.maxBytes !== undefined) quality["maxBytes"] = parseIntFlag("max-bytes", flags.maxBytes);
  if (flags.failOnWarnings === true) quality["failOnWarnings"] = true;

  const security: Record<string, unknown> = {};
  if (source.kind === "file") {
    security["allowLocalFiles"] = true;
    security["allowedLocalDirectories"] = [path.dirname(source.path)];
  }
  if (flags.allowLoopback === true) security["allowLoopback"] = true;
  if (flags.allowPrivateNetwork === true) security["allowPrivateNetwork"] = true;

  const limits: Record<string, unknown> = {};
  if (flags.maxRequests !== undefined) {
    limits["maxRequests"] = parseIntFlag("max-requests", flags.maxRequests);
  }
  if (flags.maxOutputBytes !== undefined) {
    limits["maxOutputBytes"] = parseIntFlag("max-output-bytes", flags.maxOutputBytes);
  }

  const options: ConvertOptions = { input };
  if (flags.mode !== undefined) options.mode = flags.mode;
  if (Object.keys(pdf).length > 0) options.pdf = pdf as ConvertOptions["pdf"];
  if (flags.viewport !== undefined) options.viewport = parseViewport(flags.viewport);
  if (flags.timeout !== undefined) {
    options.readiness = { timeoutMs: parseIntFlag("timeout", flags.timeout) };
  }
  if (flags.renderTimeout !== undefined) {
    options.render = { timeoutMs: parseIntFlag("render-timeout", flags.renderTimeout) };
  }
  if (Object.keys(quality).length > 0) options.quality = quality as ConvertOptions["quality"];
  if (flags.diagnostics === true) options.diagnostics = true;
  if (flags.deterministic === true) options.deterministic = true;
  if (flags.keepTogether === true) options.pagination = { keepTogether: true };
  if (Object.keys(limits).length > 0) options.limits = limits as ConvertOptions["limits"];
  if (Object.keys(security).length > 0) options.security = security as ConvertOptions["security"];
  return options;
}

/** Human-readable byte size for summaries. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
