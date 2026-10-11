import type { Page } from "playwright";
import type { NormalizedReadinessOptions } from "../config/normalize.js";
import { PageForgeError } from "../errors/index.js";
import type { NetworkActivity } from "./tracking.js";
import type { Deadline } from "../utils/deadline.js";

/**
 * Readiness phase: after navigation, wait for the things that make a capture
 * trustworthy — fonts settled, images finished, network quiet, a selector
 * visible — all under the single shared readiness deadline.
 *
 * Every wait is bounded by the same deadline; whichever stage gives out is
 * named in the `READINESS_TIMEOUT` error so callers know what never settled.
 * A never-appearing selector or a permanently chatty network therefore fails
 * fast instead of hanging.
 */

export interface ImageState {
  /** `<img>` elements that declare a non-empty `src`. */
  total: number;
  /** Finished loading with at least one decoded pixel. */
  loaded: number;
  /** Started but not finished at measurement time. */
  pending: number;
  /** Absolute URLs of images that finished in a failed/broken state. */
  brokenUrls: string[];
}

export interface ReadinessResult {
  /** Wall-clock milliseconds spent in the readiness phase. */
  durationMs: number;
  /** Whether `document.fonts.ready` was awaited. */
  fontsAwaited: boolean;
  images: ImageState;
  /** Families from `waitForFonts` the browser reports as unavailable. */
  unavailableFonts: string[];
  /** Satisfied network-idle window in ms (`0` = check disabled). */
  networkIdleMs: number;
  /** Selector that became visible, when requested. */
  selector: string | undefined;
  /** Satisfied settle window in ms (`0` = no settle requested). */
  settledMs: number;
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
  if (deadline.expired) throw readinessTimeout(stage, deadline);
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
 * count. Rejects with `READINESS_TIMEOUT` if the shared deadline passes first,
 * which is what happens for pages that poll forever unless the check is
 * disabled.
 */
async function waitForNetworkQuiet(
  activity: NetworkActivity,
  idleMs: number,
  deadline: Deadline,
): Promise<void> {
  for (;;) {
    if (deadline.expired) throw readinessTimeout("network", deadline);
    if (activity.inFlight() === 0 && Date.now() - activity.lastActivityAt() >= idleMs) return;
    await sleep(Math.min(25, Math.max(1, deadline.remainingMs())));
  }
}

async function collectImages(page: Page): Promise<ImageState> {
  return page.evaluate((): ImageState => {
    const images = Array.from(document.images).filter(
      (img) => (img.getAttribute("src") ?? "").trim().length > 0,
    );
    let loaded = 0;
    let pending = 0;
    const brokenUrls: string[] = [];
    for (const img of images) {
      if (!img.complete) {
        pending += 1;
        continue;
      }
      if (img.naturalWidth > 0) {
        loaded += 1;
      } else {
        brokenUrls.push(img.currentSrc || img.src);
      }
    }
    return { total: images.length, loaded, pending, brokenUrls };
  });
}

/** Waits (when requested) and always measures image state at the end of the phase. */
async function resolveImages(
  page: Page,
  waitForAll: boolean,
  deadline: Deadline,
): Promise<ImageState> {
  let state = await withDeadline(collectImages(page), deadline, "images");
  while (waitForAll && state.pending > 0) {
    if (deadline.expired) throw readinessTimeout("images", deadline);
    await sleep(Math.min(50, Math.max(1, deadline.remainingMs())));
    state = await withDeadline(collectImages(page), deadline, "images");
  }
  return state;
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

  const images = await resolveImages(page, options.images, deadline);

  let networkIdleMs = 0;
  if (options.networkIdleMs > 0) {
    await waitForNetworkQuiet(activity, options.networkIdleMs, deadline);
    networkIdleMs = options.networkIdleMs;
  }

  let settledMs = 0;
  if (options.settleMs > 0) {
    await withDeadline(sleep(options.settleMs), deadline, "settle");
    settledMs = options.settleMs;
  }

  return {
    durationMs: Date.now() - startedAt,
    fontsAwaited,
    images,
    unavailableFonts,
    networkIdleMs,
    selector: options.selector,
    settledMs,
  };
}

/** Human-readable `readiness` check detail, describing only what actually ran. */
export function describeReadiness(result: ReadinessResult): string {
  const parts: string[] = [];
  if (result.fontsAwaited) parts.push("fonts settled");
  if (result.images.total > 0) {
    parts.push(`images ${result.images.loaded}/${result.images.total}`);
    if (result.images.brokenUrls.length > 0) parts.push(`${result.images.brokenUrls.length} broken`);
  }
  if (result.networkIdleMs > 0) parts.push(`network idle ${result.networkIdleMs}ms`);
  if (result.selector !== undefined) parts.push(`selector "${result.selector}" visible`);
  if (result.settledMs > 0) parts.push(`settled ${result.settledMs}ms`);
  return parts.length > 0
    ? `ready in ${result.durationMs}ms: ${parts.join(", ")}`
    : `ready in ${result.durationMs}ms (no readiness checks requested)`;
}
