import { Dom2PdfError } from "../errors/index.js";

/** Typed error for cooperative cancellation via `AbortSignal`. */
export function cancelledError(message = "Conversion was cancelled"): Dom2PdfError {
  return new Dom2PdfError({ code: "CANCELLED", message });
}

/** Throws `CANCELLED` if the signal is already aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError();
}

/**
 * Races `promise` against the signal and rejects with `CANCELLED` on abort
 * (the underlying operation is unwound by context cleanup). The abort
 * listener is always removed.
 */
export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message?: string,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    // Attach a no-op handler so a later rejection is not unhandled.
    promise.catch(() => undefined);
    throw cancelledError(message);
  }

  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(cancelledError(message));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}
