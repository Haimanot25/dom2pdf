import type { Page } from "playwright";
import type { NormalizedReadinessOptions } from "../config/normalize.js";
import { PageForgeError } from "../errors/index.js";
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
 * triggers scroll-loaded content up front. The shared deadline still bounds
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
  /** Whether the sweep ran (scrollable document with lazy markers). */
  performed: boolean;
  /** Scroll steps performed. */
  steps: number;
  /** The document kept growing (infinite scroll) until the step limit. */
  truncated: boolean;
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

function readinessTimeout(stage: string, deadline: Deadline): PageForgeError {
  return new PageForgeError({
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
 * Lazy-load drain: a bounded scroll sweep that walks the document before the
 * other checks so `loading="lazy"` images/iframes and `data-src`-style markup
 * actually fetch. Without it, long pages print with blank images below the
 * fold — a failure mode every print-to-PDF engine ships silently today.
 *
 * Guard rails: it only runs for scrollable documents that declare lazy
 * markers (static pages pay nothing), each step waits at most
 * `LAZY_STEP_MAX_WAIT_MS` for the triggered burst, the sweep stops after
 * `LAZY_MAX_STEPS` (reporting `truncated` for infinite-scroll pages), the
 * request cap and the shared readiness deadline still apply, and the scroll
 * position is always restored.
 */
async function drainLazyContent(
  page: Page,
  options: NormalizedReadinessOptions,
  deadline: Deadline,
  activity: NetworkActivity,
): Promise<LazySweepState> {
  if (!options.lazyLoad) return { performed: false, steps: 0, truncated: false };

  const markers = await withDeadline(
    page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return {
        scrollable: root.scrollHeight > window.innerHeight * 1.25,
        lazyMarkers: document.querySelectorAll(
          'img[loading="lazy"],iframe[loading="lazy"],[data-src],[data-srcset]',
        ).length,
      };
    }),
    deadline,
    "lazy-load",
  );
  if (!markers.scrollable || markers.lazyMarkers === 0) {
    return { performed: false, steps: 0, truncated: false };
  }

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
      const atBottom = await page.evaluate((fraction: number) => {
        const root = document.scrollingElement ?? document.documentElement;
        const remaining = root.scrollHeight - (window.scrollY + window.innerHeight);
        const stepPx = Math.max(24, Math.floor(window.innerHeight * fraction));
        // `behavior: "instant"` defeats pages with `scroll-behavior: smooth`,
        // which would otherwise animate and make each step race the next.
        window.scrollTo({ top: window.scrollY + stepPx, behavior: "instant" });
        return remaining <= 4;
      }, 0.9);
      steps += 1;
      // IntersectionObserver callbacks and lazy-load triggers are delivered on
      // rendering steps after the scroll — without letting two frames pass,
      // a fast sweep can scroll past a section (and restore the position)
      // before the page ever learns it was in view.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      if (atBottom) break;
      await waitForQuietWindow(
        activity,
        LAZY_STEP_IDLE_MS,
        Math.min(LAZY_STEP_MAX_WAIT_MS, Math.max(1, deadline.remainingMs())),
        options.slowResourceMs,
      );
    }
  } finally {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: "instant" }), startY).catch(
      () => undefined,
    );
  }
  return { performed: true, steps, truncated };
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
        throw new PageForgeError({
          code: "READINESS_TIMEOUT",
          message: `Readiness deadline elapsed waiting for selector "${options.selector}" to become visible`,
          details: { stage: "selector", selector: options.selector, expiresAt: deadline.expiresAt },
          cause,
        });
      }
      throw new PageForgeError({
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
    parts.push(
      result.lazy.truncated
        ? `lazy sweep ${result.lazy.steps} steps (truncated)`
        : `lazy sweep ${result.lazy.steps} steps`,
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
