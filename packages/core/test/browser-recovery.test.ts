import { describe, expect, it } from "vitest";
import { BrowserManager } from "../src/browser/manager.js";
import { createSilentLogger } from "../src/utils/logger.js";

/**
 * Chromium must be replaceable at any time: a crash, an update, or an OOM
 * kill between conversions may leave the manager holding a dead process. The
 * original implementation only cleared `browser` on the `disconnected` event
 * and kept its *resolved launch task*, so every conversion after one crash
 * failed `newContext: browser has been closed` — found on a live-site matrix
 * where a single Chromium death poisoned four conversions in a row.
 */
describe("BrowserManager recovery", () => {
  it("relaunches Chromium after the browser dies between conversions", async () => {
    const manager = new BrowserManager(
      { sandbox: false, launchTimeoutMs: 30_000 },
      createSilentLogger(),
    );
    try {
      const first = await manager.usePage(
        async (page) => {
          await page.setContent("<p>first</p>");
          return (await page.textContent("p")) ?? "";
        },
        { viewport: { width: 640, height: 480 } },
      );
      expect(first).toBe("first");

      // Simulate an external Chromium death: the process is gone and the
      // `disconnected` event fires while no conversion is running.
      await manager.usePage(
        async (page) => {
          await page.context().browser()?.close();
        },
        { viewport: { width: 640, height: 480 } },
      );

      // The next conversion must get a fresh browser, not the dead one.
      const third = await manager.usePage(
        async (page) => {
          await page.setContent("<p>third</p>");
          return (await page.textContent("p")) ?? "";
        },
        { viewport: { width: 640, height: 480 } },
      );
      expect(third).toBe("third");
    } finally {
      await manager.close();
    }
  }, 60_000);
});
