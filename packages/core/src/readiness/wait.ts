import type { Page } from "playwright";
import type { NormalizedReadinessOptions } from "../config/normalize.js";
import { Dom2PdfError } from "../errors/index.js";
import type { NetworkActivity } from "./tracking.js";
import type { Deadline } from "../utils/deadline.js";

/**
 * Readiness phase: after navigation, wait for what makes a capture
 * trustworthy — lazy content drained, fonts settled, images finished,
 * network quiet, selector visible — under one shared deadline.
 *
 * Each pending image gets its own `slowResourceMs` patience and surfaces as
 * `resources.slow` instead of spending the shared deadline; the lazy sweep
 * is bounded enrichment and reports `truncated` rather than failing.
 */

export interface ImageState {
  /** `<img>` elements with a non-empty `src`. */
  total: number;
  /** Finished with at least one decoded pixel. */
  loaded: number;
  /** Started but not finished at measurement time. */
  pending: number;
  /** Absolute URLs of pending images (superset of `slowUrls`). */
  pendingUrls: string[];
  /** Absolute URLs of images that finished broken. */
  brokenUrls: string[];
  /** Pending images past their individual patience; the conversion proceeds without them (`resources.slow`). */
  slowUrls: string[];
}

export interface LazySweepState {
  /** Whether the sweep ran (scrollable documents only). */
  performed: boolean;
  /** Scroll steps performed. */
  steps: number;
  /** The document kept appending content until the step limit. */
  truncated: boolean;
  /** `step-limit` (page keeps growing), `time-budget` (sweep's deadline share spent), or `null` when complete. */
  truncationReason: "step-limit" | "time-budget" | null;
  /** Large elements (≥100px tall) invisible when the sweep started. */
  hiddenBeforeSweep: number;
  /** Same count after the sweep; a drop means reveal-on-scroll blocks became visible, a residual is usually decorative layers. */
  hiddenAfterSweep: number;
}

export interface ReadinessResult {
  /** Wall-clock milliseconds spent in the readiness phase. */
  durationMs: number;
  /** Whether `document.fonts.ready` was awaited. */
  fontsAwaited: boolean;
  images: ImageState;
  lazy: LazySweepState;
  /** Families from `waitForFonts` the browser reports as unavailable. */
  unavailableFonts: string[];
  /** Satisfied network-idle window in ms (`0` = check disabled). */
  networkIdleMs: number;
  /** The network wait ended without a quiet window; readiness reports this as a warning instead of failing. */
  networkUnsettled: boolean;
  /** Selector that became visible, when requested. */
  selector: string | undefined;
  /** Satisfied settle window in ms (`0` = no settle requested). */
  settledMs: number;
  /** In-flight requests that outlived their patience — the hung assets the conversion proceeded without. */
  stalledUrls: string[];
}

function readinessTimeout(stage: string, deadline: Deadline): Dom2PdfError {
  return new Dom2PdfError({
    code: "READINESS_TIMEOUT",
    message: `Readiness deadline elapsed during the "${stage}" stage — the page never settled (set readiness.networkIdleMs: 0 or raise readiness.timeoutMs for long-polling pages)`,
    details: { stage, expiresAt: deadline.expiresAt },
  });
}

function isTimeoutError(value: unknown): boolean {
  return value instanceof Error && value.name === "TimeoutError";
}

