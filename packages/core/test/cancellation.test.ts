import { describe, expect, it, vi } from "vitest";
import { PageForgeError } from "../src/errors/index.js";
import { cancelledError, raceWithAbort, throwIfAborted } from "../src/utils/cancellation.js";

const delay = (ms: number): Promise<string> =>
  new Promise((resolve) => setTimeout(() => resolve("done"), ms));

describe("cancelledError / throwIfAborted", () => {
  it("creates a CANCELLED PageForgeError", () => {
    const error = cancelledError();
    expect(error).toBeInstanceOf(PageForgeError);
    expect(error.code).toBe("CANCELLED");
    expect(cancelledError("custom").message).toBe("custom");
  });

  it("throws only when the signal is aborted", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();

    const controller = new AbortController();
    controller.abort();
    try {
      throwIfAborted(controller.signal);
      throw new Error("expected throwIfAborted to throw");
    } catch (error) {
      expect((error as PageForgeError).code).toBe("CANCELLED");
    }
  });
});

describe("raceWithAbort", () => {
  it("passes the promise through when no signal is given", async () => {
    await expect(raceWithAbort(Promise.resolve("value"), undefined)).resolves.toBe("value");
    await expect(raceWithAbort(Promise.reject(new Error("inner")), undefined)).rejects.toThrow("inner");
  });

  it("resolves normally when the signal is never aborted", async () => {
    await expect(raceWithAbort(delay(5), new AbortController().signal)).resolves.toBe("done");
  });

  it("rejects immediately for an already-aborted signal and consumes the promise", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = Promise.reject(new Error("later"));
    await expect(raceWithAbort(promise, controller.signal)).rejects.toMatchObject({ code: "CANCELLED" });
    // Give the rejected promise a microtask; the attached catch prevents
    // an unhandled-rejection crash.
    await Promise.resolve();
  });

  it("rejects with CANCELLED when aborted mid-flight", async () => {
    const controller = new AbortController();
    const pending = raceWithAbort(delay(5_000), controller.signal, "stopped early");
    setTimeout(() => controller.abort(), 10);

    try {
      await pending;
      throw new Error("expected raceWithAbort to reject");
    } catch (error) {
      expect((error as PageForgeError).code).toBe("CANCELLED");
      expect((error as PageForgeError).message).toBe("stopped early");
    }
  });

  it("removes its abort listener after settling", async () => {
    const controller = new AbortController();
    const addSpy = vi.spyOn(controller.signal, "addEventListener");
    const removeSpy = vi.spyOn(controller.signal, "removeEventListener");

    await raceWithAbort(Promise.resolve("x"), controller.signal);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    // Also removed on the abort path.
    const controller2 = new AbortController();
    const addSpy2 = vi.spyOn(controller2.signal, "addEventListener");
    const removeSpy2 = vi.spyOn(controller2.signal, "removeEventListener");
    const pending = raceWithAbort(delay(5_000), controller2.signal);
    controller2.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(addSpy2).toHaveBeenCalledTimes(1);
    expect(removeSpy2).toHaveBeenCalledTimes(1);

    addSpy.mockRestore();
    removeSpy.mockRestore();
    addSpy2.mockRestore();
    removeSpy2.mockRestore();
  });

  it("does not turn the losing promise into an unhandled rejection", async () => {
    const controller = new AbortController();
    // Rejects only *after* the abort wins the race.
    const losing = delay(30).then(() => {
      throw new Error("rejected after abort");
    });
    const pending = raceWithAbort(losing, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Reaching this line without vitest failing on an unhandled rejection is
    // the assertion.
    expect(true).toBe(true);
  });
});
