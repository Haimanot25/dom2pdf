import { PageForgeError, type ErrorCode } from "../errors/index.js";

/**
 * A single point in time after which an operation must fail.
 *
 * PageForge budgets time with deadlines instead of giving every stage its own
 * unlimited timeout: callers create one deadline per phase (readiness, render)
 * and clamp each stage to the remaining time.
 */
export class Deadline {
  /** Unix timestamp (ms) at which this deadline expires. */
  readonly expiresAt: number;

  private constructor(expiresAt: number) {
    this.expiresAt = expiresAt;
  }

  /** Deadline occurring `ms` milliseconds from now. */
  static in(ms: number): Deadline {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new PageForgeError({
        code: "INVALID_INPUT",
        message: `Deadline duration must be a non-negative finite number, received: ${String(ms)}`,
      });
    }
    return new Deadline(Date.now() + ms);
  }

  /** Deadline at an absolute unix timestamp (ms). */
  static at(expiresAt: number): Deadline {
    if (!Number.isFinite(expiresAt)) {
      throw new PageForgeError({
        code: "INVALID_INPUT",
        message: `Deadline timestamp must be finite, received: ${String(expiresAt)}`,
      });
    }
    return new Deadline(expiresAt);
  }

  /** Milliseconds left before expiry (never negative). */
  remainingMs(): number {
    return Math.max(0, this.expiresAt - Date.now());
  }

  /** True once the deadline has passed. */
  get expired(): boolean {
    return this.remainingMs() <= 0;
  }

  /** Caps a requested timeout to the time actually remaining. */
  clamp(ms: number): number {
    return Math.min(ms, this.remainingMs());
  }

  /** Throws a typed error with `code` if the deadline has already passed. */
  throwIfExpired(code: ErrorCode, message: string): void {
    if (this.expired) {
      throw new PageForgeError({ code, message, details: { expiresAt: this.expiresAt } });
    }
  }
}
