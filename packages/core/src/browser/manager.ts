import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { Dom2PdfError } from "../errors/index.js";
import { cancelledError } from "../utils/cancellation.js";
import type { Logger } from "../utils/logger.js";

export interface BrowserManagerOptions {
  /** Chromium sandbox state. Playwright's own default disables the sandbox;
   * this passes `chromiumSandbox: true` explicitly unless the caller opts out. */
  sandbox: boolean;
  /** How long launching Chromium may take. */
  launchTimeoutMs: number;
}

export interface UsePageOptions {
  viewport: { width: number; height: number };
  /** Explicit User-Agent override; when absent, a standard `Chrome` UA derived from the
   * running version with the `HeadlessChrome` token removed (sites reject that token). */
  userAgent?: string;
  /** When aborted, no context is created at all. */
  signal?: AbortSignal;
}

/** Standard Chrome UA string for the running build; does not affect TLS/HTTP2
 * fingerprints, which still expose automation. */
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

/** Reuses one Chromium process; each conversion gets a fresh isolated context,
 * closed on success, failure, timeout, and cancellation alike. */
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
    // A disconnect can race the event handler below and a launch can resolve to a process
    // that dies immediately; drop the stale task and relaunch once, then fail.
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
          // A process that died before this handler was attached never fires `disconnected`.
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

  /** Clears the dead browser and its launch task so the next acquire relaunches.
   * Only clears state still referencing this exact browser; a relaunch started meanwhile is untouched. */
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
      throw cancelledError("Conversion was cancelled before the browser context was created");
    }

    let context: BrowserContext | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0) {
        // Browser died between launch and context creation (crash or external kill, possibly
        // before `disconnected` fired); relaunch once so a dead process costs one conversion.
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
