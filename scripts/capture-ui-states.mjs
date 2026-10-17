// One-off QA: captures web UI states headlessly (light + dark) for visual
// review, against an already-running server.
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const BASE = process.argv[2];
if (!BASE) {
  console.error("usage: node scripts/capture-ui-states.mjs <webui-base-url>");
  console.error("  e.g. node scripts/capture-ui-states.mjs http://127.0.0.1:59329");
  console.error("  (start the server first: node apps/webui/dist/index.js --port 0 --allow-loopback)");
  process.exit(2);
}
const OUT = path.resolve("artifacts/ui-review");
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log("saved", name);
}

for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });
  await shot(page, `ui-initial-${scheme}.png`);

  // result state
  await page.fill("#url", "https://example.com");
  await page.click("#submit");
  await page.waitForSelector("#result.show", { timeout: 30_000 });
  await shot(page, `ui-result-${scheme}.png`);

  // error state (typed security error, no hint/forensics -> minimal card)
  await page.fill("#url", "ftp://example.com/x");
  await page.click("#submit");
  await page.waitForSelector("#error.show", { timeout: 30_000 });
  await shot(page, `ui-error-${scheme}.png`);

  // error state with hint + forensics (navigation failure on refused port)
  await page.fill("#url", "http://127.0.0.1:9/");
  await page.click("#submit");
  await page.waitForSelector("#forensics:not(:empty)", { timeout: 30_000 });
  await shot(page, `ui-error-forensics-${scheme}.png`);

  await context.close();
}

await browser.close();
console.log("done ->", OUT);
