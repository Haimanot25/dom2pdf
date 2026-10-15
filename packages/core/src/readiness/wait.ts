import type { Page } from "playwright";
import type { NormalizedReadinessOptions } from "../config/normalize.js";
import { Dom2PdfError } from "../errors/index.js";
import type { NetworkActivity } from "./tracking.js";
import type { Deadline } from "../utils/deadline.js";

/**
 * Readiness phase: after navigation, wait for the things that make a capture
 * trustworthy — lazy content drained, fonts settled, images finished, network
 * quiet, a selector visible — all under the single shared readiness deadline.
 *
 * Waiting is *adaptive*: each pending image gets its own `slowResourceMs`
 * patience (measured from its real request start) and is reported as slow
 * instead of spending the whole shared deadline, so one hanging asset costs a
 * `resources.slow` warning rather than a `READINESS_TIMEOUT`. The lazy sweep
 * walks the document so scroll-driven content — lazy markers, infinite
 * scroll, and reveal-on-scroll animations — is actually present before the
 * capture. The shared deadline still bounds
 * everything; whichever stage gives out is named in the error.
 */

export interface ImageState {
  /** `<img>` elements that declare a non-empty `src`. */
  total: number;
  /** Finished loading with at least one decoded pixel. */
  loaded: number;
  /** Started but not finished at measurement time. */
  pending: number;
  /** Absolute URLs of the pending images (superset of `slowUrls`). */
  pendingUrls: string[];
  /** Absolute URLs of images that finished in a failed/broken state. */
  brokenUrls: string[];
  /**
   * Pending images the readiness phase gave up on after their individual
   * `slowResourceMs` patience — the conversion proceeded without them and
   * reports a `resources.slow` warning.
   */
  slowUrls: string[];
}

