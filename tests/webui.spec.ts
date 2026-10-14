import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/**
 * pageforge-web end to end: real server process, real Chromium, the real UI —
 * type a target URL, click convert, get a PDF.
 */

const WEBUI = path.resolve("apps/webui/dist/index.js");

let fixtureServer: FixtureServer;
let child: ChildProcess;
let webUrl: string;

test.beforeAll(async () => {
  fixtureServer = await startFixtureServer();
  child = spawn(process.execPath, [WEBUI, "--port", "0", "--allow-loopback"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  webUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`pageforge-web did not start: ${output}`)), 30_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      const match = /pageforge-web listening on (http:\/\/\S+)/.exec(output);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match[1] as string);
      }
    });
    child.on("error", reject);
  });
});

test.afterAll(async () => {
  child?.kill();
  await fixtureServer?.close();
});

test.describe("pageforge-web UI", () => {
  test("converts a target URL to a PDF shown in the result card", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(webUrl);
      await expect(page.locator("h1")).toHaveText("PageForge");

      await page.fill("#url", `${fixtureServer.origin}/basic-text.html`);
      await page.click("#submit");

      await expect(page.locator("#result")).toHaveClass(/show/, { timeout: 30_000 });
      await expect(page.locator("#pages")).toHaveText("1");
      const openHref = await page.locator("#open").getAttribute("href");
      expect(openHref).toMatch(/^blob:/);
      const downloadName = await page.locator("#download").getAttribute("download");
      expect(downloadName).toMatch(/\.pdf$/);

      // The blob really is a PDF (check magic bytes inside the creating page —
      // blob: URLs are not navigable from other tabs by design).
      const magic = await page.evaluate(async (href) => {
        const response = await fetch(href);
        const bytes = new Uint8Array(await response.arrayBuffer());
        return String.fromCharCode(...bytes.subarray(0, 5));
      }, openHref as string);
      expect(magic).toBe("%PDF-");

      // The result card surfaces the render-fidelity score (on by default).
      await expect(page.locator("#fidelity")).toContainText("Fidelity: mean SSIM");
      await expect(page.locator("#fidelity")).toContainText("not a pixel-perfectness claim");
      await expect(page.locator("#fidelity")).toHaveClass(/ok/);
    } finally {
      await browser.close();
    }
  });

  test("surfaces typed security errors in the error card", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(webUrl);
      await page.fill("#url", "ftp://example.com/x");
      await page.click("#submit");
      await expect(page.locator("#error")).toHaveClass(/show/, { timeout: 30_000 });
      await expect(page.locator("#errcode")).toHaveText("BLOCKED_URL");
      await expect(page.locator("#result")).not.toHaveClass(/show/);
    } finally {
      await browser.close();
    }
  });

  test("shows failure forensics in the error card when a conversion fails", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(webUrl);
      // Loopback is allowed for this server; port 9 makes navigation fail
      // (refused/unsafe port), so the always-on forensics bundle reports the
      // request that failed at the moment of failure.
      await page.fill("#url", "http://127.0.0.1:9/");
      await page.click("#submit");
      await expect(page.locator("#error")).toHaveClass(/show/, { timeout: 30_000 });
      await expect(page.locator("#errcode")).toHaveText("NAVIGATION_FAILED");
      await expect(page.locator("#forensics")).toContainText("Failed requests:");
      await expect(page.locator("#forensics")).toContainText("127.0.0.1:9");
    } finally {
      await browser.close();
    }
  });
});
