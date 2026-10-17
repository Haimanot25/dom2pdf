import { Dom2PdfError, type ErrorCode } from "../errors/index.js";

/**
 * Point in time after which an operation must fail. Callers create one
 * deadline per phase (readiness, render) and clamp each stage to it.
 */
export class Deadline {
  /** Unix timestamp (ms) at which this deadline expires. */
  readonly expiresAt: number;

  private constructor(expiresAt: number) {
    this.expiresAt = expiresAt;
  }

  static in(ms: number): Deadline {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Dom2PdfError({
        code: "INVALID_INPUT",
        message: `Deadline duration must be a non-negative finite number, received: ${String(ms)}`,
      });
    }
    return new Deadline(Date.now() + ms);
  }

  /** Deadline at an absolute unix timestamp (ms). */
  static at(expiresAt: number): Deadline {
    if (!Number.isFinite(expiresAt)) {
      throw new Dom2PdfError({
        code: "INVALID_INPUT",
        message: `Deadline timestamp must be finite, received: ${String(expiresAt)}`,
      });
    }
    return new Deadline(expiresAt);
  }

  /** Milliseconds left before expiry; clamped at 0. */
  remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  get expired(): boolean {
    return this.remainingMs() <= 0;
  }

  clamp(ms: number): number {
    return Math.min(ms, this.remainingMs());
  }

  throwIfExpired(code: ErrorCode, message: string): void {
    if (this.expired) {
      throw new Dom2PdfError({ code, message, details: { expiresAt: this.expiresAt } });
    }
  }
}