export interface LazySweepState {
  /**
   * Whether the sweep ran. It runs for every scrollable document, because
   * scroll drives three different lazy behaviors: `loading="lazy"` markers,
   * fetch-on-scroll content (infinite scroll), and reveal-on-scroll animations
   * (Wix/AOS/wow-style sections that sit at `opacity: 0` until an
   * IntersectionObserver fires — otherwise they print as blank space).
   */
  performed: boolean;
  /** Scroll steps performed. */
  steps: number;
  /** The document kept appending content (infinite scroll) until the step limit. */
  truncated: boolean;
  /**
   * Large elements (at least 100px tall) that were invisible — computed
   * opacity below 0.1 or `visibility: hidden` — when the sweep started.
   */
  hiddenBeforeSweep: number;
  /**
   * The same count after the sweep and its reveal-tail settle. When it is
   * lower than `hiddenBeforeSweep`, scroll made previously hidden blocks
   * visible — the reveal-on-scroll pattern this sweep exists to defeat.
   * A residual count usually means intentional decorative layers; it is
   * reported in the readiness detail so a blank-space mystery is visible
   * without claiming it is always a defect.
   */
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
  /** Selector that became visible, when requested. */
  selector: string | undefined;
  /** Satisfied settle window in ms (`0` = no settle requested). */
  settledMs: number;
  /**
   * In-flight http(s) requests that outlived their individual patience when
   * readiness finished — the hung assets the conversion proceeded without.
   * Reported as warnings; empty when nothing outlasted patience.
   */
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
    // The caller created `promise` before calling (it is the argument), so it
    // may already be in flight — abandon it *safely*. Without this catch, its
    // later rejection (e.g. "Target closed" when the context closes) is
    // unhandled, which kills the Node process.
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

/**
 * Waits until no http(s) request is in flight and nothing has happened on the
 * network for `idleMs`, measured from the tracker that has been watching since
 * before navigation — so requests already in flight when readiness starts
 * count. Requests older than the per-resource patience are presumed hung and
 * do not block (they surface as `resources.slow` instead). Rejects with
 * `READINESS_TIMEOUT` if the shared deadline passes first, which is what
 * happens for pages that poll forever unless the check is disabled.
 */
async function waitForNetworkQuiet(
  activity: NetworkActivity,
  idleMs: number,
  deadline: Deadline,
  patienceMs: number,
): Promise<void> {
  for (;;) {
    if (deadline.expired) throw readinessTimeout("network", deadline);
    if (activity.inFlightRecent(patienceMs > 0 ? patienceMs : undefined) === 0 && Date.now() - activity.lastActivityAt() >= idleMs) {
      return;
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
 * Waits (when requested) for pending images — but each image gets its own
 * patience instead of the whole stage sharing one deadline: an image whose
 * request started (or that was first seen pending) more than `slowResourceMs`
 * ago is moved to `slowUrls` and no longer blocks. The conversion then
 * proceeds with a `resources.slow` warning, which is what makes hanging
 * assets cost a footnote instead of the whole conversion. With patience `0`
 * the old behavior stands: pending images block until the shared deadline.
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

  /** Pending images that are still within their individual patience. */
  const blockingUrls = (): string[] => {
    const now = Date.now();
    const blocking: string[] = [];
    for (const url of state.pendingUrls) {
      if (slow.has(url)) continue;
      if (!firstPendingAt.has(url)) firstPendingAt.set(url, now);
      // Real request start when the request is in flight; the first-observed
      // time otherwise (e.g. a lazy image that never started fetching).
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
// A short dwell after each scroll step. IntersectionObserver callbacks are
// delivered on rendering steps after the scroll (the two requestAnimationFrame
// waits cover that), but many reveal systems drive their triggers from
// throttled scroll handlers (~100-250ms timers). Calibrated against a live
// Wix site: at 80ms the throttled handlers coalesced steps and permanently
// skipped sections (they stayed at opacity 0 in the PDF); at 200ms every
// section revealed. The cost lands only on scrollable pages, one dwell per
// viewport step, and `readiness.lazyLoad: false` opts out entirely.
const LAZY_STEP_DWELL_MS = 200;
// Reveals can land slightly after the sweep ends (a throttled handler fires
// within a beat of the final scroll). One bounded tail wait after restoring
// the scroll position lets those transitions apply the visible class before
// we judge the page and capture it. Only paid when the sweep actually made
// blocks visible — static pages never wait.
const LAZY_REVEAL_TAIL_MS = 500;
// Below this much deadline left, skip the post-sweep hidden-element count —
// it is a diagnostic, never worth failing a page that is otherwise ready.
const LAZY_HIDDEN_PROBE_MIN_MS = 200;

/**
 * Resolves once the network has been quiet for `idleMs`, or `false` when the
 * quiet window did not arrive within `maxWaitMs` (used by the lazy sweep,
 * where a step that brings nothing new must still make progress). Requests
 * older than `patienceMs` count as hung and do not block.
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
 * Counts large elements (at least 100px tall) that are invisible right now
 * — computed opacity below 0.1 or `visibility: hidden`. Page-side code
 * cannot share closures across `evaluate` calls, so this walk repeats the
 * one in `drainLazyContent`'s pre-scan verbatim.
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
 * Lazy-load drain: a bounded scroll sweep that walks the document before the
 * other checks. Scrolling drives three different lazy behaviors, and the
 * sweep handles all of them:
 *
 * 1. `loading="lazy"` images/iframes and `data-src`-style markup fetch when
 *    they approach the viewport.
 * 2. Fetch-on-scroll content (infinite scroll): pages that append when the
 *    bottom is reached. The sweep re-checks the document height at the bottom
 *    after the triggered burst settles and keeps walking into appended
 *    content.
 * 3. Reveal-on-scroll animations (Wix/AOS/wow-style): sections that sit in
 *    the layout at `opacity: 0` until an IntersectionObserver fires. Without
 *    the sweep they print as blank space — a failure mode every headless
 *    print pipeline ships silently today.
 *
 * Guard rails: it only runs for scrollable documents (short pages pay
 * nothing; a long static page pays roughly one walk-step per viewport, a few
 * hundred ms, and `readiness.lazyLoad: false` opts out entirely), each step
 * waits at most `LAZY_STEP_MAX_WAIT_MS` for the triggered burst, the sweep
 * stops after `LAZY_MAX_STEPS` (reporting `truncated` for pages that keep
 * growing), the request cap and the shared readiness deadline still apply,
 * and the scroll position is always restored.
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
    hiddenBeforeSweep: 0,
    hiddenAfterSweep: 0,
  };
  if (!options.lazyLoad) return idle;

  // One evaluate: is this a scrollable document, and how much large content
  // is invisible up front (the reveal-on-scroll baseline)? The count walks
  // every element, so it merges into the scrollable check to stay a single
  // round-trip.
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

  const startY = await page.evaluate(() => window.scrollY);
  let steps = 0;
  let truncated = false;
  try {
    for (;;) {
      if (deadline.expired) throw readinessTimeout("lazy-load", deadline);
      if (steps >= LAZY_MAX_STEPS) {
        truncated = true;
        break;
      }
      const step = await page.evaluate((fraction: number) => {
        const root = document.scrollingElement ?? document.documentElement;
        const heightBefore = root.scrollHeight;
        const remaining = heightBefore - (window.scrollY + window.innerHeight);
        const stepPx = Math.max(24, Math.floor(window.innerHeight * fraction));
        // `behavior: "instant"` defeats pages with `scroll-behavior: smooth`,
        // which would otherwise animate and make each step race the next.
        window.scrollTo({ top: window.scrollY + stepPx, behavior: "instant" });
        return { atBottom: remaining <= 4, heightBefore };
      }, 0.9);
      steps += 1;
      // IntersectionObserver callbacks and lazy-load triggers are delivered on
      // rendering steps after the scroll — without letting two frames pass,
      // a fast sweep can scroll past a section (and restore the position)
      // before the page ever learns it was in view. The dwell additionally
      // gives throttled scroll handlers (many reveal-on-scroll systems)
      // wall-clock time to notice the new position.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      await sleep(LAZY_STEP_DWELL_MS);
      // Let the burst this step triggered (lazy images, fetch-on-scroll
      // appends) settle before deciding what happened.
      await waitForQuietWindow(
        activity,
        LAZY_STEP_IDLE_MS,
        Math.min(LAZY_STEP_MAX_WAIT_MS, Math.max(1, deadline.remainingMs())),
        options.slowResourceMs,
      );
      if (!step.atBottom) continue;
      // At the bottom: fetch-on-scroll pages append *after* the scroll
      // arrives, so re-check the document height once the network has
      // settled. Growth means newly appended content below — keep walking
      // into it. Pages that grow forever hit the step cap and report
      // `truncated`; the shared deadline still bounds every wait.
      const heightAfter = await page.evaluate(
        () => (document.scrollingElement ?? document.documentElement).scrollHeight,
      );
      if (heightAfter > step.heightBefore + 4) continue;
      break;
    }
  } finally {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), startY).catch(
      () => undefined,
    );
  }

  // Diagnostic only: how much large content is still invisible after the
  // sweep? Usually intentional decorative layers, but when a reveal system
  // resisted the sweep this is the number that explains blank PDF space.
  // Skipped when the deadline is nearly spent — never fail a ready page
  // over a hint.
  let hiddenAfterSweep = 0;
  if (deadline.remainingMs() >= LAZY_HIDDEN_PROBE_MIN_MS) {
    hiddenAfterSweep = await countHiddenLarge(page, deadline);
    // A drop below the baseline means the sweep triggered reveals; their
    // handlers may still be settling (throttled scroll callbacks fire
    // within a beat of the last scroll). One bounded tail wait lets those
    // reveals land before the count — and before the capture that follows
    // readiness. Pages where nothing was revealed never wait.
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
    hiddenBeforeSweep: scan.hidden,
    hiddenAfterSweep,
  };
}

/**
 * Runs the configured readiness checks in order (selector → fonts → required
 * fonts → images → network quiet → settle). Each step clamps to the remaining
 * deadline; the returned result feeds the `readiness` quality check and the
 * resource warnings. `activity` is the tracker's pre-navigation view of the
 * network — never listeners attached after the fact.
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
            // Triggers loading of matching @font-face declarations; settles
            // when loading finishes (including failures).
            await document.fonts.load(`16px "${family}"`, "AaBb0123");
          } catch {
            // Load failure (bad URL, parse error): the font is unavailable.
            unavailable.push(family);
            continue;
          }
          // Judge only what the browser actually declares. `fonts.check()`
          // alone is not enough: Chromium answers true for families with no
          // @font-face at all (no fetch needed — system font *or* fallback),
          // so an absent family must not be reported from `check()`.
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
  if (options.networkIdleMs > 0) {
    await waitForNetworkQuiet(activity, options.networkIdleMs, deadline, options.slowResourceMs);
    networkIdleMs = options.networkIdleMs;
  }

  let settledMs = 0;
  if (options.settleMs > 0) {
    await withDeadline(sleep(options.settleMs), deadline, "settle");
    settledMs = options.settleMs;
  }

  // After every wait: which requests are still in flight beyond their
  // patience? These are assets the conversion is proceeding without.
  const stalledUrls =
    options.slowResourceMs > 0 ? activity.stalledUrls(options.slowResourceMs) : [];

  return {
    durationMs: Date.now() - startedAt,
    fontsAwaited,
    images,
    lazy,
    unavailableFonts,
    networkIdleMs,
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
        ? `lazy sweep ${result.lazy.steps} steps (truncated)${revealPart}${hiddenPart}`
        : `lazy sweep ${result.lazy.steps} steps${revealPart}${hiddenPart}`,
    );
  }
  if (result.fontsAwaited) parts.push("fonts settled");
  if (result.images.total > 0) {
    parts.push(`images ${result.images.loaded}/${result.images.total}`);
    if (result.images.brokenUrls.length > 0) parts.push(`${result.images.brokenUrls.length} broken`);
    if (result.images.slowUrls.length > 0) parts.push(`${result.images.slowUrls.length} slow`);
  }
  if (result.networkIdleMs > 0) parts.push(`network idle ${result.networkIdleMs}ms`);
  if (result.selector !== undefined) parts.push(`selector "${result.selector}" visible`);
  if (result.settledMs > 0) parts.push(`settled ${result.settledMs}ms`);
  if (result.stalledUrls.length > 0) parts.push(`${result.stalledUrls.length} stalled request(s)`);
  return parts.length > 0
    ? `ready in ${result.durationMs}ms: ${parts.join(", ")}`
    : `ready in ${result.durationMs}ms (no readiness checks requested)`;
}
