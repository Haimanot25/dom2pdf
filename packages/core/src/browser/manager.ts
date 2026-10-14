import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Dom2PdfError } from "../errors/index.js";
import { cancelledError } from "../utils/cancellation.js";
import type { Logger } from "../utils/logger.js";

export interface BrowserManagerOptions {
  /**
   * Chromium sandbox state. dom2pdf defaults to **enabled**: Playwright's
   * own default disables the sandbox, so we pass `chromiumSandbox: true`
   * explicitly and only relax it when the caller opts in.
   */
  sandbox: boolean;
  /** How long launching Chromium may take. */
  launchTimeoutMs: number;
}

export interface UsePageOptions {
  viewport: { width: number; height: number };
  /**
   * Explicit User-Agent override. When absent, the context gets a standard
   * `Chrome` UA derived from the running Chromium version (the `HeadlessChrome`
   * token removed — many production sites serve error pages to that string).
   */
  userAgent?: string;
  /** When aborted, no context is created at all. */
  signal?: AbortSignal;
}

/**
 * A standard Chrome User-Agent for the running Chromium build. This is a
 * compatibility shim for the UA *string* only — it does not (and cannot)
 * disguise the automation fingerprints in the TLS/HTTP2 handshake.
 */
export function chromeUserAgent(browserVersion: string): string {
  const major = browserVersion.split(".")[0] || "0";
  const platform =
    process.platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : process.platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
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
      throw new Dom2PdfError({ code: "CONVERTER_CLOSED", message: "Converter has been closed" });
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
          throw new Dom2PdfError({
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

    if (options.signal?.aborted === true) {
      // Cancelled during browser launch: skip context creation entirely.
      throw cancelledError("Conversion was cancelled before the browser context was created");
    }

    let context: BrowserContext;
    try {
      context = await browser.newContext({
        viewport: options.viewport,
        userAgent: options.userAgent ?? chromeUserAgent(browser.version()),
      });
    } catch (cause) {
      throw new Dom2PdfError({
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
        throw new Dom2PdfError({
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
