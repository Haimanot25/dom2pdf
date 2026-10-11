import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface FixtureServer {
  /** e.g. `http://127.0.0.1:41234` — always loopback, so tests must opt in via `security.allowLoopback`. */
  origin: string;
  close(): Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
};

export const FIXTURES_DIR = path.resolve(fileURLToPath(new URL("../../fixtures", import.meta.url)));

/**
 * Serves the repository's `fixtures/` directory over loopback HTTP for
 * deterministic URL-input tests (no live internet involved).
 */
export async function startFixtureServer(rootDir: string = FIXTURES_DIR): Promise<FixtureServer> {
  const root = path.resolve(rootDir);

  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1");
        const pathname = decodeURIComponent(requestUrl.pathname);

        // Test-only: kills the socket mid-response so `requestfailed` fires
        // with a deterministic connection error (no reliance on closed ports).
        if (pathname.startsWith("/__abort")) {
          req.socket.destroy();
          return;
        }

        // Test-only latency injection: /__delay/<ms>/<anything> stalls before
        // responding so readiness/timeout behavior can be exercised for real.
        const delayMatch = /^\/__delay\/(\d+)(?:\/|$)/.exec(pathname);
        if (delayMatch !== null) {
          const ms = Math.min(Number.parseInt(delayMatch[1] ?? "0", 10) || 0, 30_000);
          await new Promise((resolve) => setTimeout(resolve, ms));
          res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
          // 1x1 transparent PNG.
          res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
          return;
        }

        const resolved = path.resolve(root, `.${pathname}`);
        const insideRoot = resolved === root || resolved.startsWith(root + path.sep);
        if (!insideRoot) {
          res.writeHead(403).end("Forbidden");
          return;
        }
        const data = await readFile(resolved);
        const type = MIME_TYPES[path.extname(resolved).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
        res.end(data);
      } catch {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("Not found");
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Fixture server failed to bind to an ephemeral port");
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