/** Rejects with `READINESS_TIMEOUT` if `promise` has not settled by the deadline. */
async function withDeadline<T>(promise: Promise<T>, deadline: Deadline, stage: string): Promise<T> {
  if (deadline.expired) {
    // The promise may already be in flight; abandon it or its later
    // rejection ("Target closed") becomes unhandled and kills the process.
    promise.catch(() => undefined);
    throw readinessTimeout(stage, deadline);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(readinessTimeout(stage, deadline)), deadline.remainingMs());
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Stage budget for the network quiet window: tag managers keep the activity
// clock fresh forever, so a quiet window may never arrive while nothing is
// actually transferring. Past the budget a transferring stage keeps waiting
// for the deadline; a chatty stage reports `readiness.network-unsettled`.
// The busy share is judged across 25ms samples, never one instant.
const NETWORK_QUIET_STAGE_BUDGET_MS = 4_000;
const NETWORK_CHURN_BUSY_SHARE = 0.5;

/**
 * Waits until no http(s) request is in flight and the network has been
 * quiet for `idleMs`, counted from the tracker watching since before
 * navigation. Requests past `patienceMs` are presumed hung and do not block.
 *
 * Returns `settled` when a quiet window arrived, `unsettled` when the stage
 * budget elapsed on pure churn (capture proceeds with a warning). Throws
 * `READINESS_TIMEOUT` when the deadline expires with requests genuinely
 * awaiting a response, or when the stage was mostly transferring.
 */
async function waitForNetworkQuiet(
  activity: NetworkActivity,
  idleMs: number,
  deadline: Deadline,
  patienceMs: number,
): Promise<"settled" | "unsettled"> {
  const stageEndsAt = Date.now() + NETWORK_QUIET_STAGE_BUDGET_MS;
  let busySamples = 0;
  let totalSamples = 0;
  for (;;) {
    const blocking = activity.inFlightRecent(patienceMs > 0 ? patienceMs : undefined);
    const now = Date.now();
    totalSamples += 1;
    if (blocking > 0) busySamples += 1;

    if (blocking === 0 && now - activity.lastActivityAt() >= idleMs) return "settled";

    if (deadline.expired) {
      // Requests awaiting a response mean the page is still loading — the
      // failure the timeout advice is for. Pure churn (beacons refreshing
      // the activity clock, nothing transferring) is not: capture instead.
      if (blocking > 0 || busySamples / totalSamples >= NETWORK_CHURN_BUSY_SHARE) {
        throw readinessTimeout("network", deadline);
      }
      return "unsettled";
    }

    if (now >= stageEndsAt && busySamples / totalSamples < NETWORK_CHURN_BUSY_SHARE) {
      return "unsettled";
    }

    await sleep(Math.min(25, Math.max(1, deadline.remainingMs())));
  }
}

async function collectImages(page: Page): Promise<ImageState> {
  return page.evaluate((): ImageState => {
    const images = Array.from(document.images).filter(
      (img) => (img.getAttribute("src") ?? "").trim().length > 0,
    );
    let loaded = 0;
    const pendingUrls: string[] = [];
    const brokenUrls: string[] = [];
    for (const img of images) {
      if (!img.complete) {
        pendingUrls.push(img.currentSrc || img.src);
        continue;
      }
      if (img.naturalWidth > 0) {
        loaded += 1;
      } else {
        brokenUrls.push(img.currentSrc || img.src);
      }
    }
    return {
      total: images.length,
      loaded,
      pending: pendingUrls.length,
      pendingUrls,
      brokenUrls,
      slowUrls: [],
    };
  });
}

/**
 * Waits for pending images, each under its own patience instead of one
 * shared budget: an image older than `slowResourceMs` moves to `slowUrls`
 * and stops blocking, so a hanging asset costs a warning rather than the
 * whole conversion. Patience `0` blocks until the shared deadline.
 */
async function resolveImages(
  page: Page,
  options: NormalizedReadinessOptions,
  deadline: Deadline,
  activity: NetworkActivity,
): Promise<ImageState> {
  let state = await withDeadline(collectImages(page), deadline, "images");
  const firstPendingAt = new Map<string, number>();
  const slow = new Set<string>();

  /** Pending images still within their individual patience. */
  const blockingUrls = (): string[] => {
    const now = Date.now();
    const blocking: string[] = [];
    for (const url of state.pendingUrls) {
      if (slow.has(url)) continue;
      if (!firstPendingAt.has(url)) firstPendingAt.set(url, now);
      // Real request start when in flight; first-observed time otherwise.
      const startedAt = activity.requestStartAt(url) ?? firstPendingAt.get(url) ?? now;
      if (options.slowResourceMs > 0 && now - startedAt >= options.slowResourceMs) {
        slow.add(url);
        continue;
      }
      blocking.push(url);
    }
    return blocking;
  };

  if (options.images) {
    for (;;) {
      if (blockingUrls().length === 0) break;
      if (deadline.expired) throw readinessTimeout("images", deadline);
      await sleep(Math.min(50, Math.max(1, deadline.remainingMs())));
      state = await withDeadline(collectImages(page), deadline, "images");
    }
  }
  return { ...state, slowUrls: [...slow] };
}

const LAZY_MAX_STEPS = 30;
const LAZY_STEP_IDLE_MS = 120;
const LAZY_STEP_MAX_WAIT_MS = 2_500;
// Dwell so throttled scroll handlers (~100-250ms) notice the new position;
// shorter values coalesced steps and left sections unrevealed.
const LAZY_STEP_DWELL_MS = 200;
// Mid-walk settle, kept small because these waits multiply across steps;
// the images/network stages after the sweep own final settling. The
// bottom-settle (growth check) still gets the full cap.
const LAZY_STEP_SETTLE_MS = 600;
// The sweep may spend at most this fraction of the remaining readiness
// deadline, never past the reserve the essential checks after it keep.
const LAZY_SWEEP_BUDGET_FRACTION = 0.5;
const LAZY_SWEEP_MIN_RESERVE_MS = 1_500;
// One bounded tail wait lets throttled reveals apply their visible class
// before the hidden count and the capture; only paid when the sweep made
// blocks visible.
const LAZY_REVEAL_TAIL_MS = 500;
// Below this much deadline left, skip the post-sweep hidden count — it is
// a diagnostic, never worth failing a ready page.
const LAZY_HIDDEN_PROBE_MIN_MS = 200;

/**
 * Resolves once the network has been quiet for `idleMs`, or `false` when
 * the quiet window did not arrive within `maxWaitMs`. Requests older than
 * `patienceMs` count as hung and do not block.
 */
async function waitForQuietWindow(
  activity: NetworkActivity,
  idleMs: number,
  maxWaitMs: number,
  patienceMs: number,
): Promise<boolean> {
  const until = Date.now() + maxWaitMs;
  for (;;) {
    const blocking = activity.inFlightRecent(patienceMs > 0 ? patienceMs : undefined);
    if (blocking === 0 && Date.now() - activity.lastActivityAt() >= idleMs) return true;
    if (Date.now() >= until) return false;
    await sleep(25);
  }
}

/**
 * Counts large elements (≥100px tall) that are invisible now — opacity
 * below 0.1 or `visibility: hidden`. Repeats the `drainLazyContent`
 * pre-scan walk verbatim: page-side code cannot share closures across
 * `evaluate` calls.
 */
async function countHiddenLarge(page: Page, deadline: Deadline): Promise<number> {
  return withDeadline(
    page.evaluate(() => {
      let hidden = 0;
      document.querySelectorAll("body *").forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.height < 100 || rect.width < 8) return;
        const style = getComputedStyle(el);
        if (parseFloat(style.opacity) < 0.1 || style.visibility === "hidden") hidden += 1;
      });
      return hidden;
    }),
    deadline,
    "lazy-load",
  );
}

