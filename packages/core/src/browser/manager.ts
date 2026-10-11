import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PageForgeError } from "../errors/index.js";
import type { Logger } from "../utils/logger.js";

export interface BrowserManagerOptions {
  /**
   * Chromium sandbox state. PageForge defaults to **enabled**: Playwright's
   * own default disables the sandbox, so we pass `chromiumSandbox: true`
   * explicitly and only relax it when the caller opts in.
   */
  sandbox: boolean;
  /** How long launching Chromium may take. */
  launchTimeoutMs: number;
}

export interface UsePageOptions {
  viewport: { width: number; height: number };
}

/**
 * Owns the Chromium process (reused across conversions) and guarantees an
 * isolated, freshly-created `BrowserContext` per conversion. Contexts, cookies,
 * storage, and cache are never shared between conversions; the context is
 * closed on success, failure, timeout, and cancellation alike.
 */
export class BrowserManager {
  private browser: Browser | null = null;
  private launchTask: Promise<Browser> | null = null;
  private closed = false;

  constructor(
    private readonly options: BrowserManagerOptions,
    private readonly logger: Logger,
  ) {}

  private async ensureBrowser(): Promise<Browser> {
    if (this.closed) {
      throw new PageForgeError({ code: "CONVERTER_CLOSED", message: "Converter has been closed" });
    }
    if (this.browser !== null && this.browser.isConnected()) {
      return this.browser;
    }
    if (this.launchTask === null) {
      this.launchTask = chromium
        .launch({
          headless: true,
          chromiumSandbox: this.options.sandbox,
          timeout: this.options.launchTimeoutMs,
        })
        .then((browser) => {
          this.browser = browser;
          browser.on("disconnected", () => {
            if (this.browser === browser) {
              this.browser = null;
              this.logger.warn("Chromium disconnected; the next conversion will relaunch it");
            }
          });
          this.logger.debug("Chromium launched", { version: browser.version(), sandbox: this.options.sandbox });
          return browser;
        })
        .catch((cause: unknown) => {
          this.launchTask = null;
          throw new PageForgeError({
            code: "BROWSER_FAILURE",
            message: `Failed to launch Chromium${cause instanceof Error ? `: ${cause.message}` : ""}`,
            details: { sandbox: this.options.sandbox },
            cause,
          });
        });
    }
    return this.launchTask;
  }

  /**
   * Runs `fn` with a fresh, isolated page/context and always closes the
   * context afterwards.
   */
  async usePage<T>(fn: (page: Page, context: BrowserContext) => Promise<T>, options: UsePageOptions): Promise<T> {
    const browser = await this.ensureBrowser();

    let context: BrowserContext;
    try {
      context = await browser.newContext({ viewport: options.viewport });
    } catch (cause) {
      throw new PageForgeError({
        code: "BROWSER_FAILURE",
        message: `Failed to create browser context${cause instanceof Error ? `: ${cause.message}` : ""}`,
        cause,
      });
    }

    try {
      let page: Page;
      try {
        page = await context.newPage();
      } catch (cause) {
        throw new PageForgeError({
          code: "BROWSER_FAILURE",
          message: `Failed to create page${cause instanceof Error ? `: ${cause.message}` : ""}`,
          cause,
        });
      }
      return await fn(page, context);
    } finally {
      await context.close().catch((cause: unknown) => {
        this.logger.warn("Failed to close browser context", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }
  }

  /** Closes the browser. Idempotent; safe to call during a pending launch. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.launchTask !== null) {
      await this.launchTask.catch(() => undefined);
    }
    const browser = this.browser;
    this.browser = null;
    this.launchTask = null;
    if (browser !== null && browser.isConnected()) {
      await browser.close().catch((cause: unknown) => {
        this.logger.warn("Failed to close Chromium cleanly", {
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    }
  }
}
