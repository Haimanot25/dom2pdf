import { PageForgeError } from "../errors/index.js";

/** Typed error for cooperative cancellation via `AbortSignal`. */
export function cancelledError(message = "Conversion was cancelled"): PageForgeError {
  return new PageForgeError({ code: "CANCELLED", message });
}

/** Throws `CANCELLED` immediately if the signal is already aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledError();
}

/**
 * Races `promise` against the signal. On abort, rejects with `CANCELLED`
 * immediately (the underlying operation is unwound by context cleanup) and
 * always removes the abort listener.
 */
export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  message?: string,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    // Keep a handler attached so a later rejection is never "unhandled".
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