/**
 * Lazy-load drain: a bounded scroll sweep before the other checks. One
 * sweep covers lazy images/iframes, fetch-on-scroll content (infinite
 * scroll), and reveal-on-scroll animations (sections at `opacity: 0` that
 * otherwise print as blank space).
 *
 * Only scrollable documents pay; `readiness.lazyLoad: false` opts out.
 * The sweep stops at the step limit or its deadline share, reporting
 * `truncated` — it never fails a conversion — and always restores the
 * scroll position.
 */
async function drainLazyContent(
  page: Page,
  options: NormalizedReadinessOptions,
  deadline: Deadline,
  activity: NetworkActivity,
): Promise<LazySweepState> {
  const idle: LazySweepState = {
    performed: false,
    steps: 0,
    truncated: false,
    truncationReason: null,
    hiddenBeforeSweep: 0,
    hiddenAfterSweep: 0,
  };
  // An expired deadline skips the sweep so a later stage names the real
  // bottleneck.
  if (!options.lazyLoad || deadline.expired) return idle;

  // One evaluate: scrollable check plus the reveal-on-scroll baseline.
  const scan = await withDeadline(
    page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      let hidden = 0;
      document.querySelectorAll("body *").forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.height < 100 || rect.width < 8) return;
        const style = getComputedStyle(el);
        if (parseFloat(style.opacity) < 0.1 || style.visibility === "hidden") hidden += 1;
      });
      return { scrollable: root.scrollHeight > window.innerHeight * 1.25, hidden };
    }),
    deadline,
    "lazy-load",
  );
  if (!scan.scrollable) return idle;

  // Budget: this share of the remaining deadline, capped at the reserve the
  // checks after it (fonts, images, network quiet) keep. Below a usable
  // budget the sweep does not run at all.
  const remainingAtStart = deadline.remainingMs();
  const budgetMs = Math.min(
    Math.floor(remainingAtStart * LAZY_SWEEP_BUDGET_FRACTION),
    remainingAtStart - LAZY_SWEEP_MIN_RESERVE_MS,
  );
  if (budgetMs <= 0) return idle;
  const sweepStartedAt = Date.now();
  const settleBudgetMs = (): number =>
    Math.max(1, Math.min(budgetMs - (Date.now() - sweepStartedAt), deadline.remainingMs()));

  const startY = await page.evaluate(() => window.scrollY);
  let steps = 0;
  let truncated = false;
  let truncationReason: "step-limit" | "time-budget" | null = null;
  try {
    for (;;) {
      // Out of budget: stop and report; the sweep never fails a conversion.
      if (Date.now() - sweepStartedAt >= budgetMs || deadline.expired) {
        truncated = true;
        truncationReason = "time-budget";
        break;
      }
      if (steps >= LAZY_MAX_STEPS) {
        truncated = true;
        truncationReason = "step-limit";
        break;
      }
      const step = await page.evaluate((fraction: number) => {
        const root = document.scrollingElement ?? document.documentElement;
        const heightBefore = root.scrollHeight;
        const remaining = heightBefore - (window.scrollY + window.innerHeight);
        const stepPx = Math.max(24, Math.floor(window.innerHeight * fraction));
        // `behavior: "instant"` defeats `scroll-behavior: smooth` pages,
        // which would otherwise animate and race the next step.
        window.scrollTo({ top: window.scrollY + stepPx, behavior: "instant" });
        return { atBottom: remaining <= 4, heightBefore };
      }, 0.9);
      steps += 1;
      // Lazy triggers fire on rendering steps after the scroll; two frames
      // plus the dwell give throttled handlers time to notice.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await sleep(LAZY_STEP_DWELL_MS);
      if (step.atBottom) {
        // Fetch-on-scroll pages append after the scroll arrives: settle with
        // the full cap, then re-check the height; growth means keep walking.
        await waitForQuietWindow(
          activity,
          LAZY_STEP_IDLE_MS,
          Math.min(LAZY_STEP_MAX_WAIT_MS, settleBudgetMs()),
          options.slowResourceMs,
        );
        const heightAfter = await page.evaluate(
          () => (document.scrollingElement ?? document.documentElement).scrollHeight,
        );
        if (heightAfter > step.heightBefore + 4) continue;
        break;
      }
      // Mid-walk: let the triggered burst settle so the next step walks a
      // stable document.
      await waitForQuietWindow(
        activity,
        LAZY_STEP_IDLE_MS,
        Math.min(LAZY_STEP_SETTLE_MS, settleBudgetMs()),
        options.slowResourceMs,
      );
    }
  } finally {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), startY).catch(
      () => undefined,
    );
  }

  // Diagnostic: large content still invisible after the sweep. Skipped when
  // the deadline is nearly spent.
  let hiddenAfterSweep = 0;
  if (deadline.remainingMs() >= LAZY_HIDDEN_PROBE_MIN_MS) {
    hiddenAfterSweep = await countHiddenLarge(page, deadline);
    // A drop below the baseline means reveals triggered; one bounded tail
    // wait lets their throttled handlers land. Static pages never wait.
    if (
      hiddenAfterSweep < scan.hidden &&
      deadline.remainingMs() >= LAZY_HIDDEN_PROBE_MIN_MS + LAZY_REVEAL_TAIL_MS
    ) {
      await sleep(LAZY_REVEAL_TAIL_MS);
      hiddenAfterSweep = await countHiddenLarge(page, deadline);
    }
  }
  return {
    performed: true,
    steps,
    truncated,
    truncationReason,
    hiddenBeforeSweep: scan.hidden,
    hiddenAfterSweep,
  };
}

