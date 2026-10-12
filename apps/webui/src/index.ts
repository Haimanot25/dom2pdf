#!/usr/bin/env node
import { Command } from "commander";
import { createConverter } from "pageforge-pdf";
import { createWebServer } from "./server.js";

/**
 * pageforge-web — a localhost-only web UI for PageForge.
 *
 * Start it, open the printed URL, paste a target URL, get a PDF. The server
 * binds to 127.0.0.1 by default and applies the library's full security
 * policy; loopback/private targets require explicit --allow-loopback /
 * --allow-private-network at startup (the UI cannot escalate).
 */
interface WebFlags {
  port: string;
  host: string;
  allowLoopback?: boolean;
  allowPrivateNetwork?: boolean;
}

const program = new Command();
program
  .name("pageforge-web")
  .description("local web UI — convert a target URL to PDF from your browser")
  .option("--port <n>", "port to listen on (0 = ephemeral, printed on startup)", "8787")
  .option("--host <host>", "bind address; keep loopback unless you know why", "127.0.0.1")
  .option("--allow-loopback", "permit converting localhost targets")
  .option("--allow-private-network", "permit RFC1918/link-local targets")
  .showHelpAfterError()
  .exitOverride()
  .parse();
const flags = program.opts<WebFlags>();

const port = Number(flags.port);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error(`Error: --port must be an integer between 0 and 65535; received "${flags.port}"`);
  process.exit(2);
}

const converter = await createConverter({
  limits: { maxConcurrentConversions: 2 },
});
const server = createWebServer({
  converter,
  allowLoopback: flags.allowLoopback === true,
  allowPrivateNetwork: flags.allowPrivateNetwork === true,
  onLog: (message) => console.log(`[pageforge-web] ${message}`),
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Error: port ${flags.port} is already in use — try --port 0 for an ephemeral port`);
    process.exit(1);
  }
  console.error(`Error: ${error.message}`);
  process.exit(1);
});

server.listen(port, flags.host, () => {
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  console.log(`pageforge-web listening on http://${flags.host}:${boundPort}`);
  console.log(
    `  policy: loopback ${flags.allowLoopback === true ? "ALLOWED" : "denied"}, ` +
      `private network ${flags.allowPrivateNetwork === true ? "ALLOWED" : "denied"}`,
  );
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await converter.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
