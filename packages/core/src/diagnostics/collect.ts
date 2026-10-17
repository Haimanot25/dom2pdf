import type { Page, Request, Response } from "playwright";
import { isDom2PdfError } from "../errors/index.js";
import { withTimeout } from "../utils/async.js";
import { sanitizeUrl } from "../utils/url.js";

/** Console/network capture for `diagnostics: true`; on failure attached as `error.details.diagnostics`.
 * Collection never delays or masks the original failure; the bundle contains page content. */

/** Per-entry text cap for console messages and page errors. */
export const CONSOLE_TEXT_CAP = 2_000;
/** Ring-buffer capacity for console messages. */
export const CONSOLE_ENTRIES_CAP = 100;
/** Capacity for uncaught page exceptions. */
export const PAGE_ERRORS_CAP = 50;
/** Capacity for network records. */
export const REQUESTS_CAP = 500;
/** Serialized-DOM cap (characters). */
export const DOM_CAP_CHARS = 262_144;
/** Overall deadline for artifact capture (screenshot + DOM) during a failure. */
export const GATHER_DEADLINE_MS = 5_000;

export interface ConsoleEntry {
  /** Chromium console message type (`log`, `warning`, `error`, …). */
  type: string;
  /** Message text, capped at `CONSOLE_TEXT_CAP` characters. */
  text: string;
  /** Sanitized source location (`url:line:column`), when the page provided one. */
  location?: string;
  /** Epoch ms when the message was emitted. */
  timestampMs: number;
}

export interface RequestRecord {
  /** Sanitized URL (credentials redacted, fragment dropped). */
  url: string;
  method: string;
  resourceType: string;
  /** HTTP status once a response arrived. */
  status?: number;
  /** Chromium failure text once the request failed (`net::ERR_…`). */
  failureText?: string;
}

export interface DiagnosticsBundle {
  /** Epoch ms when the bundle was gathered. */
  gatheredAtMs: number;
  /** Page URL at gather time (sanitized), or null if unavailable. */
  url: string | null;
  /** Console messages captured since page creation (newest last). */
  console: ConsoleEntry[];
  /** Uncaught page exceptions captured since page creation. */
  pageErrors: string[];
  /** Network activity observed since page creation. */
  requests: RequestRecord[];
  /** Requests observed beyond `REQUESTS_CAP` and not recorded. */
  droppedRequests?: number;
  /** Viewport screenshot as JPEG, base64-encoded, when one could be taken. */
  screenshotJpegBase64?: string;
  /** Serialized DOM, capped at `DOM_CAP_CHARS` characters. */
  dom?: string;
  /** Capture steps that could not run, with the reason. */
  incomplete?: string[];
}

/** Live capture state attached to a page for the whole conversion. */
export interface DiagnosticsCapture {
  console: ConsoleEntry[];
  pageErrors: string[];
  requests: RequestRecord[];
  droppedRequests: number;
  /** Detaches listeners. Safe to call more than once. */
  dispose(): void;
}

function capText(text: string): string {
  return text.length > CONSOLE_TEXT_CAP ? `${text.slice(0, CONSOLE_TEXT_CAP)}…[truncated]` : text;
}

function isHttpUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://");
}

