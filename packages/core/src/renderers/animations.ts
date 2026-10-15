import type { Page } from "playwright";

/**
 * Fast-forwards every running CSS/Web-Animations animation and transition to
 * its end state, then pauses it — so print-to-PDF captures the settled page
 * instead of a mid-flight frame.
 *
 * This exists because Chromium's printToPDF runs animations live and
 * Playwright's `page.pdf()` does not expose the CDP `animations: "disabled"`
 * switch (verified against playwright@1.64.0). Entrance animations that slide
 * content in from off-page (Wix/AOS-style reveal+slide) otherwise print with
 * their text clipped at the page edge: the transition was captured partway,
 * so half the line sits outside the paper box and never makes it into the
 * PDF. A printout should show the page as it settles, not an animation
 * frame — every print engine since Prince has taken that position.
 *
 * Infinite animations (spinners, marquees) have no end to seek to; they are
 * paused in place, which prints as a still frame.
 */
export async function finishAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.getAnimations().forEach((animation) => {
      const endTime = animation.effect?.getComputedTiming?.()?.endTime;
      // `Number()` guards the { percentage } TimeValue form too: it yields
      // NaN there, and such animations are only paused, not sought.
      if (endTime !== undefined && Number.isFinite(Number(endTime))) {
        animation.currentTime = endTime;
      }
      animation.pause();
    });
  });
}
