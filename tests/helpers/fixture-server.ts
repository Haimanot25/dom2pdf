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

        // Test-only open redirect: /redirect-to?url=<absolute URL> answers 302,
        // so redirect-hop policy enforcement can be exercised for real.
        if (pathname === "/redirect-to") {
          const target = requestUrl.searchParams.get("url");
          if (target === null || target.length === 0) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("missing url");
            return;
          }
          res.writeHead(302, { location: target, "cache-control": "no-store" });
          res.end();
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

        // Test-only fidelity fixtures: two documents that are byte-identical
        // except the sabotage variant adds `break-inside: avoid` to a tall
        // block that straddles the first page boundary. Print pagination must
        // move the whole block to page 2 (leaving a gap on page 1), while
        // screen flow shows it in place — a genuine print-vs-screen
        // divergence the render-fidelity phase must detect.
        if (pathname === "/fidelity-healthy.html" || pathname === "/fidelity-sabotage.html") {
          const sabotage = pathname === "/fidelity-sabotage.html";
          const paragraphs = Array.from(
            { length: 8 },
            (_value, index) =>
              `<p>Paragraph ${index + 1}: The quarterly report covers revenue, retention, and reliability across all regions, with charts and detailed notes attached below for review by the team.</p>`,
          ).join("\n");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>fidelity fixture</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; margin: 24px; line-height: 1.6; font-size: 16px; }
  h1 { font-size: 26px; margin: 0 0 16px; }
  p { margin: 0 0 14px; }
  .tall { height: 880px; background: #2c3e50; color: #f2f5fa; padding: 16px; box-sizing: border-box; }
  .tall p { margin: 0 0 12px; }
  ${sabotage ? ".tall { break-inside: avoid; }" : ""}
</style>
</head>
<body>
<h1>Quarterly report</h1>
${paragraphs}
<div class="tall"><p>Tall keep-together block with dense visual content. ${
            sabotage
              ? "Print pagination moves this whole block to the next page (break-inside: avoid), leaving a gap on the page it started on; screen flow shows it in place."
              : "Flows continuously in both screen and print layout."
          }</p><p>The dark band makes any print-vs-screen divergence visually loud, which the fidelity comparison must score far below the healthy layout.</p><p>Trailing lines inside the block keep its ink profile structured rather than uniform, so alignment cannot mask the divergence with a lucky offset.</p></div>
${paragraphs}
${paragraphs}
</body>
</html>`);
          return;
        }

        // Test-only forensics probe: logs to the console, raises an uncaught
        // error, and loads an image that 404s — so a failure after this page
        // loads has console, pageerror, and network state to report.
        if (pathname === "/diag-probe.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>diag probe</title></head>
<body>
<p>diagnostics probe page</p>
<img src="/missing-diag-image.png" alt="missing" style="display:block;width:10px;height:10px">
<script>
  console.log("dom2pdf-diag-probe");
  console.error("dom2pdf-diag-error");
  setTimeout(function () { throw new Error("dom2pdf-diag-pageerror"); }, 0);
</script>
</body>
</html>`);
          return;
        }

        // Test-only bot gate: like real WAFs that serve error pages to the
        // HeadlessChrome UA token. 500 for headless UAs, real page otherwise.
        if (pathname === "/ua-sensitive.html") {
          const userAgent = req.headers["user-agent"] ?? "";
          if (/HeadlessChrome/i.test(userAgent)) {
            res.writeHead(500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
            res.end("go away, bot");
            return;
          }
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end("<!doctype html><title>Gate passed</title><p>Only real-looking browsers get in.</p>");
          return;
        }

        // Test-only UA echo: renders the User-Agent the browser actually sent,
        // so UA policy can be asserted from the produced PDF text.
        if (pathname === "/echo-ua.html") {
          const userAgent = req.headers["user-agent"] ?? "(none)";
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(`<!doctype html><title>UA</title><p>UA:${userAgent}</p>`);
          return;
        }

        // Test-only lazy page: tall scroll spacer, a status marker, and an
        // image that only starts loading when it intersects the viewport
        // (IntersectionObserver — same mechanism real lazy frameworks use;
        // print capture alone cannot trigger it). The drain sweep must scroll
        // it into view; the marker text proves which path happened.
        if (pathname === "/lazy-load.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(`<!doctype html><title>lazy</title><style>body{margin:0}</style>
<div style="height:2500px">long spacer</div>
<p id="status">lazy image not loaded</p>
<img id="lazyImg" data-src="/__delay/0/lazy.png" alt="lazy" style="display:block;width:40px;height:40px">
<div style="height:900px"></div>
<script>
  var img = document.getElementById("lazyImg");
  var io = new IntersectionObserver(function (entries) {
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].isIntersecting) {
        img.src = img.getAttribute("data-src");
        io.disconnect();
      }
    }
  });
  io.observe(img);
  img.addEventListener("load", function () {
    document.getElementById("status").textContent = "lazy image loaded";
  });
</script>`);
          return;
        }

        // Test-only hanging image: the PNG arrives after 6s, longer than any
        // patience used in tests — exercises per-image patience both ways.
        if (pathname === "/slow-image.html") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          res.end(
            '<!doctype html><title>slow</title><p>slow image page</p><img src="/__delay/6000/slow.png" alt="slow" style="display:block;width:20px;height:20px">',
          );
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
