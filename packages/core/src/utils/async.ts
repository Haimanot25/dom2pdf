/**
 * Races a promise against a timeout.
 *
 * Used where the underlying API offers no timeout of its own (e.g. Playwright's
 * `page.pdf()`). The losing promise stays handled by `Promise.race`, so a late
 * rejection never surfaces as an unhandled rejection.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  createTimeoutError: () => Error,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(createTimeoutError()), Math.max(0, ms));
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
