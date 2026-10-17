/**
 * Races `promise` against a timeout; used where the underlying API has no
 * timeout of its own (e.g. `page.pdf()`). The losing promise stays handled
 * by `Promise.race`, so a late rejection is not unhandled.
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