/**
 * Runs the configured readiness checks in order (selector → fonts →
 * required fonts → images → network quiet → settle), each clamped to the
 * remaining deadline. `activity` is the tracker's pre-navigation view of
 * the network, never listeners attached after the fact.
 */
export async function waitForReadiness(
  page: Page,
  options: NormalizedReadinessOptions,
  deadline: Deadline,
  activity: NetworkActivity,
): Promise<ReadinessResult> {
  const startedAt = Date.now();

  if (options.selector !== undefined) {
    if (deadline.expired) throw readinessTimeout("selector", deadline);
    try {
      await page.waitForSelector(options.selector, { state: "visible", timeout: deadline.remainingMs() });
    } catch (cause) {
      if (isTimeoutError(cause)) {
        throw new Dom2PdfError({
          code: "READINESS_TIMEOUT",
          message: `Readiness deadline elapsed waiting for selector "${options.selector}" to become visible`,
          details: { stage: "selector", selector: options.selector, expiresAt: deadline.expiresAt },
          cause,
        });
      }
      throw new Dom2PdfError({
        code: "INVALID_INPUT",
        message: `readiness.selector is not a usable selector: ${cause instanceof Error ? cause.message : String(cause)}`,
        details: { stage: "selector", selector: options.selector },
        cause,
      });
    }
  }

  const lazy = await drainLazyContent(page, options, deadline, activity);

  let fontsAwaited = false;
  if (options.fonts) {
    await withDeadline(
      page.evaluate(() => document.fonts.ready.then(() => true)),
      deadline,
      "fonts",
    );
    fontsAwaited = true;
  }

  let unavailableFonts: string[] = [];
  if (options.waitForFonts.length > 0) {
    unavailableFonts = await withDeadline(
      page.evaluate(async (families: string[]) => {
        const unavailable: string[] = [];
        for (const family of families) {
          const normalized = family.replace(/["']/g, "").toLowerCase();
          try {
            // Triggers loading of matching @font-face declarations;
            // settles including failures.
            await document.fonts.load(`16px "${family}"`, "AaBb0123");
          } catch {
            // Load failure (bad URL, parse error): the font is unavailable.
            unavailable.push(family);
            continue;
          }
          // `fonts.check()` alone is not enough: Chromium answers true for
          // families with no @font-face at all, so only declared faces
          // count.
          const declared: FontFace[] = [];
          document.fonts.forEach((face) => {
            if (face.family.replace(/["']/g, "").toLowerCase() === normalized) declared.push(face);
          });
          if (declared.length > 0 && !declared.some((face) => face.status === "loaded")) {
            unavailable.push(family);
          }
        }
        return unavailable;
      }, options.waitForFonts),
      deadline,
      "required-fonts",
    );
  }

  const images = await resolveImages(page, options, deadline, activity);

  let networkIdleMs = 0;
  let networkUnsettled = false;
  if (options.networkIdleMs > 0) {
    const outcome = await waitForNetworkQuiet(
      activity,
      options.networkIdleMs,
      deadline,
      options.slowResourceMs,
    );
    networkIdleMs = options.networkIdleMs;
    networkUnsettled = outcome === "unsettled";
  }

  let settledMs = 0;
  // The settle beat is enrichment; sleeping past an already-expired
  // deadline would fail a conversion readiness decided to finish with a
  // warning. A genuine run-out is caught by the deadline guard after.
  if (options.settleMs > 0 && !deadline.expired) {
    await withDeadline(sleep(options.settleMs), deadline, "settle");
    settledMs = options.settleMs;
  }

  const stalledUrls =
    options.slowResourceMs > 0 ? activity.stalledUrls(options.slowResourceMs) : [];

  return {
    durationMs: Date.now() - startedAt,
    fontsAwaited,
    images,
    lazy,
    unavailableFonts,
    networkIdleMs,
    networkUnsettled,
    selector: options.selector,
    settledMs,
    stalledUrls,
  };
}

/** Human-readable `readiness` check detail, describing only what actually ran. */
export function describeReadiness(result: ReadinessResult): string {
  const parts: string[] = [];
  if (result.lazy.performed) {
    const revealed = result.lazy.hiddenBeforeSweep - result.lazy.hiddenAfterSweep;
    const revealPart = revealed > 0 ? `, ${revealed} large block(s) became visible` : "";
    const hiddenPart =
      result.lazy.hiddenAfterSweep > 0
        ? `, ${result.lazy.hiddenAfterSweep} large element(s) still hidden`
        : "";
    parts.push(
      result.lazy.truncated
        ? `lazy sweep ${result.lazy.steps} steps (truncated: ${
            result.lazy.truncationReason === "time-budget" ? "time budget" : "step limit"
          })${revealPart}${hiddenPart}`
        : `lazy sweep ${result.lazy.steps} steps${revealPart}${hiddenPart}`,
    );
  }
  if (result.fontsAwaited) parts.push("fonts settled");
  if (result.images.total > 0) {
    parts.push(`images ${result.images.loaded}/${result.images.total}`);
    if (result.images.brokenUrls.length > 0) parts.push(`${result.images.brokenUrls.length} broken`);
    if (result.images.slowUrls.length > 0) parts.push(`${result.images.slowUrls.length} slow`);
  }
  if (result.networkIdleMs > 0) {
    parts.push(
      result.networkUnsettled
        ? `network unsettled (no ${result.networkIdleMs}ms quiet)`
        : `network idle ${result.networkIdleMs}ms`,
    );
  }
  if (result.selector !== undefined) parts.push(`selector "${result.selector}" visible`);
  if (result.settledMs > 0) parts.push(`settled ${result.settledMs}ms`);
  if (result.stalledUrls.length > 0) parts.push(`${result.stalledUrls.length} stalled request(s)`);
  return parts.length > 0
    ? `ready in ${result.durationMs}ms: ${parts.join(", ")}`
    : `ready in ${result.durationMs}ms (no readiness checks requested)`;
}
