import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isDom2PdfError, PAPER_FORMATS, type ConvertOptions, type PaperFormat, type QualityReport } from "dom2pdf-js";
import { renderUi } from "./ui.js";

/**
 * The slice of `Converter` this app needs. Structural, so unit tests inject a
 * fake and production passes the real `dom2pdf-js` converter unchanged.
 */
export interface WebConverter {
  convert(options: ConvertOptions): Promise<{ bytes: Uint8Array; report: QualityReport }>;
  close(): Promise<void>;
}

export interface WebServerOptions {
  converter: WebConverter;
  /** Permit converting loopback targets (server-level; the UI cannot escalate). */
  allowLoopback?: boolean;
  /** Permit converting RFC1918/link-local targets. */
  allowPrivateNetwork?: boolean;
  /** Request log sink (defaults to silent — the CLI prints its own lines). */
  onLog?: (message: string) => void;
}

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { name: "Error", code, message } });
}

/**
 * HTTP status mapping for typed failures — stable and documented so the UI
 * (and any script against `/api/convert`) can react programmatically.
 */
export function statusForError(error: unknown): number {
  if (!isDom2PdfError(error)) return 500;
  switch (error.code) {
    case "READINESS_TIMEOUT":
    case "RENDER_TIMEOUT":
      return 504;
    case "NAVIGATION_FAILED":
    case "BROWSER_FAILURE":
      return 502;
    case "RESOURCE_LIMIT_EXCEEDED":
      return 429;
    default:
      return 400;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Same-origin guard: the API never sets CORS headers, and browsers preflight
 * any cross-origin JSON POST — this additionally rejects the request itself
 * when a foreign page forges an Origin (defense in depth for a local tool
 * that can launch a browser).
 */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true; // same-origin navigations/fetches may omit it
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

interface ConvertRequest {
  url: string;
  mode?: "document" | "screen";
  format?: PaperFormat;
  tolerant?: boolean;
  keepTogether?: boolean;
}

function parseConvertRequest(raw: string): ConvertRequest | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "request body must be JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { error: "request body must be a JSON object" };
  const body = parsed as Record<string, unknown>;
  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    return { error: '"url" must be a non-empty string' };
  }
  if (body.mode !== undefined && body.mode !== "document" && body.mode !== "screen") {
    return { error: '"mode" must be "document" or "screen"' };
  }
  if (body.format !== undefined) {
    if (typeof body.format !== "string") return { error: '"format" must be a string (A4, Letter, …)' };
    if (!PAPER_FORMATS.includes(body.format as PaperFormat)) {
      return { error: `"format" must be one of: ${PAPER_FORMATS.join(", ")}` };
    }
  }
  if (body.tolerant !== undefined && typeof body.tolerant !== "boolean") {
    return { error: '"tolerant" must be a boolean' };
  }
  if (body.keepTogether !== undefined && typeof body.keepTogether !== "boolean") {
    return { error: '"keepTogether" must be a boolean' };
  }
  return {
    url: body.url.trim(),
    ...(body.mode === undefined ? {} : { mode: body.mode }),
    ...(body.format === undefined
      ? {}
      : { format: body.format as PaperFormat }), // cast is validated directly above
    ...(body.tolerant === undefined ? {} : { tolerant: body.tolerant }),
    ...(body.keepTogether === undefined ? {} : { keepTogether: body.keepTogether }),
  };
}

export function createWebServer(options: WebServerOptions): Server {
  const { converter, allowLoopback = false, allowPrivateNetwork = false } = options;
  const onLog = options.onLog ?? ((): void => undefined);

  return createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "/";

      if (req.method === "GET" && (url === "/" || url.startsWith("/?"))) {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(renderUi());
        return;
      }
      if (req.method === "GET" && url === "/favicon.ico") {
        res.writeHead(204).end();
        return;
      }

      if (req.method === "POST" && url === "/api/convert") {
        if (!isSameOrigin(req)) {
          sendError(res, 403, "FORBIDDEN", "cross-origin requests are not accepted");
          return;
        }
        const contentType = req.headers["content-type"] ?? "";
        if (!contentType.includes("application/json")) {
          sendError(res, 415, "UNSUPPORTED_MEDIA_TYPE", "content-type must be application/json");
          return;
        }

        let raw: string;
        try {
          raw = await readBody(req);
        } catch {
          sendError(res, 413, "PAYLOAD_TOO_LARGE", `request body exceeds ${MAX_BODY_BYTES} bytes`);
          return;
        }
        const request = parseConvertRequest(raw);
        if ("error" in request) {
          sendError(res, 400, "INVALID_INPUT", request.error);
          return;
        }

        // If the client goes away, stop the conversion instead of burning a
        // browser context on a request nobody will read.
        let finished = false;
        const controller = new AbortController();
        res.on("close", () => {
          if (!finished) controller.abort();
        });

        try {
          const convertOptions: ConvertOptions = {
            input: { type: "url", url: request.url },
            signal: controller.signal,
            // Always-on forensics: the error card surfaces console errors,
            // failed requests, and the DOM/screenshot of what went wrong.
            // The bundle never leaves this localhost tool's response.
            diagnostics: true,
            ...(request.mode === undefined ? {} : { mode: request.mode }),
            ...(request.format === undefined ? {} : { pdf: { format: request.format } }),
            // Tolerant readiness: skip the stages that hang on sites keeping
            // connections open forever (streaming analytics "images",
            // long-polling). Fonts are still awaited — they don't hang, and
            // missing fonts visibly change the render.
            ...(request.tolerant === true
              ? { readiness: { images: false, networkIdleMs: 0 } }
              : {}),
            ...(request.keepTogether === true ? { pagination: { keepTogether: true } } : {}),
            ...(allowLoopback || allowPrivateNetwork
              ? {
                  security: {
                    ...(allowLoopback ? { allowLoopback: true } : {}),
                    ...(allowPrivateNetwork ? { allowPrivateNetwork: true } : {}),
                  },
                }
              : {}),
          };
          onLog(`convert ${request.url}`);
          const result = await converter.convert(convertOptions);
          finished = true;
          if (controller.signal.aborted) return; // client already gone
          sendJson(res, 200, {
            pdf: Buffer.from(result.bytes).toString("base64"),
            report: result.report,
          });
        } catch (error) {
          finished = true;
          if (controller.signal.aborted) return;
          const status = statusForError(error);
          if (isDom2PdfError(error)) {
            sendJson(res, status, { error: error.toJSON() });
          } else {
            sendError(res, status, "INTERNAL", error instanceof Error ? error.message : String(error));
          }
        }
        return;
      }

      sendError(res, 404, "NOT_FOUND", `no route for ${req.method ?? "GET"} ${url}`);
    })();
  });
}
