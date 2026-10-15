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
    // Never hand out a dead browser. A disconnect can race the event handler
    // below, a launch can resolve to a process that dies immediately, and a
    // stale launch task once poisoned *every* conversion after one crash
    // (found on a live-site matrix: Chromium died once, then four
    // conversions in a row failed `newContext: browser has been closed`).
    // Drop and relaunch instead — at most one relaunch, then fail honestly.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const browser = await this.acquireBrowser();
      if (browser.isConnected()) return browser;
      this.dropBrowser(browser);
      if (this.closed) {
        throw new Dom2PdfError({ code: "CONVERTER_CLOSED", message: "Converter has been closed" });
      }
    }
    throw new Dom2PdfError({
      code: "BROWSER_FAILURE",
      message: "Chromium died immediately after launch twice in a row; check that the bundled browser can run on this machine",
      details: { sandbox: this.options.sandbox },
    });
  }

  /** Resolves the shared launch task, starting one when none is pending. */
  private async acquireBrowser(): Promise<Browser> {
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
              this.dropBrowser(browser);
              this.logger.warn("Chromium disconnected; the next conversion will relaunch it");
            }
          });
          // A process that died before the handler above was attached never
          // fires `disconnected` for us — check liveness explicitly.
          if (!browser.isConnected()) {
            this.dropBrowser(browser);
          }
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
   * Forgets a dead browser (and the launch task that resolved to it) so the
   * next acquire launches a fresh one. Only clears state still referencing
   * this exact browser — a relaunch started meanwhile is left alone.
   */
  private dropBrowser(browser: Browser): void {
    if (this.browser === browser) {
      this.browser = null;
      this.launchTask = null;
    }
  }

  /**
   * Runs `fn` with a fresh, isolated page/context and always closes the
   * context afterwards.
   */
  async usePage<T>(fn: (page: Page, context: BrowserContext) => Promise<T>, options: UsePageOptions): Promise<T> {
    let browser = await this.ensureBrowser();

    if (options.signal?.aborted === true) {
      // Cancelled during browser launch: skip context creation entirely.
      throw cancelledError("Conversion was cancelled before the browser context was created");
    }

    let context: BrowserContext | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        // The browser died between launch and context creation (crash or
        // external kill — possibly before Playwright's `disconnected` event
        // fired). Relaunch once so a dead process costs at most one
        // conversion, never a series.
        browser = await this.ensureBrowser();
      }
      try {
        context = await browser.newContext({
          viewport: options.viewport,
          userAgent: options.userAgent ?? chromeUserAgent(browser.version()),
        });
        break;
      } catch (cause) {
        const dead = !browser.isConnected() && !this.closed;
        if (attempt === 0 && dead) {
          this.dropBrowser(browser);
          continue;
        }
        throw new Dom2PdfError({
          code: "BROWSER_FAILURE",
          message: `Failed to create browser context${cause instanceof Error ? `: ${cause.message}` : ""}`,
          cause,
        });
      }
    }
    if (context === null) {
      // Unreachable: the loop either assigns a context or throws.
      throw new Dom2PdfError({ code: "BROWSER_FAILURE", message: "Failed to create browser context" });
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
