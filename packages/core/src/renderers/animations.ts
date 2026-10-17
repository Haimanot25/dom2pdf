import type { Page } from "playwright";

/**
 * Seeks every animation and transition to its end state, then pauses it.
 * `page.pdf()` exposes no CDP `animations: "disabled"` switch; infinite
 * animations have no end time and are only paused.
 */
export async function finishAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getAnimations().forEach((animation) => {
      const endTime = animation.effect?.getComputedTiming?.()?.endTime;
      // { percentage } TimeValues map to NaN via `Number()`; those animations are only paused, never sought.
      if (endTime !== undefined && Number.isFinite(Number(endTime))) {
        animation.currentTime = endTime;
      }
      animation.pause();
    });
  });
}