/** Attaches console/pageerror/network listeners with bounded buffers; records only http(s) requests. */
export function installDiagnosticsCapture(page: Page): DiagnosticsCapture {
  const console_ = [] as ConsoleEntry[];
  const pageErrors: string[] = [];
  const requests: RequestRecord[] = [];
  const byRequest = new Map<Request, RequestRecord>();
  let droppedRequests = 0;

  const onConsole = (message: { type(): string; text(): string; location(): { url: string; lineNumber: number; columnNumber: number } }): void => {
    const location = message.location();
    console_.push({
      type: message.type(),
      text: capText(message.text()),
      ...(location.url.length > 0
        ? { location: sanitizeUrl(`${location.url}:${location.lineNumber}:${location.columnNumber}`) }
        : {}),
      timestampMs: Date.now(),
    });
    if (console_.length > CONSOLE_ENTRIES_CAP) console_.shift();
  };
  const onPageError = (error: unknown): void => {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    pageErrors.push(capText(text));
    if (pageErrors.length > PAGE_ERRORS_CAP) pageErrors.shift();
  };
  const onRequest = (request: Request): void => {
    const url = request.url();
    if (!isHttpUrl(url)) return;
    if (requests.length >= REQUESTS_CAP) {
      droppedRequests += 1;
      return;
    }
    const record: RequestRecord = {
      url: sanitizeUrl(url),
      method: request.method(),
      resourceType: request.resourceType(),
    };
    byRequest.set(request, record);
    requests.push(record);
  };
  const onResponse = (response: Response): void => {
    const record = byRequest.get(response.request());
    if (record !== undefined) record.status = response.status();
  };
  const onRequestFailed = (request: Request): void => {
    const record = byRequest.get(request);
    if (record === undefined) return;
    const failureText = request.failure()?.errorText;
    if (failureText !== undefined) record.failureText = failureText;
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("request", onRequest);
  page.on("response", onResponse);
  page.on("requestfailed", onRequestFailed);

  let disposed = false;
  return {
    console: console_,
    pageErrors,
    requests,
    get droppedRequests(): number {
      return droppedRequests;
    },
    dispose: (): void => {
      if (disposed) return;
      disposed = true;
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("request", onRequest);
      page.off("response", onResponse);
      page.off("requestfailed", onRequestFailed);
    },
  };
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

async function captureArtifacts(page: Page, incomplete: string[]): Promise<{
  screenshotJpegBase64?: string;
  dom?: string;
}> {
  let screenshotJpegBase64: string | undefined;
  try {
    const shot = await withTimeout(
      page.screenshot({ type: "jpeg", quality: 35, timeout: 4000 }),
      4000,
      () => new Error("screenshot timed out"),
    );
    screenshotJpegBase64 = shot.toString("base64");
  } catch (cause) {
    incomplete.push(`screenshot unavailable: ${messageOf(cause)}`);
  }

  let dom: string | undefined;
  try {
    const content = await withTimeout(page.content(), 4000, () => new Error("DOM serialization timed out"));
    dom =
      content.length > DOM_CAP_CHARS
        ? `${content.slice(0, DOM_CAP_CHARS)}\n<!-- dom2pdf: DOM truncated at ${DOM_CAP_CHARS} characters -->`
        : content;
  } catch (cause) {
    incomplete.push(`DOM unavailable: ${messageOf(cause)}`);
  }

  return {
    ...(screenshotJpegBase64 !== undefined ? { screenshotJpegBase64 } : {}),
    ...(dom !== undefined ? { dom } : {}),
  };
}

/** Never throws; failed steps go to `incomplete[]`. Artifact capture is bounded by
 * `GATHER_DEADLINE_MS` so a hung page cannot stall the error path. */
export async function gatherDiagnostics(page: Page, capture: DiagnosticsCapture): Promise<DiagnosticsBundle> {
  const incomplete: string[] = [];
  let url: string | null = null;
  try {
    url = sanitizeUrl(page.url());
  } catch (cause) {
    incomplete.push(`page URL unavailable: ${messageOf(cause)}`);
  }

  const artifacts = await Promise.race([
    captureArtifacts(page, incomplete),
    new Promise<null>((resolve) => {
      const timer = setTimeout(() => resolve(null), GATHER_DEADLINE_MS);
      timer.unref?.();
    }),
  ]);
  if (artifacts === null) {
    incomplete.push(`artifact capture exceeded the ${GATHER_DEADLINE_MS}ms deadline`);
  }

  return {
    gatheredAtMs: Date.now(),
    url,
    console: capture.console.map((entry) => ({ ...entry })),
    pageErrors: [...capture.pageErrors],
    requests: capture.requests.map((record) => ({ ...record })),
    ...(capture.droppedRequests > 0 ? { droppedRequests: capture.droppedRequests } : {}),
    ...(artifacts?.screenshotJpegBase64 !== undefined ? { screenshotJpegBase64: artifacts.screenshotJpegBase64 } : {}),
    ...(artifacts?.dom !== undefined ? { dom: artifacts.dom } : {}),
    ...(incomplete.length > 0 ? { incomplete: [...incomplete] } : {}),
  };
}

/** Sets `details.diagnostics`; also works on plain errors wrapped later by the converter. */
export function attachDiagnostics(error: unknown, bundle: DiagnosticsBundle): void {
  if (typeof error !== "object" || error === null) return;
  const existing = (error as { details?: Record<string, unknown> }).details;
  Object.assign(error, { details: { ...existing, diagnostics: bundle } });
}

function isDiagnosticsBundle(value: unknown): value is DiagnosticsBundle {
  return (
    typeof value === "object" &&
    value !== null &&
    "gatheredAtMs" in value &&
    "console" in value &&
    "requests" in value
  );
}

/** Reads a bundle previously attached with `attachDiagnostics`. */
export function readAttachedDiagnostics(error: unknown): DiagnosticsBundle | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const details = (error as { details?: Record<string, unknown> }).details;
  const bundle = details?.["diagnostics"];
  return isDiagnosticsBundle(bundle) ? bundle : undefined;
}

/** True for `CANCELLED` errors, which bypass diagnostics entirely. */
export function isCancellation(cause: unknown): boolean {
  return isDom2PdfError(cause) && cause.code === "CANCELLED";
}
